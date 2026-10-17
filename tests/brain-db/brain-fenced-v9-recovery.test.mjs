import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {fork} from "node:child_process";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";
import {brainErasureFootprint} from "../../src/brain/erasure-audit.ts";

const url=process.env.BRAIN_DATABASE_URL;
const check=()=>{if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");};
const bound=(promise,label,ms=15000)=>{
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error(label+" timeout")),ms);
  })]).finally(()=>clearTimeout(timer));
};
const noMatch=()=>({candidates:[],evidence:[]});
const depsFor=(conversations,memory,search=noMatch)=>({
  conversations,memory,
  intent:{extract:async()=>({query:"monitor",queryMode:"SET",budgetMode:"SET",
    context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search}
});

test("v9: real SIGKILL mid-RAG cannot publish unfinished private checkpoint; replacement replays safely",async()=>{
  check();
  const db=postgres(url,{max:4}),lockDb=postgres(url,{max:2});
  const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  let child;
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const fencing=new FencedTurns(store);
    const conv=await conversations.create("worker-kill-owner");
    child=fork(new URL("./fixtures/held-brain-worker.mjs",import.meta.url),[],{
      execArgv:["--experimental-strip-types"],
      env:{...process.env,BRAIN_QA_THREAD:conv.id,BRAIN_QA_FENCED:"1"},
      stdio:["ignore","pipe","pipe","ipc"]
    });
    let errors="";
    child.stderr.on("data",d=>{errors+=String(d).slice(0,700);});
    await bound(new Promise((resolve,reject)=>{
      child.on("message",m=>{if(m?.kind==="in-retrieve")resolve();});
      child.once("error",reject);
      child.once("exit",(c,s)=>reject(Error("child exited "+c+"/"+s+": "+errors)));
    }),"child RAG entry");
    const current=await db.unsafe("SELECT generation,published_action_id FROM shopping_brain.turn_fence WHERE conversation_id=$1",[conv.id]);
    assert.equal(current.length,1);
    assert.equal(current[0].published_action_id,null,"unfinished attempt must not be canonical");
    assert.equal(child.kill("SIGKILL"),true);
    const [exit]=await Promise.all([bound(new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal}))),"SIGKILL exit")]);
    assert.equal(exit.signal,"SIGKILL");
    assert.equal(await fencing.latest(conv.id),null);
    const g=createPersistentResearchGraph(depsFor(conversations,memory),saver,
      postgresTurnLock(lockDb,db),fencing);
    const result=await bound(g.invoke({actorUserId:"worker-kill-owner",
      conversationId:conv.id,requestId:crypto.randomUUID(),
      clientActionId:"child-action",userMessage:"모니터 추천"}),"recovery");
    assert.equal(result.shoppingPlan.revision,1);
    const pub=await fencing.latest(conv.id);
    assert.equal(pub.result.clientActionId,"child-action");
    assert.equal((await g.getOwnedState("worker-kill-owner",conv.id)).values.researchResult.messageId,result.messageId);
    const rows=await db.unsafe(
      "SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1 AND client_action_id='child-action'",[conv.id]);
    assert.equal(rows[0].n,1);
    const gens=await db.unsafe("SELECT generation FROM shopping_brain.turn_fence WHERE conversation_id=$1",[conv.id]);
    assert.equal(Number(gens[0].generation),2,"restart requires a new generation");
    assert.equal((await brainErasureFootprint(store,"worker-kill-owner")).attempts,2,
      "crashed generation must remain indexed for privacy audit");
  }finally{
    if(child&&!child.killed)child.kill("SIGKILL");
    await Promise.allSettled([saver.end(),lockDb.end({timeout:1}),db.end({timeout:1})]);
  }
});

test("v9: failed PostgresSaver write cannot move canonical pointer; retry starts a fresh generation",async()=>{
  check();
  const db=postgres(url,{max:4}),lockDb=postgres(url,{max:2});
  const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const fencing=new FencedTurns(store);
    const conv=await conversations.create("fenced-partial-owner");
    const deps=depsFor(conversations,memory);
    const graph=(cp)=>createPersistentResearchGraph(deps,cp,postgresTurnLock(lockDb,db),fencing);
    const req=(id,msg)=>({actorUserId:"fenced-partial-owner",conversationId:conv.id,
      requestId:crypto.randomUUID(),clientActionId:id,userMessage:msg});
    const initial=await graph(saver).invoke(req("first","initial"));
    const prior=await fencing.latest(conv.id);
    assert.equal(prior.result.messageId,initial.messageId);

    let injected=false,puts=0;
    const faulty=new Proxy(saver,{get(target,key){
      if(key==="put")return async (...args)=>{
        const result=await target.put(...args);
        puts++;
        if(!injected&&puts===2){injected=true;throw Error("injected lost checkpoint ACK");}
        return result;
      };
      const value=Reflect.get(target,key,target);
      return typeof value==="function"?value.bind(target):value;
    }});
    await assert.rejects(()=>graph(faulty).invoke(req("retry-me","second")),/injected lost checkpoint ACK/);
    assert.equal(injected,true);
    const unchanged=await fencing.latest(conv.id);
    assert.equal(unchanged.threadId,prior.threadId);
    assert.equal(unchanged.result.clientActionId,"first");
    const recovered=await graph(saver).invoke(req("retry-me","second"));
    assert.equal(recovered.shoppingPlan.revision,2);
    const promoted=await fencing.latest(conv.id);
    assert.equal(promoted.result.clientActionId,"retry-me");
    assert.notEqual(promoted.threadId,prior.threadId);
    const actions=await db.unsafe("SELECT generation,status FROM shopping_brain.turn_receipts WHERE conversation_id=$1 AND client_action_id='retry-me'",[conv.id]);
    assert.equal(actions[0].status,"COMPLETED");
    assert.equal(Number(actions[0].generation),3);
    const msgs=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1 AND client_action_id='retry-me'",[conv.id]);
    assert.equal(msgs[0].n,1);
    const lineage=await db.unsafe(
      "SELECT generation,status,attempt_id FROM shopping_brain.turn_attempts WHERE conversation_id=$1 ORDER BY generation",
      [conv.id]);
    assert.deepEqual(lineage.map(r=>r.status),["COMPLETED","PENDING","COMPLETED"]);
    assert.equal(new Set(lineage.map(r=>r.attempt_id)).size,3);
    const privacy=await brainErasureFootprint(store,"fenced-partial-owner");
    assert.equal(privacy.attempts,3,"superseded saver attempt must remain discoverable");
    assert.ok(privacy.checkpoints>0,"physical checkpoint rows remain inventoried");

  }finally{await Promise.allSettled([saver.end(),lockDb.end(),db.end()]);}
});
