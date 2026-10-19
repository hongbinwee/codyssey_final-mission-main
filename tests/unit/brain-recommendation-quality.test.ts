import test from 'node:test';
import assert from 'node:assert/strict';
import {rankProducts} from '../../src/brain/personalization.ts';
import {createLlmGroundedResponder} from '../../src/brain/grounded-response.ts';
import {retrieveTurn} from '../../src/brain/read-flow.ts';
import type {ProductCandidate,EvidenceRecord,Preference} from '../../src/brain/contracts.ts';
import type {ShoppingPlan} from '../../src/brain/shopping-plan.ts';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {interviewAnswer} from '../../src/brain/interview.ts';
import {MemorySaver} from '@langchain/langgraph';

const product:ProductCandidate={productId:'p-mask',variantId:'v-mask',productName:'마스크팩 10매',
 unitPriceWon:10000,shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{},sourceKind:'SYNTHETIC',commerceVerified:true,isSimulated:true,qaRankingEligible:true,datasetVersion:'fixture-quality'};
const plan:ShoppingPlan={query:'마스크팩',maxTotalWon:20000,requiredConditions:[],currentPreferences:{},revision:1,category:'beauty'};
const ranking=()=>rankProducts([product],[],plan,[]);

test('verified demo catalog facts qualify without any review; missing hard evidence still rejects',()=>{
 assert.equal(ranking().ranked.length,1);
 assert.equal(rankProducts([product],[],{...plan,requiredConditions:['무향']},[]).ranked.length,0);
 assert.equal(rankProducts([{...product,commerceVerified:false}],[],plan,[]).ranked.length,0);
 assert.equal(rankProducts([{...product,qaRankingEligible:false}],[],plan,[]).ranked.length,0);
});

test('normal recommendations use one LLM call, stay ranked and cannot fabricate catalog reasons',async()=>{
 let calls=0;
 const respond=createLlmGroundedResponder({async chat(messages,tools){calls++;assert.deepEqual(tools,[]);
   const data=JSON.parse(messages[1].content!);assert.equal(data.candidates[0].evidence.length,0);
   assert.equal(data.shoppingPlan.maxTotalWon,20000);
   return {content:JSON.stringify({recommendations:[{productId:'p-mask',variantId:'v-mask',factIds:['budget'],reviewClaims:[]}]})};
 }});
 const result=await respond({originalQuestion:'2만원 이하 마스크팩 추천',ranking:ranking(),evidence:[],plan,mode:'RECOMMEND'} as never);
 assert.equal(calls,1);assert.equal(result.kind,'LLM_GROUNDED');assert.equal(result.items.length,1);
 assert.match(result.items[0].reason!,/13,000원|예산/);assert.deepEqual(result.citations,[]);
 assert.doesNotMatch(JSON.stringify(result),/보습|미백|실제 구매/);
});

test('504, malformed output and invented product/fact IDs fall back to validated recommendations',async()=>{
 for(const output of [new Error('LLM http 504'),'not json',JSON.stringify({recommendations:[{productId:'invented',variantId:'v-mask',factIds:['budget'],reviewClaims:[]}]}),
   JSON.stringify({recommendations:[{productId:'p-mask',variantId:'v-mask',factIds:['cures-acne'],reviewClaims:[]}]})]){
   const respond=createLlmGroundedResponder({async chat(){if(output instanceof Error)throw output;return {content:output};}});
   const result=await respond({originalQuestion:'마스크팩 추천',ranking:ranking(),evidence:[],plan,mode:'RECOMMEND'} as never);
   assert.equal(result.kind,'VERIFIED_CANDIDATES');assert.equal(result.items.length,1);
   assert.equal(result.items[0].totalPriceWon,13000);assert.ok(result.items[0].reason);
   if(output instanceof Error)assert.equal(result.failure?.httpStatus,504);
   assert.doesNotMatch(JSON.stringify(result),/invented|cures-acne/);
 }
});

test('recommendation review summaries require exact product, variant, version and quotation',async()=>{
 const proof:EvidenceRecord={id:'e1',sourceId:'review-1',productId:'p-mask',variantId:null,kind:'REVIEW',sourceKind:'SYNTHETIC',
   verified:true,datasetVersion:'fixture-quality',text:'포장이 개별로 되어 있어 휴대하기 편했어요.'};
 for(const wrongProduct of [false,true]){
   const respond=createLlmGroundedResponder({async chat(){return {content:JSON.stringify({recommendations:[{productId:'p-mask',variantId:'v-mask',factIds:['budget'],
     reviewClaims:[{sourceKind:'SYNTHETIC',productId:wrongProduct?'other':'p-mask',variantId:'v-mask',sourceId:'review-1',quote:proof.text,polarity:'PRO',claim:'휴대하기 편했다는 의견이에요.'}]}]})};}});
   const result=await respond({originalQuestion:'마스크팩 추천',ranking:ranking(),evidence:[proof],plan,mode:'RECOMMEND'} as never);
   assert.equal(result.kind,wrongProduct?'VERIFIED_CANDIDATES':'LLM_GROUNDED');
   assert.equal(result.citations?.length??0,wrongProduct?0:1);
   if(!wrongProduct){assert.equal(result.citations![0].sourceVariantId,null);assert.match(result.items[0].reason!,/합성 리뷰/);}
 }
});

