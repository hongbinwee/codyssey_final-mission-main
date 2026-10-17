import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";
import {auditLegacyBrainConversations} from "../../src/brain/legacy-migration-audit.ts";
const url=process.env.BRAIN_DATABASE_URL;

test("M14 read-only legacy migration audit separates v8, v9, pending and empty conversations",async()=>{
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const db=postgres(url,{max:4}),lockDb=postgres(url,{max:3});
 const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try{
  await saver.setup();
  const store=brainDatabaseFromPostgres(db);
  const conv=new PersistentConversations(store);
  const memory=new PersistentPreferences(store);
  const actor="legacy-audit-"+crypto.randomUUID();
  const other="legacy-audit-"+crypto.randomUUID();
  const legacy=await conv.create(actor);
  const modern=await conv.create(actor);
  await conv.create(actor); // empty
  await conv.create(other); // tenant-isolation negative
  const deps={conversations:conv,memory,
   intent:{extract:async()=>({query:"monitor",context:{
    maxTotalWon:500000,requiredConditions:[],currentPreferences:{}
   }})},retriever:{search:async()=>({candidates:[],evidence:[]})}
  };
  const request=(id,action)=>({actorUserId:actor,conversationId:id,
   requestId:crypto.randomUUID(),clientActionId:action,userMessage:"monitor"});
  const oldGraph=createPersistentResearchGraph(deps,saver);
  await oldGraph.invoke(request(legacy.id,"old"));
  const fenced=new FencedTurns(store);
  const currentGraph=createPersistentResearchGraph(deps,saver,postgresTurnLock(lockDb,db),fenced);
  await currentGraph.invoke(request(modern.id,"new"));
  const pending=await conv.create(actor);
  await fenced.claim(request(pending.id,"incomplete"));
  const countBefore=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.checkpoints");
  const audit=await auditLegacyBrainConversations(store,actor);
  assert.deepEqual(audit,{
   total:4,legacy:1,v9Canonical:1,pendingOnly:1,inconsistent:0,empty:1,
   safeToAutoMigrate:false
  });
  const foreign=await auditLegacyBrainConversations(store,other);
  assert.equal(foreign.total,1);
  assert.equal(foreign.legacy,0);
  const countAfter=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.checkpoints");
  assert.equal(countAfter[0].n,countBefore[0].n);
  assert.equal((await oldGraph.getOwnedState(actor,legacy.id)).values.researchResult.clientActionId,"old");
  await assert.rejects(()=>auditLegacyBrainConversations(store,""),/invalid authenticated actor/);
 }finally{await Promise.allSettled([saver.end(),lockDb.end(),db.end()]);}
});
