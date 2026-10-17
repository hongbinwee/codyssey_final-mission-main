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
test("isolated real PostgreSQL persists preferences and LangGraph checkpoints across restarts",async()=>{
 if(!url||!new URL(url).pathname.startsWith("/brain_"))throw new Error("AI-only brain_* DB required");
 const sql=postgres(url,{max:5});
 let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try {
  const [db]=await sql.unsafe("SELECT current_database() AS name");
  assert.match(db.name,/^brain_/);
  const storage=brainDatabaseFromPostgres(sql);
  const threads=new PersistentConversations(storage),memory=new PersistentPreferences(storage);
  const a=await threads.create("user-a"),b=await threads.create("user-b");
  await assert.rejects(()=>threads.assertOwned("user-b",a.id),/not owned/);
  const first=await threads.appendUserMessage("user-a",a.id,"preference-1","가성비를 선호해");
  assert.equal(await threads.appendUserMessage("user-a",a.id,"preference-1","가성비를 선호해"),first);
  await assert.rejects(()=>threads.appendUserMessage("user-a",a.id,"preference-1","수정된 요청"),/conflict/);
  await assert.rejects(()=>threads.proposePreference({actorUserId:"user-b",conversationId:a.id,sourceMessageId:first,key:"price_priority",value:"value"}),/not owned/);
  const proof=await threads.proposePreference({actorUserId:"user-a",conversationId:a.id,sourceMessageId:first,key:"price_priority",value:"value"});
  const [x,y]=await Promise.allSettled([threads.confirmPreference("user-a",proof),threads.confirmPreference("user-a",proof)]);
  assert.equal([x,y].filter(v=>v.status==="fulfilled").length,1,"approval must be consumed once even under concurrent requests");
  assert.equal((await memory.list("user-a"))[0].value,"value");
  assert.equal((await memory.list("user-b")).length,0);

  const ev=[];
  const candidates=[];
  for(const [id,price,perf,eye] of [["a",105000,.45,.45],["b",395000,.95,.9]]){
    const prod="p-"+id;
    const facts={};
    for(const [facet,score] of [["performance",perf],["eye_comfort",eye],["noise",.6]]){
      const eid=facet+"-"+id;
      ev.push({id:eid,productId:prod,variantId:"v-"+id,kind:"REVIEW",sourceKind:"REAL",sourceRef:"CI-only synthetic fixture"});
      facts[facet]={score,evidenceIds:[eid]};
    }
    candidates.push({productId:prod,variantId:"v-"+id,unitPriceWon:price,shippingFeeWon:5000,
      rating:4.4,ratingScale:5,wholeReviewCount:20,wholeReviewCountVerified:true,conditions:{},facets:facts});
  }
  const deps={
    conversations:threads,memory,
    intent:{extract:async()=>({query:"monitor",context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
    retriever:{search:async()=>({candidates,evidence:ev})}
  };
  await saver.setup();
  let graph=createPersistentResearchGraph(deps,saver);
  const api=createBrainApi({conversations:threads,preferences:memory,graph});
  const getState=await api("GET",`/api/brain/conversations/${a.id}/state`,"user-b",{});
  assert.equal(getState.status,404);
  const t1=await api("POST",`/api/brain/conversations/${a.id}/turn`,"user-a",{user_message:"내 조건으로 추천",client_action_id:"turn-1"});
  assert.equal(t1.status,200,JSON.stringify(t1.body));
  assert.equal(t1.body.data.ranking.ranked[0].candidate.productId,"p-a","stored value preference must affect ranking");
  const second=await threads.appendUserMessage("user-a",a.id,"preference-2","성능이 우선이야");
  const p2=await threads.proposePreference({actorUserId:"user-a",conversationId:a.id,sourceMessageId:second,key:"price_priority",value:"performance"});
  await threads.confirmPreference("user-a",p2);
  const t2=await api("POST",`/api/brain/conversations/${a.id}/turn`,"user-a",{user_message:"같은 모니터 다시 추천",client_action_id:"turn-2"});
  assert.equal(t2.status,200);
  assert.equal(t2.body.data.ranking.ranked[0].candidate.productId,"p-b","new memory must change ranking");
  const stored=await graph.getOwnedState("user-a",a.id);
  assert.equal(stored.values.researchResult.messageId,t2.body.data.message_id);
  await assert.rejects(()=>graph.getOwnedState("user-b",a.id),/not owned/);
  await saver.end();
  saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  await saver.setup();
  graph=createPersistentResearchGraph(deps,saver);
  const recovered=await graph.getOwnedState("user-a",a.id);
  assert.equal(recovered.values.researchResult.messageId,t2.body.data.message_id,"Postgres checkpoint survives saver reinitialization");
  const del=await api("DELETE","/api/brain/preferences/price_priority","user-a",{});
  assert.equal(del.status,200);
  assert.equal((await memory.list("user-a")).length,0);
  await threads.assertOwned("user-b",b.id);
 } finally {
  await Promise.allSettled([saver.end(),sql.end()]);
 }
});


test("multi-turn Shopping Plan preserves budget/specs and survives PostgreSQL graph restart",async()=>{
 const db=postgres(url,{max:3});
 let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try{
   const conversations=new PersistentConversations(brainDatabaseFromPostgres(db));
   const memory=new PersistentPreferences(brainDatabaseFromPostgres(db));
   const thread=await conversations.create("user-plan-owner");
   const calls=[];
   const evidence=[{id:"verified-spec",productId:"p-plan",variantId:null,kind:"SPEC",sourceKind:"REAL"},
     ...["performance","eye_comfort","noise"].map(name=>({
       id:"e-"+name,productId:"p-plan",variantId:null,kind:"REVIEW",sourceKind:"REAL",sourceRef:"ci-only"
     }))];
   const candidate={productId:"p-plan",variantId:"v-plan",productName:"Fictional monitor",
     unitPriceWon:290000,shippingFeeWon:3000,rating:4.4,ratingScale:5,
     wholeReviewCount:25,wholeReviewCountVerified:true,
     conditions:{FHD:["verified-spec"]},
     facets:{performance:{score:.8,evidenceIds:["e-performance"]},
       eye_comfort:{score:.6,evidenceIds:["e-eye_comfort"]},
       noise:{score:.7,evidenceIds:["e-noise"]}}};
   const deps={
     conversations,memory,
     intent:{extract:async(message,remembered,previous)=>{
       if(message==="첫 질문")return {query:"monitor",
         context:{maxTotalWon:500000,requiredConditions:["FHD"],currentPreferences:{}},
         queryMode:"SET",budgetMode:"SET",requirementsMode:"REPLACE"};
       assert.equal(previous?.query,"monitor");
       if(message==="눈 피로도 중요해")return {query:"monitor",
         context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{eye_comfort:"important"}},
         queryMode:"KEEP",budgetMode:"KEEP",requirementsMode:"KEEP"};
       if(message==="예산을 30만원으로")return {query:"monitor",
         context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}},
         queryMode:"KEEP",budgetMode:"SET",requirementsMode:"KEEP"};
       if(message==="다른 상품: 헤드폰")return {query:"headphones",
         context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}},
         queryMode:"SET",budgetMode:"CLEAR",requirementsMode:"CLEAR",preferencesMode:"CLEAR"};
       throw Error("unexpected message");
     }},
     retriever:{search:async(input)=>{calls.push(input);return {candidates:[candidate],evidence};}}
   };
   await saver.setup();
   let graph=createPersistentResearchGraph(deps,saver);
   const invoke=async(userMessage,clientActionId)=>graph.invoke({
     actorUserId:"user-plan-owner",conversationId:thread.id,
     requestId:crypto.randomUUID(),clientActionId,userMessage
   });
   const first=await invoke("첫 질문","plan-action-1");
   assert.equal(first.shoppingPlan.maxTotalWon,500000);
   assert.deepEqual(first.shoppingPlan.requiredConditions,["FHD"]);
   assert.equal(first.ranking.ranked.length,1);
   const second=await invoke("눈 피로도 중요해","plan-action-2");
   assert.equal(second.shoppingPlan.maxTotalWon,500000,"followup cannot drop budget");
   assert.deepEqual(second.shoppingPlan.requiredConditions,["FHD"]);
   assert.equal(second.shoppingPlan.currentPreferences.eye_comfort,"important");
   assert.equal(second.shoppingPlan.revision,2);
   assert.equal(second.explanation.kind,"VERIFIED_CANDIDATES");
   assert.match(second.explanation.text,/500,000원/);
   assert.equal(calls[1].maxTotalWon,500000);
   assert.deepEqual(calls[1].requiredConditions,["FHD"]);
   const replay=await invoke("눈 피로도 중요해","plan-action-2");
   assert.equal(replay.messageId,second.messageId);
   assert.equal(calls.length,2,"completed action replay must not refetch");
   const changed=await invoke("예산을 30만원으로","plan-action-3");
   assert.equal(changed.shoppingPlan.maxTotalWon,300000);
   assert.deepEqual(changed.shoppingPlan.requiredConditions,["FHD"]);
   await saver.end();
   saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
   await saver.setup();
   graph=createPersistentResearchGraph(deps,saver);
   const checkpoint=await graph.getOwnedState("user-plan-owner",thread.id);
   assert.equal(checkpoint.values.shoppingPlan.maxTotalWon,300000);
   assert.equal(checkpoint.values.shoppingPlan.revision,3);
   await assert.rejects(()=>graph.getOwnedState("someone-else",thread.id),/not owned/);
   const newCategory=await graph.invoke({actorUserId:"user-plan-owner",
     conversationId:thread.id,requestId:crypto.randomUUID(),
     clientActionId:"plan-action-4",userMessage:"다른 상품: 헤드폰"});
   assert.equal(newCategory.shoppingPlan.query,"headphones");
   assert.equal(newCategory.shoppingPlan.maxTotalWon,null);
   assert.deepEqual(newCategory.shoppingPlan.requiredConditions,[]);
   assert.deepEqual(newCategory.shoppingPlan.currentPreferences,{});
 }finally{await Promise.allSettled([saver.end(),db.end()]);}
});

