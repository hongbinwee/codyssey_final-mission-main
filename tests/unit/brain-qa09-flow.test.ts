import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import type {EvidenceRecord,ProductCandidate} from '../../src/brain/contracts.ts';
import {parseKrwTenThousandBand} from '../../src/brain/price-band.ts';
import {rankProducts} from '../../src/brain/personalization.ts';
import {curateRecommendations} from '../../src/brain/recommendation-strategies.ts';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {assembleIntentContext} from '../../src/brain/context.ts';
import {serviceRequestRoute} from '../../src/brain/routing.ts';
const sort={aspect:'moisturizing',direction:'MOST_POSITIVE' as const};
const plan={query:'마스크팩',minTotalWon:10000,maxTotalWon:39999,requiredConditions:[],currentPreferences:{},revision:1};
const item=(id:string,price:number,shipping:number|null=0):ProductCandidate=>({productId:id,variantId:id+'-v',productName:'마스크팩 '+id,
 unitPriceWon:price,shippingFeeWon:shipping,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{},commerceVerified:true,sourceKind:'REAL',datasetVersion:'qa09'});
const review=(product:string,source:string,text='촉촉해서 만족스러워요.',chunk=source):EvidenceRecord=>({id:chunk,sourceId:source,
 productId:product,variantId:null,kind:'REVIEW',sourceKind:'REAL',verified:true,datasetVersion:'qa09',text});
