import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import type {ResearchDeps} from '../../src/brain/read-flow.ts';
import type {ProductCandidate} from '../../src/brain/contracts.ts';
import {purchaseSnapshots} from '../../src/brain/purchase-history.ts';

test('Hermes purchase snapshots bind the authenticated actor and include only confirmed orders',async()=>{
 const snapshots=await purchaseSnapshots({unsafe:async(query:string,params:unknown[])=>{
  assert.match(query,/o\.user_id=\$1 AND o\.status='CONFIRMED'/);assert.deepEqual(params,['actor-1']);
  return [{product_id:'past',variant_id:'old',product_name_snapshot:'기존 상품',category:'fashion',unit_price_won:20000,purchased_at:'2026-10-20'}];
 }} as never,'actor-1');
 assert.equal(snapshots[0].category,'fashion');assert.equal(snapshots[0].unitPriceWon,20000);
});
for(const timeout of [false,true])test(`Hermes enforces prior purchase price and review constraints with deep timeout=${timeout}`,async()=>{
 const candidate=(id:string,price:number):ProductCandidate=>({productId:id,variantId:'v-'+id,productName:id,unitPriceWon:price,shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{},sourceKind:'REAL',commerceVerified:true});
 let historyCalls=0;
 const deps={conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[]},
  intent:{extract:async()=>({query:'니플패치',context:{category:'beauty',maxTotalWon:50000,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async(input:{query:string})=>{assert.equal(input.query,'니플패치');assert.equal((input as {category?:string}).category,'fashion');return {candidates:[candidate('past',20000),candidate('cheaper',10000),candidate('expensive',25000),candidate('few-reviews',9000)],evidence:[]};}},
  hermes:{provider:{chat:async()=>{if(timeout)throw new Error('LLM timeout');return {content:'done'};}},
   history:async(actor:string)=>{assert.equal(actor,'actor-1');historyCalls++;return [{productId:'past',variantId:'v-past',productName:'기존 니플패치 상품',category:'fashion',unitPriceWon:20000,purchasedAt:'2026-10-20'}];},
   reviewCount:async(id:string)=>id==='past'?100:id==='few-reviews'?10:200}
 } as unknown as ResearchDeps;
 const graph=createPersistentResearchGraph(deps,new MemorySaver() as never);
 const result=await graph.invoke({actorUserId:'actor-1',conversationId:crypto.randomUUID(),requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage:'전에 산 것보다 저렴하고 리뷰 많은 니플패치 추천'});
 assert.deepEqual(result.ranking.ranked.map(x=>x.candidate.productId),['cheaper']);assert.ok(historyCalls>0);
});
