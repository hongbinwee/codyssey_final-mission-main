import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations} from "../../src/brain/persistent-store.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";
import {brainErasureFootprint} from "../../src/brain/erasure-audit.ts";
import {auditCheckpointRetention} from "../../src/brain/checkpoint-retention-audit.ts";

test("M15 all superseded generations remain auditable, cleanup remains read-only",async()=>{
 const url=process.env.BRAIN_DATABASE_URL;
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const db=postgres(url,{max:3});
 try{
  const store=brainDatabaseFromPostgres(db);
  const conversation=new PersistentConversations(store);
  const actor="m15-retention-"+crypto.randomUUID();
  const thread=await conversation.create(actor);
  const fenced=new FencedTurns(store);
  const request={actorUserId:actor,conversationId:thread.id,clientActionId:"same",
   userMessage:"모니터"};
  const first=await fenced.claim(request);
  assert.equal(first.kind,"run");
  const second=await fenced.claim(request);
  assert.equal(second.kind,"run");
  assert.notEqual(first.attemptId,second.attemptId);
  await db.unsafe(
    "UPDATE shopping_brain.turn_attempts SET created_at=now()-interval '40 days' WHERE attempt_id=$1",
    [first.attemptId]);
  const before=await auditCheckpointRetention(store,actor,30);
  assert.deepEqual({
    all:before.allAttempts,pending:before.pendingAttempts,
    superseded:before.supersededPending,eligible:before.retentionReviewCandidates
  },{all:2,pending:2,superseded:1,eligible:1});
  assert.equal(before.deletionApproved,false);
  assert.equal(before.legacyPreIndexThreadsFullyReconciled,false);
  const all=await brainErasureFootprint(store,actor);
  assert.equal(all.attempts,2,"superseded attempt must not disappear from privacy footprint");
  const after=await auditCheckpointRetention(store,actor,30);
  assert.deepEqual(after,before,"audit makes no data mutations");
  const [rows]=await db.unsafe(
    "SELECT count(*)::int AS n FROM shopping_brain.turn_attempts WHERE conversation_id=$1",
    [thread.id]);
  assert.equal(rows.n,2);
  await assert.rejects(()=>auditCheckpointRetention(store,actor,0),/invalid checkpoint retention age/);
  assert.equal((await auditCheckpointRetention(store,"another-actor",30)).allAttempts,0);
 }finally{await db.end();}
});
