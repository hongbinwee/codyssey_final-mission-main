import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';
import type {ProductCandidate,ReviewSummaryRequest} from '../../src/brain/contracts.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';
import {createReviewRequestResolver} from '../../src/brain/review-request-resolver.ts';
import {createReviewEvidenceLookup} from '../../src/brain/review-evidence.ts';
import {createReviewSummaryResponder} from '../../src/brain/review-summary-response.ts';

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
test('semantic review routing is authoritative and avoids a second classifier or product retrieval',async()=>{
 let classifierCalls=0,summaryCalls=0,searchCalls=0;
 const graph=createPersistentResearchGraph({datasetVersion:'ctx-v1',
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
  reviewRoute:async()=>({kind:'REVIEW_SUMMARY',search:false,reviewSummary:{productIds:['p1','p2'],semanticQuery:'몇 시간 뒤 건조',focus:'ALL'}}),
  route:async()=>{classifierCalls++;return {kind:'SHOPPING_SEARCH',search:true};},intent:{extract:async()=>{throw Error('unexpected planner');}},
  retriever:{search:async()=>{searchCalls++;return {candidates:[],evidence:[]};}},
  reviewSummary:async()=>{summaryCalls++;return {kind:'REVIEW_SUMMARY',text:'확인한 표본이에요.',items:[],limitations:[],reviewSummary:{status:'READY',focus:'ALL',evidence:[]}};},
 },new MemorySaver() as never);
 const result=await graph.invoke({actorUserId:'u1',conversationId:'semantic',requestId:'r',clientActionId:'a',userMessage:'이 중 몇 시간 뒤 건조해진다는 리뷰 찾아줘'});
 // IDs outside this conversation never reach RAG, even when supplied by a resolver.
 assert.equal(result.explanation?.reviewSummary?.status,'AMBIGUOUS');assert.deepEqual([classifierCalls,summaryCalls,searchCalls],[0,0,0]);
});

test('persisted recommendations feed scoped semantic review search and only matching negative quotes reach the response',async()=>{
 let productSearches=0,classifierCalls=0,semanticReads=0,summaryCalls=0;
 const sourceText='처음엔 촉촉하지만 두 시간 뒤에는 건조하고 당겨요.';
 const lookup=createReviewEvidenceLookup({
  getProduct:async({product_id}:any)=>({ok:true,data:{product:{id:product_id,name:names[Number(product_id.slice(1))-1],images:[]},variants:[{variant_id:'v'+product_id.slice(1)}]}}),
  getReviews:async()=>{throw Error('semantic requests must use scoped evidence');},searchProducts:async()=>{throw Error('must not search the whole catalog');},
 } as any,'ctx-v1',async input=>{
  semanticReads++;assert.deepEqual(input.products.map(row=>row.productId),['p1','p2','p3']);
  return [{id:'r1',sourceId:'r1',productId:'p1',variantId:'v1',kind:'REVIEW',sourceKind:'REAL',verified:true,datasetVersion:'ctx-v1',text:sourceText}];
 });
 const resolve=createReviewRequestResolver({async chat(){classifierCalls++;return {content:JSON.stringify({mode:'SEMANTIC',focus:'CONS',selection:'ALL_DISPLAYED',semanticQuery:'처음엔 촉촉하지만 시간이 지나면 건조하고 당기는 경험'})};}} as any);
 const respond=createReviewSummaryResponder({async chat(){summaryCalls++;return {content:JSON.stringify({claims:[{sourceId:'r1',quote:sourceText,aspect:'moisturizing',polarity:'CON',claim:'시간이 지나면 건조하고 당긴다는 의견이에요.',matches:true}]})};}} as any);
 const graph=createPersistentResearchGraph({datasetVersion:'ctx-v1',fastResponses:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
  reviewRoute:resolve,route:async message=>routeBrainMessage(message),
  intent:{extract:async()=>({query:'마스크팩',context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async()=>{productSearches++;return {candidates,evidence:[]};}},
  reviewSummary:async input=>respond(await lookup(input)),
 },new MemorySaver() as never);
 const turn=(userMessage:string)=>graph.invoke({actorUserId:'u1',conversationId:'semantic-flow',requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage});
 await turn('마스크팩 추천해줘');
 const result=await turn('이 중 처음에는 촉촉하지만 나중에는 건조해진다는 단점 리뷰 찾아줘');
 assert.equal(result.intentKind,'REVIEW_SUMMARY');assert.deepEqual([productSearches,classifierCalls,semanticReads,summaryCalls],[1,1,1,1]);
 assert.equal(result.explanation?.reviewSummary?.scope,'SEMANTIC_SAMPLES');assert.equal(result.explanation?.reviewSummary?.products?.length,3);
 assert.deepEqual(result.explanation?.reviewSummary?.evidence.map(row=>row.sourceId),['r1']);assert.match(result.explanation?.text??'',/시간이 지나면 건조/);
});
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
