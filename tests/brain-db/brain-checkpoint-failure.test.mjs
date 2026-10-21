import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {createBrainApi} from "../../src/brain/api.ts";

const url=process.env.BRAIN_DATABASE_URL;
test("committed checkpoint write with lost acknowledgment recovers without duplicate source or plan revision",async()=>{
  if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
  const db=postgres(url,{max:3}),lockDb=postgres(url,{max:3});
  let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const repo=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(repo);
    const memory=new PersistentPreferences(repo);
    const thread=await conversations.create("checkpoint-ack-loss");
    let retrievals=0;
    const deps={
      conversations,memory,
      intent:{extract:async()=>({query:"monitor",
        context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
      retriever:{search:async()=>{retrievals++;return {candidates:[],evidence:[]};}}
    };
    let writes=0,failed=false;
    const injected=new Proxy(saver,{get(target,prop){
      if(prop==="put")return async (...args)=>{
        const committed=await target.put(...args);
        writes++;
        if(!failed&&writes===2){failed=true;throw Error("CI injected checkpoint ack lost");}
        return committed;
      };
      const value=Reflect.get(target,prop,target);
      return typeof value==="function"?value.bind(target):value;
    }});
    const graph=createPersistentResearchGraph(deps,injected,postgresTurnLock(lockDb,db));
    const request={actorUserId:"checkpoint-ack-loss",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:"partial-ack",userMessage:"모니터 50만원 이하"};
    const first=createBrainApi({conversations,preferences:memory,graph});
    const rejected=await first("POST",`/api/brain/conversations/${thread.id}/turn`,
      "checkpoint-ack-loss",{user_message:request.userMessage,client_action_id:request.clientActionId});
    assert.equal(rejected.status,503,"a lost acknowledgment must not be shown as a successful turn");
    assert.equal(failed,true,"test MUST actually inject an acknowledgment failure");
    assert.ok(writes>=2);
    await saver.end();
    saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
    await saver.setup();
    const restarted=createPersistentResearchGraph(deps,saver,postgresTurnLock(lockDb,db));
    const result=await restarted.invoke({...request,requestId:crypto.randomUUID()});
    assert.equal(result.shoppingPlan.revision,1,"one logical turn after a partial checkpoint");
    assert.ok(result.explanation);
    const source=await db.unsafe(`SELECT count(*)::int AS n FROM shopping_brain.messages
      WHERE conversation_id=$1 AND client_action_id='partial-ack'`,[thread.id]);
    assert.equal(source[0].n,1);
    assert.ok(retrievals<=2,"recovery may repeat read-only retrieval but not duplicate source message");
    const again=await restarted.invoke({...request,requestId:crypto.randomUUID()});
    assert.equal(again.messageId,result.messageId);
    assert.equal(again.shoppingPlan.revision,1);
  }finally{await Promise.allSettled([saver.end(),lockDb.end(),db.end()]);}
});