test('internal catalog classification keys never become user-facing recommendation reasons',async()=>{
 const evidence:EvidenceRecord[]=[{id:'class',productId:'p-mask',variantId:'v-mask',kind:'SPEC',sourceKind:'SYNTHETIC',verified:true,datasetVersion:'fixture-quality',sourceRef:'comparison_family',text:'마스크팩'}];
 const respond=createLlmGroundedResponder({async chat(messages){
   const facts=JSON.parse(messages[1].content!).candidates[0].facts;
   assert.equal(facts.some((f:{text:string})=>f.text.includes('comparison_family')),false);
   return {content:JSON.stringify({recommendations:[{productId:'p-mask',variantId:'v-mask',factIds:['budget'],reviewClaims:[]}]})};
 }});
 assert.equal((await respond({originalQuestion:'마스크팩 추천',ranking:ranking(),evidence,plan,mode:'RECOMMEND'})).kind,'LLM_GROUNDED');
});

test('retrieval receives explicit preferences and scoped approved Memory without default invention',async()=>{
 const requests:any[]=[];const memory=(key:Preference['key'],value:Preference['value']):Preference=>({userId:'tester_05',key,value,sourceConversationId:'c',sourceMessageId:'m',updatedAt:'2026-10-20'});
 const req={actorUserId:'tester_05',conversationId:'c',requestId:'r',clientActionId:'a',userMessage:'마스크팩 추천'};
 const deps={retriever:{async search(input:unknown){requests.push(input);return {candidates:[],evidence:[]};}}} as never;
 await retrieveTurn(req,{messageId:'m',memories:[],startedAt:performance.now(),memoryMs:0},plan,deps);
 assert.deepEqual(requests[0].preferences,[]);
 await retrieveTurn(req,{messageId:'m',memories:[memory('price_priority','performance'),memory('eye_comfort','important')],startedAt:performance.now(),memoryMs:0},
   {...plan,currentPreferences:{price_priority:'value'},attributePreferences:['portability'],interview:{answered:['purpose'],pending:[],purpose:'선물용'}},deps);
 assert.deepEqual(requests[1].preferences,['가성비 중심','portability','선물용']);
 assert.equal(requests[1].maxTotalWon,20000);assert.deepEqual(requests[1].requiredConditions,[]);
 await retrieveTurn(req,{messageId:'m',memories:[memory('price_priority','performance')],startedAt:performance.now(),memoryMs:0},plan,deps);
 assert.deepEqual(requests[2].preferences,['성능 중심']);
});

test('named product request searches immediately and preserves its explicit budget and query',async()=>{
 let searches=0,calls=0;
 const graph=createPersistentResearchGraph({clarifyBeforeSearch:true,fastResponses:false,
   conversations:{assertOwned:async()=>{},appendUserMessage:async(_a,_c,id)=>id},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
   route:async()=>({kind:'SHOPPING_SEARCH',search:true}),
   intent:{extract:async()=>({query:'마스크팩',context:{maxTotalWon:20000,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async(input)=>{searches++;assert.equal(input.query,'마스크팩');assert.equal(input.maxTotalWon,20000);return {candidates:[product],evidence:[]};}}},new MemorySaver() as never,undefined,undefined,
   createLlmGroundedResponder({async chat(){calls++;return {content:JSON.stringify({recommendations:[{productId:'p-mask',variantId:'v-mask',factIds:['price'],reviewClaims:[]}]})};}}));
 const request={actorUserId:'tester_05',conversationId:'quality-c',requestId:'quality-r',clientActionId:'first',userMessage:'마스크팩 2만원 이하 추천해줘'};
 const result=await graph.invoke(request);
 assert.equal(result.explanation!.kind,'LLM_GROUNDED');assert.deepEqual([searches,calls],[1,1]);
 assert.deepEqual(result.explanation!.items.map(item=>[item.productId,item.variantId,item.totalPriceWon]),[['p-mask','v-mask',13000]]);
 assert.match(result.explanation!.items[0].reason!,/13,000원|예산/);
 assert.equal(result.shoppingPlan!.query,'마스크팩');assert.equal(result.shoppingPlan!.maxTotalWon,20000);
 const skipped=interviewAnswer('상관없어요',{...result.shoppingPlan!,interview:{answered:[],pending:['budget']}})!;
 assert.equal(skipped.query,'마스크팩');assert.equal(skipped.maxTotalWon,20000);
 await graph.invoke(request);assert.deepEqual([searches,calls],[1,1]);
});