test("concurrent identical Graph turns coalesce; different turns return 409, checkpoints remain valid",async()=>{
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const db=postgres(url,{max:2});
 const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try{
   const source=brainDatabaseFromPostgres(db);
   const conversations=new PersistentConversations(source),memory=new PersistentPreferences(source);
   const thread=await conversations.create("user-concurrent-check");
   let unblock,markStarted;
   const blocked=new Promise(resolve=>{unblock=resolve});
   const started=new Promise(resolve=>{markStarted=resolve});
   let searchCalls=0,extractCalls=0;
   const deps={
     conversations,memory,
     intent:{extract:async(message,stored,previous)=>{
       extractCalls++;
       return {query:"monitor",context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}},
         queryMode:previous?"KEEP":"SET",budgetMode:previous?"KEEP":"SET",requirementsMode:"KEEP"};
     }},
     retriever:{search:async()=>{
       searchCalls++;
       if(searchCalls===1){markStarted();await blocked;}
       return {candidates:[],evidence:[]};
     }}
   };
   await saver.setup();
   const graph=createPersistentResearchGraph(deps,saver);
   const api=createBrainApi({conversations,preferences:memory,graph});
   const send=(id,message,actor="user-concurrent-check")=>api("POST",
     `/api/brain/conversations/${thread.id}/turn`,actor,
     {client_action_id:id,user_message:message});
   const a=send("same-action","모니터 추천");
   await started;
   const duplicate=send("same-action","모니터 추천");
   // Allow ownership queries to reach the in-flight Map.
   const conflict=await send("other-action","다른 조건으로");
   assert.equal(conflict.status,409,"concurrent different action must not start another run");
   assert.equal(conflict.body.error.code,"CONVERSATION_BUSY");
   const mismatch=await send("same-action","동일 ID로 다른 메시지");
   assert.equal(mismatch.status,400,"same action id with different message rejected");
   const outsider=await send("same-action","모니터 추천","not-owner");
   assert.equal(outsider.status,404,"tenant boundary remains enforced under contention");
   unblock();
   const [one,two]=await Promise.all([a,duplicate]);
   assert.equal(one.status,200);assert.equal(two.status,200);
   assert.equal(one.body.data.message_id,two.body.data.message_id);
   assert.equal(searchCalls,1,"coalescing must avoid duplicate searches");
   assert.equal(extractCalls,1,"coalescing must avoid duplicate model calls");
   assert.equal((await graph.getOwnedState("user-concurrent-check",thread.id)).values.shoppingPlan.revision,1);
   const next=await send("other-action","다음 턴");
   assert.equal(next.status,200);
   assert.equal(next.body.data.shopping_plan.revision,2);
   assert.equal(searchCalls,2);
 }finally{await Promise.allSettled([saver.end(),db.end()]);}
});

