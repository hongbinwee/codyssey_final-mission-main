import test from 'node:test';
import assert from 'node:assert/strict';
import {needsInterview,interviewAnswer,rememberInterview} from '../../src/brain/interview.ts';
import {buildGroundedExplanation} from '../../src/brain/grounded-response.ts';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {MemorySaver} from '@langchain/langgraph';
import {routeBrainMessage} from '../../src/brain/routing.ts';
const plan={query:'단백질 쉐이크',maxTotalWon:null,requiredConditions:[],currentPreferences:{},revision:1};
test('named product searches need no generic budget or daily/gift interview',()=>{
 for(const query of ['단백질 쉐이크','마스크팩','식기세척기 세제'])assert.deepEqual(needsInterview({...plan,query},query+' 추천해줘',[]),[]);
 assert.deepEqual(needsInterview(plan,'선물할 쉐이크 추천해줘',[]),[]);
});
test('ambiguous product type asks exactly one scoped question; answer keeps budget and hard constraints',()=>{
 const broad={...plan,query:'다이어트 식품',maxTotalWon:20000,requiredConditions:['무가당']};
 const pending=rememberInterview(broad,'다이어트 식품 추천해줘',[]);
 assert.equal(needsInterview(pending,'다이어트 식품 추천해줘',[]).length,1);
 const answer=interviewAnswer('두유 쉐이크로',pending)!;
 assert.equal(answer.query,'두유 쉐이크');assert.equal(answer.maxTotalWon,20000);assert.deepEqual(answer.requiredConditions,['무가당']);
 assert.deepEqual(needsInterview(answer,'두유 쉐이크로',[]),[]);
 const skipped=interviewAnswer('상관없어요',pending)!;assert.equal(skipped.maxTotalWon,20000);assert.deepEqual(needsInterview(skipped,'상관없어요',[]),[]);
});
test('legacy purpose state never causes repeated daily/gift question or erases an explicit budget',()=>{
 const previous={...plan,maxTotalWon:10000,interview:{pending:['purpose'] as const,answered:['budget'] as const}};
 assert.deepEqual(needsInterview(previous as never,'예산은 1만원 이하',[]),[]);
 assert.equal(interviewAnswer('상관없어요',previous as never)!.maxTotalWon,10000);
});
const empty={ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0};
test('empty search, known budget mismatch and missing hard facts have different useful explanations',()=>{
 const p={productId:'p',variantId:'v',unitPriceWon:20000,shippingFeeWon:0,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{}};
 const ask={...plan,query:'식기세척기 세제',maxTotalWon:10000};
 const none=buildGroundedExplanation(empty,[],ask);assert.match(none.text,/식기세척기 세제/);assert.match(none.text,/10,000원/);assert.doesNotMatch(none.text,/시연 데이터|검증된 정보를 추가/);
 const budget=buildGroundedExplanation({...empty,evaluatedCount:1,rejected:[{candidate:p,reasons:['over_total_budget']}]},[],ask);assert.match(budget.text,/예산.*(?:넘|초과|벗어)/);
 const facts=buildGroundedExplanation({...empty,evaluatedCount:1,rejected:[{candidate:p,reasons:['unverified_required_condition:무향']}]},[],ask);assert.match(facts.text,/조건.*확인/);assert.doesNotMatch(facts.text,/예산.*넘/);
});
test('past purchases route to own-order intent, never product search or blanket cancellation reply',()=>{
 const r=routeBrainMessage('나 엊그제 뭐 구매했었지?');assert.equal(r.kind,'CS_REQUEST');assert.equal(r.search,false);
});
test('RAG failure preserves the plan and reports a service problem instead of missing product evidence',async()=>{
 let modelCalls=0;
 const graph=createPersistentResearchGraph({conversations:{assertOwned:async()=>{},appendUserMessage:async()=> 'm'},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
   intent:{extract:async()=>({query:'식기세척기 세제',context:{maxTotalWon:10000,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async()=>{throw Error('RAG unavailable secret must not appear');}}},new MemorySaver() as never,undefined,undefined,async()=>{modelCalls++;throw Error('must not run');});
 const result=await graph.invoke({actorUserId:'tester_05',conversationId:'qa-v1',requestId:'r',clientActionId:'a',userMessage:'1만원 이하 식기세척기 세제 추천'});
 assert.equal(result.shoppingPlan!.maxTotalWon,10000);assert.equal(modelCalls,0);
 assert.match(result.explanation!.text,/연결|불러오/);assert.doesNotMatch(result.explanation!.text,/근거가 부족|secret/);
 assert.equal(result.explanation!.failure!.code,'RETRIEVAL_UNAVAILABLE');
});

test('recorded service failure replays safely; a new action retries with the original budget and no memory writes',async()=>{
 let searches=0,answers=0,writes=0;
 const graph=createPersistentResearchGraph({conversations:{assertOwned:async()=>{},appendUserMessage:async(_a,_c,id)=>id},
   memory:{list:async()=>[],put:async()=>{writes++;},delete:async()=>{writes++;return false;}},
   intent:{extract:async(_message,_mem,previous)=>({query:previous?.query??'식기세척기 세제',queryMode:'KEEP',budgetMode:previous?'KEEP':'SET',context:{maxTotalWon:previous?null:10000,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async(input)=>{searches++;assert.equal(input.maxTotalWon,10000);if(searches===1)throw Error('upstream error');return {candidates:[],evidence:[]};}}},new MemorySaver() as never,
   undefined,undefined,async()=>{answers++;return {kind:'NO_MATCH',text:'지금은 맞는 상품을 찾지 못했어요.',items:[],limitations:[]};});
 const req={actorUserId:'tester_05',conversationId:'qa-recovery',requestId:'r',clientActionId:'original',userMessage:'1만원 이하 식기세척기 세제 추천'};
 await graph.invoke(req);await graph.invoke(req);assert.equal(searches,1);assert.equal(answers,0);
 const next=await graph.invoke({...req,clientActionId:'new-search'});assert.equal(searches,2);assert.equal(answers,1);assert.equal(next.shoppingPlan!.maxTotalWon,10000);assert.equal(writes,0);
});

test('purchase-history question preserves shopping state and never searches products or calls the model',async()=>{
 let searches=0;
 const graph=createPersistentResearchGraph({route:routeBrainMessage,conversations:{assertOwned:async()=>{},appendUserMessage:async(_a,_c,id)=>id},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
   intent:{extract:async()=>({query:'단백질 쉐이크',context:{maxTotalWon:20000,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async()=>{searches++;return {candidates:[],evidence:[]};}}},new MemorySaver() as never);
 const req={actorUserId:'tester_05',conversationId:'qa-orders',requestId:'r',clientActionId:'shop',userMessage:'단백질 쉐이크 추천해줘'};
 const first=await graph.invoke(req);const next=await graph.invoke({...req,clientActionId:'orders',userMessage:'나 엊그제 뭐 구매했었지?'});
 assert.equal(searches,1);assert.deepEqual(next.shoppingPlan,first.shoppingPlan);assert.equal(next.intentKind,'CS_REQUEST');assert.match(next.explanation!.text,/주문 내역 조회/);
 assert.doesNotMatch(next.explanation!.text,/취소|환불|차단|시연/);
});
