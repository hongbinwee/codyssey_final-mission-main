import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";

test("v9 completed DB publication with lost response is a durable no-RAG replay",async()=>{
  const url=process.env.BRAIN_DATABASE_URL;
  if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
  const db=postgres(url,{max:4}),locks=postgres(url,{max:2});
  const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conv=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const fenced=new FencedTurns(store);
    const thread=await conv.create("publication-ack-owner");
    let calls=0,ackLost=false;
    const injected={
      claim:action=>fenced.claim(action),
      latest:id=>fenced.latest(id),
      publish:async (...args)=>{
        await fenced.publish(...args);
        if(!ackLost){ackLost=true;throw Error("CI network lost final publish acknowledgment");}
      }
    };
    const deps={
      conversations:conv,memory,
      intent:{extract:async()=>({query:"monitor",
        context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
      retriever:{search:async()=>{calls++;return {candidates:[],evidence:[]};}}
    };
    const request={actorUserId:"publication-ack-owner",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:"publish-action",userMessage:"monitor"};
    const first=createPersistentResearchGraph(deps,saver,postgresTurnLock(locks,db),injected);
    await assert.rejects(()=>first.invoke(request),/CI network lost final publish acknowledgment/);
    assert.equal(ackLost,true);
    const published=await fenced.latest(thread.id);
    assert.equal(published.result.clientActionId,"publish-action");
    const fresh=createPersistentResearchGraph(deps,saver,postgresTurnLock(locks,db),fenced);
    const replay=await fresh.invoke({...request,requestId:crypto.randomUUID()});
    assert.equal(replay.messageId,published.result.messageId);
    assert.equal(replay.shoppingPlan.revision,1);
    assert.equal(calls,1,"retry must never repeat RAG after a committed receipt");
    const [{n}]=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1 AND client_action_id='publish-action'",[thread.id]);
    assert.equal(n,1);
  }finally{await Promise.allSettled([saver.end(),locks.end(),db.end()]);}
});
