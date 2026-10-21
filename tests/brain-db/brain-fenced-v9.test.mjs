import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";

const url=process.env.BRAIN_DATABASE_URL;
const valid=()=>{if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");};
const intent=(message,mem,previous)=>{
  if(message==="first")return {query:"monitor",queryMode:"SET",budgetMode:"SET",
    requirementsMode:"REPLACE",context:{maxTotalWon:500000,requiredConditions:["FHD"],currentPreferences:{}}};
  if(message==="next")return {query:"monitor",queryMode:"KEEP",budgetMode:"SET",
    requirementsMode:"KEEP",context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}}};
  if(message==="audio")return {query:"headphones",queryMode:"SET",budgetMode:"CLEAR",
    requirementsMode:"CLEAR",preferencesMode:"CLEAR",
    context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};
  throw Error("unexpected message "+message);
};

test("fenced v9 publishes only completed per-generation graph states; replay and restart preserve plan",async()=>{
  valid();
  const db=postgres(url,{max:4}),lockDb=postgres(url,{max:2});
  let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const fence=new FencedTurns(store);
    const thread=await conversations.create("v9-owner");
    let retrievals=0;
    const deps={conversations,memory,intent:{extract:async(...args)=>intent(...args)},
      retriever:{search:async()=>{retrievals++;return {candidates:[],evidence:[]};}}};
    const graphFactory=()=>createPersistentResearchGraph(deps,saver,postgresTurnLock(lockDb,db),fence);
    let graph=graphFactory();
    const call=(action,userMessage)=>graph.invoke({actorUserId:"v9-owner",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:action,userMessage});
    const first=await call("one","first");
    assert.equal(first.shoppingPlan.maxTotalWon,500000);
    assert.deepEqual(first.shoppingPlan.requiredConditions,["FHD"]);
    assert.equal(first.shoppingPlan.revision,1);
    const pointer=await fence.latest(thread.id);
    assert.ok(pointer?.threadId);
    assert.notEqual(pointer.threadId,thread.id,"checkpoint must live on private generation thread");
    const second=await call("two","next");
    assert.equal(second.shoppingPlan.maxTotalWon,300000);
    assert.deepEqual(second.shoppingPlan.requiredConditions,["FHD"]);
    assert.equal(second.shoppingPlan.revision,2);
    const latest=await fence.latest(thread.id);
    assert.notEqual(latest.threadId,pointer.threadId);
    assert.equal(latest.result.clientActionId,"two");
    assert.equal((await graph.getOwnedState("v9-owner",thread.id)).values.shoppingPlan.revision,2);
    await assert.rejects(()=>graph.getOwnedState("wrong-tenant",thread.id),/not owned/);
    const replay=await call("two","next");
    assert.equal(replay.messageId,second.messageId);
    assert.equal(retrievals,2);
    await assert.rejects(()=>call("two","audio"),/duplicate action conflict/);
    await saver.end();
    saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
    await saver.setup();
    graph=graphFactory();
    const third=await call("three","audio");
    assert.equal(third.shoppingPlan.query,"headphones");
    assert.equal(third.shoppingPlan.maxTotalWon,null);
    assert.deepEqual(third.shoppingPlan.requiredConditions,[]);
    assert.equal(third.shoppingPlan.revision,3);
    assert.equal((await graph.getOwnedState("v9-owner",thread.id)).values.researchResult.clientActionId,"three");
    const messages=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1",[thread.id]);
    assert.equal(messages[0].n,3);
  }finally{await Promise.allSettled([saver.end(),lockDb.end(),db.end()]);}
});

