import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";
import {brainErasureFootprint} from "../../src/brain/erasure-audit.ts";

test("read-only v9 deletion footprint includes checkpoint blobs/writes and orphan attempts",async()=>{
  const url=process.env.BRAIN_DATABASE_URL;
  if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
  const db=postgres(url,{max:4}),locks=postgres(url,{max:2});
  const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conv=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const actor="privacy-v9-"+crypto.randomUUID();
    const foreign="privacy-v9-"+crypto.randomUUID();
    const thread=await conv.create(actor);
    await conv.create(foreign);
    const source=await conv.appendUserMessage(actor,thread.id,"memory-source","value priority");
    const proposal=await conv.proposePreference({actorUserId:actor,conversationId:thread.id,
      sourceMessageId:source,key:"price_priority",value:"value"});
    await conv.confirmPreference(actor,proposal);
    const graph=createPersistentResearchGraph({
      conversations:conv,memory,
      intent:{extract:async()=>({query:"monitor",context:{
        maxTotalWon:500000,requiredConditions:[],currentPreferences:{}
      }})},
      retriever:{search:async()=>({candidates:[],evidence:[]})}
    },saver,postgresTurnLock(locks,db),new FencedTurns(store));
    await graph.invoke({actorUserId:actor,conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:"privacy-turn",userMessage:"monitor"});
    const before=await brainErasureFootprint(store,actor);
    assert.equal(before.conversations,1);
    assert.ok(before.messages>=2);
    assert.equal(before.preferences,1);
    assert.equal(before.fences,1);
    assert.equal(before.receipts,1);
    assert.ok(before.checkpoints>0);
    assert.ok(before.checkpoint_blobs>0);
    assert.ok(before.checkpoint_writes>=0);
    assert.equal((await brainErasureFootprint(store,foreign)).messages,0);
    assert.equal(await memory.delete(actor,"price_priority"),true);
    const after=await brainErasureFootprint(store,actor);
    assert.equal(after.preferences,0);
    assert.equal(after.messages,before.messages);
    assert.equal(after.checkpoints,before.checkpoints);
    assert.equal(after.checkpoint_blobs,before.checkpoint_blobs);
    assert.equal(after.receipts,before.receipts);
    assert.equal(after.fences,before.fences);
    // There is intentionally no destructive erasure action.
  }finally{await Promise.allSettled([saver.end(),locks.end(),db.end()]);}
});
