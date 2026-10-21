import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';
import type {ProductCandidate,ReviewSummaryRequest} from '../../src/brain/contracts.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';

const names=['[NEW 3종/5+1매] 노프랍 하이드로겔 마스크팩 5+1매 기획 6종','넘버즈인 마스크팩 10매','메디힐 마스크팩'];
const candidates:ProductCandidate[]=names.map((name,index)=>({productId:`p${index+1}`,variantId:`v${index+1}`,productName:name,
 unitPriceWon:10000+index*1000,shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{},commerceVerified:true,sourceKind:'REAL',datasetVersion:'ctx-v1'}));
function fixture(){
 const calls={search:0,reviews:[] as ReviewSummaryRequest[],contexts:[] as any[]};
 const graph=createPersistentResearchGraph({datasetVersion:'ctx-v1',fastResponses:true,
   conversations:{assertOwned:async(actor)=>{if(actor!=='u1')throw Error('not owned');},appendUserMessage:async()=>crypto.randomUUID()},
   memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
   route:async(message,plan,context)=>{calls.contexts.push(context);return routeBrainMessage(message,plan);},
   intent:{extract:async()=>({query:'마스크팩',context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async()=>{calls.search++;return {candidates,evidence:[]};}},
   reviewSummary:async({request})=>{calls.reviews.push(request);return {kind:'REVIEW_SUMMARY',items:[],limitations:[],text:'해당 상품의 리뷰를 확인했어요.',
     reviewSummary:{status:'READY',focus:request.focus,product:{id:request.productId!,name:names[Number(request.productId?.slice(1))-1]},evidence:[],datasetVersion:'ctx-v1'}};},
 },new MemorySaver() as never);
 const turn=(message:string,actor='u1')=>graph.invoke({actorUserId:actor,conversationId:'ctx-conversation',requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage:message});
 return {calls,graph,turn};
}
test('named product plus demonstrative resolves the prior recommendation without a new search',async()=>{
 const f=fixture();await f.turn('마스크팩 추천해줘');
 const result=await f.turn('노프랍 하이드로겔 마스크팩 5+1매 기획 6종 이거 리뷰 분석해줘');
 assert.equal(result.intentKind,'REVIEW_SUMMARY');assert.equal(f.calls.reviews.at(-1)?.productId,'p1');assert.equal(f.calls.search,1);
});
test('target clarification persists and a corrected product name resumes the same review task',async()=>{
 const f=fixture();await f.turn('마스크팩 추천해줘');
 const waiting=await f.turn('이거 단점만 알려줘') as ResearchResult;
 assert.equal(waiting.pendingReview?.focus,'CONS');
 assert.equal(waiting.explanation?.reviewSummary?.choices?.length,3);
 const result=await f.turn('노프랍 하이드로겔 마스크팩 이라고 얘기했는데?') as ResearchResult;
 assert.equal(result.intentKind,'REVIEW_SUMMARY');assert.equal(f.calls.reviews.at(-1)?.productId,'p1');
 assert.equal(f.calls.reviews.at(-1)?.focus,'CONS');assert.equal(f.calls.search,1);assert.equal(result.pendingReview,undefined);
});
test('recent same-conversation turns are bounded and supplied to routing without changing ownership',async()=>{
 const f=fixture();for(let i=0;i<8;i++)await f.turn(`마스크팩 추천해줘 ${i}`);
 const state=await f.graph.getOwnedState('u1','ctx-conversation');
 const result=state.values?.researchResult as ResearchResult;
 assert.equal(result.recentTurns?.length,6);assert.ok(f.calls.contexts.at(-1)?.recentTurns.length);
 assert.equal(result.recentTurns?.at(-1)?.user,'마스크팩 추천해줘 7');
 await assert.rejects(f.turn('그거 리뷰 알려줘','other-user'),/not owned/);
});
test('a clear new recommendation leaves pending review instead of treating it as a product answer',async()=>{
 const f=fixture();await f.turn('마스크팩 추천해줘');await f.turn('이거 단점만 알려줘');
 const next=await f.turn('다른 수분크림 추천해줘') as ResearchResult;
 assert.notEqual(next.intentKind,'REVIEW_SUMMARY');assert.equal(next.pendingReview,undefined);assert.equal(f.calls.search,2);
});
test('after identifying one product, a disadvantages follow-up keeps that review product',async()=>{
 const f=fixture();await f.turn('마스크팩 추천해줘');
 await f.turn('노프랍 하이드로겔 마스크팩 이거 리뷰 분석해줘');
 await f.turn('그거 단점만 알려줘');
 assert.equal(f.calls.reviews.at(-1)?.productId,'p1');assert.equal(f.calls.reviews.at(-1)?.focus,'CONS');
 assert.equal(f.calls.search,1);
});