test("deleting canonical Memory does NOT constitute transcript or checkpoint erasure",async()=>{
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const db=postgres(url,{max:2});
 const saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try{
   const backend=brainDatabaseFromPostgres(db);
   const conversations=new PersistentConversations(backend),memory=new PersistentPreferences(backend);
   const thread=await conversations.create("user-memory-erase-audit");
   const message=await conversations.appendUserMessage("user-memory-erase-audit",thread.id,
     "source-pref","이 대화에서는 가성비가 중요해");
   const proposal=await conversations.proposePreference({actorUserId:"user-memory-erase-audit",
     conversationId:thread.id,sourceMessageId:message,key:"price_priority",value:"value"});
   await conversations.confirmPreference("user-memory-erase-audit",proposal);
   assert.equal((await memory.list("user-memory-erase-audit")).length,1);
   await saver.setup();
   const graph=createPersistentResearchGraph({
     conversations,memory,
     intent:{extract:async()=>({query:"monitor",
       context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
     retriever:{search:async()=>({candidates:[],evidence:[]})}
   },saver);
   const response=await graph.invoke({actorUserId:"user-memory-erase-audit",conversationId:thread.id,
     requestId:crypto.randomUUID(),clientActionId:"erasure-audit-turn",userMessage:"같은 대화 이어가자"});
   assert.equal(response.ranking.evaluatedCount,0);
   assert.equal(await memory.delete("user-memory-erase-audit","price_priority"),true);
   assert.deepEqual(await memory.list("user-memory-erase-audit"),[]);
   const saved=await db.unsafe("SELECT content FROM shopping_brain.messages WHERE id=$1 AND actor_user_id=$2",
     [message,"user-memory-erase-audit"]);
   assert.equal(saved.length,1,"source message still exists; no full erasure promise is valid");
   const checkpoint=await graph.getOwnedState("user-memory-erase-audit",thread.id);
   assert.ok(checkpoint.values.researchResult,"checkpoint persists after preference delete");
   await assert.rejects(()=>graph.getOwnedState("user-memory-erase-audit-other",thread.id),/not owned/);
 }finally{await Promise.allSettled([saver.end(),db.end()]);}
});

test("retry unfinished RAG turn after checkpoint restart does not double-apply budget changes",async()=>{
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const db=postgres(url,{max:2});
 let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try{
   const runner=brainDatabaseFromPostgres(db);
   const conversations=new PersistentConversations(runner),memory=new PersistentPreferences(runner);
   const thread=await conversations.create("user-recovery-audit");
   let retrievalCalls=0;
   const deps={conversations,memory,
     intent:{extract:async(message,preferences,prior)=>{
       if(message==="first")return {query:"monitor",queryMode:"SET",
         budgetMode:"SET",context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}};
       assert.equal(prior?.revision,1,"retry MUST use last COMPLETED plan after crash");
       return {query:"monitor",queryMode:"KEEP",budgetMode:"SET",requirementsMode:"KEEP",
         context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}}};
     }},
     retriever:{search:async()=>{
       retrievalCalls++;
       if(retrievalCalls===2)throw new Error("CI injected RAG HTTP timeout");
       return {candidates:[],evidence:[]};
     }}
   };
   await saver.setup();
   let graph=createPersistentResearchGraph(deps,saver);
   const invoke=async(message,action)=>graph.invoke({
     actorUserId:"user-recovery-audit",conversationId:thread.id,
     requestId:crypto.randomUUID(),clientActionId:action,userMessage:message
   });
   const first=await invoke("first","recover-first");
   assert.equal(first.shoppingPlan.maxTotalWon,500000);
   await assert.rejects(()=>invoke("second","recover-second"),/timeout/);
   const prior=await graph.getOwnedState("user-recovery-audit",thread.id);
   assert.equal(prior.values.researchResult.clientActionId,"recover-first");
   // Model a new process by replacing its connection/checkpointer after the failure.
   await saver.end();
   saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
   await saver.setup();
   graph=createPersistentResearchGraph(deps,saver);
   const recovered=await invoke("second","recover-second");
   assert.equal(recovered.shoppingPlan.maxTotalWon,300000);
   assert.equal(recovered.shoppingPlan.revision,2,"an unfinished operation must not change plan twice");
   assert.equal(recovered.explanation.kind,"NO_MATCH");
   assert.equal(retrievalCalls,3);
   const messages=await db.unsafe(
     "SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1 AND client_action_id='recover-second'",
     [thread.id]);
   assert.equal(messages[0].n,1,"source message idempotency must survive provider failure and restart");
 }finally{await Promise.allSettled([saver.end(),db.end()]);}
});