test("fenced v9 rejects a stale generation after takeover and retains newer canonical receipt",async()=>{
  valid();
  const db=postgres(url,{max:3});
  try{
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const thread=await conversations.create("v9-stale-owner");
    const fence=new FencedTurns(store);
    const base={actorUserId:"v9-stale-owner",conversationId:thread.id};
    const a={...base,clientActionId:"old",userMessage:"first"};
    const b={...base,clientActionId:"new",userMessage:"next"};
    const old=await fence.claim(a);
    assert.equal(old.kind,"run");
    const newer=await fence.claim(b);
    assert.equal(newer.kind,"run");
    assert.ok(BigInt(newer.generation)>BigInt(old.generation));
    const result=(req)=>({conversationId:thread.id,messageId:crypto.randomUUID(),
      clientActionId:req.clientActionId,ranking:{evaluatedCount:0,ranked:[],referenceOnly:[]},
      shoppingPlan:{query:"monitor",maxTotalWon:500000,requiredConditions:[],
        currentPreferences:{},revision:1},
      explanation:{kind:"NO_MATCH",text:"No evidence",citations:[]},
      trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:0}});
    await assert.rejects(()=>fence.publish(a,old,result(a)),/stale turn generation/);
    await fence.publish(b,newer,result(b));
    assert.equal((await fence.latest(thread.id)).result.clientActionId,"new");
    const pending=await db.unsafe("SELECT status FROM shopping_brain.turn_receipts WHERE conversation_id=$1 AND client_action_id='old'",[thread.id]);
    assert.equal(pending[0].status,"PENDING");
  }finally{await db.end();}
});

test("v9: delayed old worker after DB lock loss cannot publish over successor",async()=>{
  valid();
  const dbA=postgres(url,{max:4}),dbB=postgres(url,{max:4});
  const locksA=postgres(url,{max:2}),locksB=postgres(url,{max:2});
  const saverA=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  const saverB=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  let reservedA,releaseOld,signalStarted;
  const blocked=new Promise(resolve=>{releaseOld=resolve;});
  const started=new Promise(resolve=>{signalStarted=resolve;});
  const bounded=(p,label)=>{
    let timer;
    return Promise.race([p,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error(label+" timeout")),12000);
    })]).finally(()=>clearTimeout(timer));
  };
  try{
    await saverA.setup();await saverB.setup();
    const storeA=brainDatabaseFromPostgres(dbA),storeB=brainDatabaseFromPostgres(dbB);
    const convA=new PersistentConversations(storeA);
    const convB=new PersistentConversations(storeB);
    const memA=new PersistentPreferences(storeA),memB=new PersistentPreferences(storeB);
    const thread=await convA.create("v9-duel");
    const retrieveOld=async()=>{signalStarted();await blocked;return {candidates:[],evidence:[]};};
    const newResult=async()=>({candidates:[],evidence:[]});
    const create=(conversations,memory,retriever,saver,lock,fence)=>
      createPersistentResearchGraph({
        conversations,memory,intent:{extract:async()=>({query:"monitor",
          context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
        retriever:{search:retriever}
      },saver,lock,fence);
    const old=create(convA,memA,retrieveOld,saverA,postgresTurnLock({
      reserve:async()=>{reservedA=await locksA.reserve();return reservedA;}
    },dbA),new FencedTurns(storeA));
    const next=create(convB,memB,newResult,saverB,
      postgresTurnLock(locksB,dbB),new FencedTurns(storeB));
    const make=(clientActionId)=>({actorUserId:"v9-duel",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId,userMessage:clientActionId});
    const task=old.invoke(make("old"));
    task.catch(()=>{});
    await bounded(started,"old worker retrieval");
    const [{pid}]=await reservedA.unsafe("SELECT pg_backend_pid() AS pid");
    const [{terminated}]=await dbB.unsafe("SELECT pg_terminate_backend($1::int) AS terminated",[pid]);
    assert.equal(terminated,true);
    const newTurn=await bounded(next.invoke(make("new")),"new worker");
    assert.equal(newTurn.clientActionId,"new");
    releaseOld();
    await assert.rejects(()=>bounded(task,"stale worker"),/lock session lost|terminat|socket|connection/i);
    const canonical=await new FencedTurns(storeB).latest(thread.id);
    assert.equal(canonical.result.clientActionId,"new");
    assert.equal((await next.getOwnedState("v9-duel",thread.id)).values.researchResult.clientActionId,"new");
    const rows=await dbB.unsafe("SELECT client_action_id,status FROM shopping_brain.turn_receipts WHERE conversation_id=$1 ORDER BY client_action_id",[thread.id]);
    assert.deepEqual(rows.map(x=>[x.client_action_id,x.status]),[["new","COMPLETED"],["old","PENDING"]]);
  }finally{
    releaseOld?.();
    await Promise.allSettled([saverA.end(),saverB.end(),
      locksA.end({timeout:1}),locksB.end({timeout:1}),dbA.end({timeout:1}),dbB.end({timeout:1})]);
  }
});

test("v9 refuses to silently reset a populated legacy v8 checkpoint",async()=>{
  valid();
  const db=postgres(url,{max:3}),locks=postgres(url,{max:2});
  const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const thread=await conversations.create("legacy-v8-owner");
    const deps={conversations,memory,
      intent:{extract:async()=>({query:"monitor",context:{
        maxTotalWon:600000,requiredConditions:[],currentPreferences:{}
      }})},retriever:{search:async()=>({candidates:[],evidence:[]})}};
    const legacy=createPersistentResearchGraph(deps,saver);
    await legacy.invoke({actorUserId:"legacy-v8-owner",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:"legacy-a",userMessage:"legacy"});
    const graph=createPersistentResearchGraph(deps,saver,
      postgresTurnLock(locks,db),new FencedTurns(store));
    await assert.rejects(()=>graph.getOwnedState("legacy-v8-owner",thread.id),/legacy Brain checkpoint migration required/);
    await assert.rejects(()=>graph.invoke({actorUserId:"legacy-v8-owner",
      conversationId:thread.id,requestId:crypto.randomUUID(),clientActionId:"new-v9",
      userMessage:"another"}),/legacy Brain checkpoint migration required/);
    const old=await legacy.getOwnedState("legacy-v8-owner",thread.id);
    assert.equal(old.values.shoppingPlan.maxTotalWon,600000,"older saved plan must stay intact");
    assert.equal(await new FencedTurns(store).latest(thread.id),null);
    const [{n}]=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1",[thread.id]);
    assert.equal(n,1,"no new message added during migration block");
  }finally{await Promise.allSettled([saver.end(),locks.end(),db.end()]);}
});

