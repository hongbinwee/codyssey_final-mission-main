import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {randomUUID} from "node:crypto";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";

const url=process.env.BRAIN_DATABASE_URL;
test("Postgres Graph failure cannot replay stale prior turn or double-apply failed plan", {timeout:35000},async()=>{
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const db=postgres(url,{max:4,connect_timeout:5});
 let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try {
  const storage=brainDatabaseFromPostgres(db);
  const conversations=new PersistentConversations(storage);
  const memory=new PersistentPreferences(storage);
  const thread=await conversations.create("owner-recovery");
  let fault=false,searches=0;
  const deps={
    conversations,memory,
    intent:{extract:async(userMessage,_prefs,previous)=>{
      if(userMessage==="first")return {query:"monitor",context:{maxTotalWon:500000,requiredConditions:["FHD"],currentPreferences:{}},
        queryMode:"SET",budgetMode:"SET",requirementsMode:"REPLACE"};
      assert.equal(previous?.query,"monitor");
      if(userMessage==="change budget")return {query:"monitor",context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}},
        queryMode:"KEEP",budgetMode:"SET",requirementsMode:"KEEP"};
      return {query:"monitor",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}},
        queryMode:"KEEP",budgetMode:"KEEP",requirementsMode:"KEEP"};
    }},
    retriever:{search:async()=>{searches++;if(fault)throw Error("mock upstream 503");return {candidates:[],evidence:[]};}}
  };
  await saver.setup();
  let graph=createPersistentResearchGraph(deps,saver);
  const call=(clientActionId,userMessage)=>graph.invoke({actorUserId:"owner-recovery",conversationId:thread.id,
    requestId:randomUUID(),clientActionId,userMessage});
  const first=await call("first-id","first");
  assert.equal(first.shoppingPlan.revision,1);
  assert.equal(first.shoppingPlan.maxTotalWon,500000);
  fault=true;
  await assert.rejects(()=>call("second-id","change budget"),/mock upstream 503/);
  const afterFail=await graph.getOwnedState("owner-recovery",thread.id);
  assert.equal(afterFail.values.request.clientActionId,"second-id");
  assert.equal(afterFail.values.researchResult.clientActionId,"first-id","older success may remain in checkpoint but is NOT the new turn");
  const callsBeforeRetry=searches;
  fault=false;
  const retried=await call("second-id","change budget");
  assert.equal(retried.clientActionId,"second-id");
  assert.notEqual(retried.messageId,first.messageId,"must not return stale previous response");
  assert.equal(retried.shoppingPlan.revision,2,"failed plan must not double apply");
  assert.equal(retried.shoppingPlan.maxTotalWon,300000);
  assert.deepEqual(retried.shoppingPlan.requiredConditions,["FHD"]);
  assert.ok(searches>callsBeforeRetry);
  const once=searches;
  const duplicate=await call("second-id","change budget");
  assert.equal(duplicate.messageId,retried.messageId);
  assert.equal(searches,once,"successfully completed action deduplicates");
  await assert.rejects(()=>call("second-id","different message"),/duplicate action conflict/);
  await saver.end();
  saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  await saver.setup();
  graph=createPersistentResearchGraph(deps,saver);
  const afterRestart=await graph.getOwnedState("owner-recovery",thread.id);
  assert.equal(afterRestart.values.researchResult.clientActionId,"second-id");
  const third=await call("third-id","followup");
  assert.equal(third.shoppingPlan.revision,3);
  assert.equal(third.shoppingPlan.maxTotalWon,300000);
  await assert.rejects(()=>graph.getOwnedState("other-person",thread.id),/not owned/);
 }finally{
  await Promise.allSettled([saver.end(),db.end()]);
 }
});
