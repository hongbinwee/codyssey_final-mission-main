import test from "node:test";
import assert from "node:assert/strict";
import {fork} from "node:child_process";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";

function deadline(p,label,ms=15000){
  let timer;
  return Promise.race([p,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error(label+" timeout")),ms);
  })]).finally(()=>clearTimeout(timer));
}
const url=process.env.BRAIN_DATABASE_URL;
test("SIGKILL of a real Node worker during RAG leaves recoverable partial checkpoint",async()=>{
  if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
  const db=postgres(url,{max:3,connect_timeout:5}),lockDb=postgres(url,{max:2,connect_timeout:5});
  const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  let child;
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const thread=await conversations.create("worker-kill-owner");
    child=fork(new URL("./fixtures/held-brain-worker.mjs",import.meta.url),[],{
      execArgv:["--experimental-strip-types"],
      env:{...process.env,BRAIN_QA_THREAD:thread.id},
      stdio:["ignore","pipe","pipe","ipc"]
    });
    let logs="";
    child.stderr.on("data",b=>{logs+=String(b).slice(0,1200);});
    await deadline(new Promise((resolve,reject)=>{
      child.on("message",m=>{if(m?.kind==="in-retrieve")resolve();});
      child.once("error",reject);
      child.once("exit",(code,signal)=>reject(Error("child exited before retrieval: "+code+"/"+signal+" "+logs)));
    }),"child did not reach RAG");
    assert.equal(child.kill("SIGKILL"),true);
    await deadline(new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal}))),
      "killed child did not exit");

    // Reopen a wholly separate checkpointer after the actual process exit.
    const recovered=createPersistentResearchGraph({
      conversations,memory,
      intent:{extract:async()=>({query:"monitor",
        context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
      retriever:{search:async()=>({candidates:[],evidence:[]})}
    },saver,postgresTurnLock(lockDb,db));
    const before=await recovered.getOwnedState("worker-kill-owner",thread.id);
    assert.equal(Boolean(before.values?.researchResult?.explanation),false,
      "killed worker cannot publish a complete answer");
    const resumed=await deadline(recovered.invoke({
      actorUserId:"worker-kill-owner",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:"child-action",
      userMessage:"모니터 추천"
    }),"recovery");
    assert.equal(resumed.shoppingPlan.revision,1);
    assert.equal(resumed.clientActionId,"child-action");
    const source=await db.unsafe(`SELECT count(*)::int AS n FROM shopping_brain.messages
      WHERE conversation_id=$1 AND client_action_id='child-action'`,[thread.id]);
    assert.equal(source[0].n,1,"retry must use the same source message");
  }finally{
    if(child&&!child.killed)child.kill("SIGKILL");
    await Promise.allSettled([saver.end(),lockDb.end({timeout:1}),db.end({timeout:1})]);
  }
});