test("M14 closing an AI conversation between claim and publish blocks stale publication",async()=>{
 valid();
 const db=postgres(url,{max:3});
 try{
  const store=brainDatabaseFromPostgres(db);
  const conversations=new PersistentConversations(store);
  const thread=await conversations.create("closed-turn-owner");
  const fence=new FencedTurns(store);
  const old={actorUserId:"closed-turn-owner",conversationId:thread.id,
   clientActionId:"claimed",userMessage:"모니터"};
  await assert.rejects(()=>fence.claim({...old,actorUserId:"another-user"}),/not owned or closed/);
  const claim=await fence.claim(old);
  assert.equal(claim.kind,"run");
  const [{updated}]=await db.unsafe(
   "UPDATE shopping_brain.conversations SET closed_at=now() WHERE id=$1 RETURNING id AS updated",
   [thread.id]);
  assert.equal(updated,thread.id);
  const fake={conversationId:thread.id,messageId:crypto.randomUUID(),
   clientActionId:old.clientActionId,
   ranking:{evaluatedCount:0,ranked:[],referenceOnly:[],rejected:[]},
   shoppingPlan:{query:"monitor",maxTotalWon:500000,requiredConditions:[],
    currentPreferences:{},revision:1},
   explanation:{kind:"NO_MATCH",text:"No evidence",items:[],limitations:[]},
   trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:0}};
  await assert.rejects(()=>fence.publish(old,claim,fake),/not owned or closed/);
  await assert.rejects(()=>fence.claim({...old,clientActionId:"new"}),/not owned or closed/);
  assert.equal(await fence.latest(thread.id),null,"closed task must not become canonical");
  const [status]=await db.unsafe(
   "SELECT status FROM shopping_brain.turn_receipts WHERE conversation_id=$1 AND client_action_id=$2",
   [thread.id,old.clientActionId]);
  assert.equal(status.status,"PENDING");
 }finally{await db.end();}
});