const sample=[review('a','a1'),review('a','a2'),review('b','b1'),review('b','b2'),review('b','b3')];
test('QA09-01: single 2만원대 remains 20000..29999',()=>assert.deepEqual(parseKrwTenThousandBand('2만원대 상품 추천'),{minTotalWon:20000,maxTotalWon:29999}));
test('QA09-02: range 1~3만원대 is exactly 10000..39999',()=>assert.deepEqual(parseKrwTenThousandBand('1~3만원대 상품 추천'),{minTotalWon:10000,maxTotalWon:39999}));
test('QA09-03: 28000 plus 3000 shipping is accepted as 31000 total',()=>{
 const result=rankProducts([item('a',28000,3000)],[],plan,[]);assert.equal(result.ranked.length,1);
 assert.equal(result.ranked[0].candidate.unitPriceWon!+result.ranked[0].candidate.shippingFeeWon!,31000);
});
test('QA09-04: 39000 plus 3000 shipping is outside the range',()=>{
 const result=rankProducts([item('a',39000,3000)],[],plan,[]);assert.equal(result.ranked.length,0);
 assert.ok(result.rejected[0].reasons.includes('over_total_budget'));
});
test('QA09-05: verified positive review count outranks cheaper products and cart affinity',()=>{
 const result=rankProducts([item('a',10000),item('b',28000,3000)],sample,{...plan,reviewSort:sort},[]);
 assert.equal(result.explicitReviewSort?.status,'APPLIED');assert.equal(result.ranked[0].candidate.productId,'b');
 const curated=curateRecommendations(result,{wishlistProductIds:['a'],cartProductIds:['a']});
 assert.equal(curated.ranked[0].candidate.productId,'b');
});
test('QA09-06: three chunks from one original review count once',()=>{
 const evidence=[...sample,review('b','b1',undefined,'b1-chunk2'),review('b','b1',undefined,'b1-chunk3')];
 const result=rankProducts([item('a',10000),item('b',20000)],evidence,{...plan,reviewSort:sort},[]);
 assert.equal(result.ranked.find(r=>r.candidate.productId==='b')?.reviewSortEvidence?.positiveCount,3);
});
test('QA09-07: 촉촉하지 않아요 is not positive; product/variant/version boundaries hold',()=>{
 const evidence=[...sample,review('b','negative','촉촉하지 않아요. 아쉬워요.'),
  {...review('a','wrong-variant'),variantId:'b-v'},{...review('a','old-version'),datasetVersion:'old'}];
 const result=rankProducts([item('a',10000),item('b',20000)],evidence,{...plan,reviewSort:sort},[]);
 const a=result.ranked.find(r=>r.candidate.productId==='a')!,b=result.ranked.find(r=>r.candidate.productId==='b')!;
 assert.equal(a.reviewSortEvidence?.positiveCount,2);assert.equal(b.reviewSortEvidence?.positiveCount,3);
 assert.ok((b.reviewSortEvidence?.negativeCount??0)>0);
});
test('QA09-08: missing reviews cannot establish an explicit review ordering',()=>{
 const result=rankProducts([item('a',10000),item('b',20000)],[],{...plan,reviewSort:sort},[]);
 assert.equal(result.explicitReviewSort?.status,'INSUFFICIENT');
 assert.ok(result.ranked.every(r=>!r.reviewSortEvidence||r.reviewSortEvidence.positiveCount===0));
});
test('QA09-09: without explicit sorting, existing personalization curation is unchanged',()=>{
 const result=rankProducts([item('a',10000),item('b',20000)],sample,plan,[]);
 assert.equal(result.explicitReviewSort,undefined);
 const personalized=curateRecommendations(result,{wishlistProductIds:['b'],cartProductIds:['b']});
 assert.equal(personalized.ranked[0].candidate.productId,'b');
});
test('QA09-10: graph/checkpoint keeps budget and sort, and explicit changes replace them',async()=>{
 assert.equal(serviceRequestRoute('리뷰 정렬 취소'),undefined);
 assert.equal(serviceRequestRoute('내 주문 취소')?.kind,'CS_REQUEST');
 const requests:Record<string,unknown>[]=[];
 const graph=createPersistentResearchGraph({clarifyBeforeSearch:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async(_u,_c,id)=>id},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
  route:async()=>({kind:'SHOPPING_FOLLOWUP',search:true}),
  intent:{extract:async(_m,_memory,previous)=>({query:'마스크팩',queryMode:previous?'KEEP':'SET',budgetMode:previous?'KEEP':'CLEAR',
   context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async(input)=>{requests.push({...input});return {candidates:[item('a',10000),item('b',20000)],evidence:sample};}}},new MemorySaver() as never);
 const turn=(message:string,id:string)=>graph.invoke({actorUserId:'qa09-only',conversationId:'qa09-flow',requestId:id,clientActionId:id,userMessage:message});
 const first=await turn('1~3만원대에서 촉촉하다는 리뷰가 많은 순으로 마스크팩 추천해줘','first');
 assert.deepEqual([first.shoppingPlan?.minTotalWon,first.shoppingPlan?.maxTotalWon],[10000,39999]);
 assert.equal(first.ranking.explicitReviewSort?.status,'APPLIED');
 const next=await turn('다른 상품도 보여줘','followup');assert.deepEqual(next.shoppingPlan?.reviewSort,first.shoppingPlan?.reviewSort);
 assert.deepEqual([next.shoppingPlan?.minTotalWon,next.shoppingPlan?.maxTotalWon],[10000,39999]);
 const beforeUnsupported=requests.length,unsupported=await turn('촉촉함 부정 리뷰가 많은 순으로','unsupported');
 assert.equal(requests.length,beforeUnsupported);assert.equal(unsupported.intentKind,'UNCERTAIN');
 assert.match(unsupported.explanation!.text,/아직 제공하지 않아요/);assert.deepEqual(unsupported.shoppingPlan,next.shoppingPlan);
 const changed=await turn('2만원대로 바꿔줘','price');assert.deepEqual([changed.shoppingPlan?.minTotalWon,changed.shoppingPlan?.maxTotalWon],[20000,29999]);
 assert.deepEqual(changed.shoppingPlan?.reviewSort,sort);
 const reSorted=await turn('사용감 긍정 리뷰가 많은 순으로 바꿔줘','sort-change');
 assert.equal(reSorted.shoppingPlan?.reviewSort?.aspect,'comfort');
 assert.deepEqual([reSorted.shoppingPlan?.minTotalWon,reSorted.shoppingPlan?.maxTotalWon],[20000,29999]);
 const cleared=await turn('리뷰 정렬 취소','sort-clear');assert.equal(cleared.shoppingPlan?.reviewSort,undefined);
 assert.deepEqual([cleared.shoppingPlan?.minTotalWon,cleared.shoppingPlan?.maxTotalWon],[20000,29999]);
 assert.equal(requests[0].minTotalWon,10000);assert.equal(requests[1].maxTotalWon,39999);
 const context=JSON.parse(assembleIntentContext('다른 상품',[],changed.shoppingPlan!).untrustedUserContent);
 assert.equal(context.untrusted_previous_shopping_plan.minTotalWon,20000);assert.deepEqual(context.untrusted_previous_shopping_plan.reviewSort,sort);
});
test('QA09: unknown shipping never becomes free shipping or a budget-qualified recommendation',()=>{
 const result=rankProducts([item('a',10000,null)],[],plan,[]);assert.equal(result.ranked.length,0);
 assert.ok(result.rejected[0].reasons.includes('price_or_shipping_unverified'));
});