test("two isolated Brain workers use the same PostgreSQL advisory session lock",async()=>{
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const sql1=postgres(url,{max:3}),sql2=postgres(url,{max:3});
 const saver1=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 const saver2=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 let unblock,markStarted;
 const blocked=new Promise(resolve=>{unblock=resolve});
 const started=new Promise(resolve=>{markStarted=resolve});
 try{
   const repo1=brainDatabaseFromPostgres(sql1);
   const conversations1=new PersistentConversations(repo1),memory1=new PersistentPreferences(repo1);
   const conversations2=new PersistentConversations(brainDatabaseFromPostgres(sql2));
   const memory2=new PersistentPreferences(brainDatabaseFromPostgres(sql2));
   const thread=await conversations1.create("user-multi-replica");
   let retrievals=0;
   const source={
     intent:{extract:async()=>({query:"monitor",context:{maxTotalWon:500000,
       requiredConditions:[],currentPreferences:{}}})},
     retriever:{search:async()=>{
       retrievals++;
       if(retrievals===1){markStarted();await blocked;}
       return {candidates:[],evidence:[]};
     }}
   };
   await saver1.setup();await saver2.setup();
   const a=createPersistentResearchGraph({
     ...source,conversations:conversations1,memory:memory1
   },saver1,postgresTurnLock(sql1,sql2));
   const b=createPersistentResearchGraph({
     ...source,conversations:conversations2,memory:memory2
   },saver2,postgresTurnLock(sql2,sql1));
   const request={actorUserId:"user-multi-replica",conversationId:thread.id,
     requestId:crypto.randomUUID(),clientActionId:"distributed-1",
     userMessage:"모니터 추천"};
   const p=a.invoke(request);
   await started;
   await assert.rejects(()=>b.invoke(request),/conversation busy/,
     "second worker must not enter same checkpoint concurrently");
   const other={...request,clientActionId:"distributed-2",
     requestId:crypto.randomUUID(),userMessage:"다른 질문"};
   await assert.rejects(()=>b.invoke(other),/conversation busy/);
   unblock();
   const first=await p;
   assert.equal(first.shoppingPlan.revision,1);
   assert.equal(retrievals,1);
   const repeated=await b.invoke(request);
   assert.equal(repeated.messageId,first.messageId,
     "second worker returns completed checkpoint for same action after first commits");
   assert.equal(retrievals,1,"cross-worker completed replay cannot run RAG a second time");
   const next=await b.invoke({...other,userMessage:"다른 질문"});
   assert.equal(next.shoppingPlan.revision,2);
   assert.equal(retrievals,2);
 }finally{
   if(unblock)unblock();
   await Promise.allSettled([saver1.end(),saver2.end(),sql1.end(),sql2.end()]);
 }
});
