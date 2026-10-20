import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createFastIntentPort} from "../../src/brain/fast-intent.ts";
import {resolveTurnPlan,type ResearchDeps} from "../../src/brain/read-flow.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import type {ShoppingPlan} from "../../src/brain/shopping-plan.ts";
const candidate=(id:string,price:number)=>({productId:id,variantId:"v-"+id,productName:"세럼 "+id,
 unitPriceWon:price,shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,
 wholeReviewCountVerified:false,conditions:{},facets:{},sourceKind:"REAL",commerceVerified:true,datasetVersion:"cancel"});
const requests=["그냥 추천해줘","그냥 추천해주세요","정렬 없이 추천","순서 상관없이 보여줘"];
const previous:ShoppingPlan={query:"세럼",revision:3,minTotalWon:10000,maxTotalWon:39999,
 requiredConditions:["fragrance_free"],currentPreferences:{price_priority:"performance"},priceSortOrder:"DESC"};
const req=(userMessage:string)=>({actorUserId:"actor",conversationId:crypto.randomUUID(),requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage});
const prepared=()=>({messageId:crypto.randomUUID(),memories:[],memoryMs:0,startedAt:performance.now()});
const fallback={extract:async()=>{throw Error("pure cancellation must not reach the model");}};
for(const message of requests)test("QA09 pure cancellation preserves task: "+message,async()=>{
 const plan=await resolveTurnPlan(req(message),prepared(),previous,{intent:createFastIntentPort(fallback)} as ResearchDeps);
 assert.equal(plan.query,"세럼");assert.equal(plan.maxTotalWon,39999);assert.equal(plan.minTotalWon,10000);
 assert.deepEqual(plan.requiredConditions,["fragrance_free"]);assert.deepEqual(plan.currentPreferences,previous.currentPreferences);
 assert.equal(plan.priceSortOrder,undefined);assert.equal(plan.reviewSortAspect,undefined);
 const review=await resolveTurnPlan(req(message),prepared(),{...previous,priceSortOrder:undefined,reviewSortAspect:"촉촉"},{intent:createFastIntentPort(fallback)} as ResearchDeps);
 assert.equal(review.reviewSortAspect,undefined);assert.equal(review.query,"세럼");
});

test("QA09 actual Fast Intent plus LangGraph keeps range across cancel and resumes personalization",async()=>{
 let calls=0;
 const intent=createFastIntentPort({extract:async()=>{calls++;return {query:"세럼",queryMode:"SET",budgetMode:"SET",requirementsMode:"REPLACE",context:{maxTotalWon:39999,requiredConditions:[],currentPreferences:{}}};}});
 const graph=createPersistentResearchGraph({intent,
 conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[]},
 activity:async()=>({cartProductIds:["expensive"],wishlistProductIds:["expensive"]}),
 retriever:{search:async()=>({candidates:[candidate("cheap",16000),candidate("expensive",26000)],evidence:[]})}
 } as unknown as ResearchDeps,new MemorySaver() as never);
 const conversationId=crypto.randomUUID();const run=(message:string)=>graph.invoke({...req(message),conversationId});
 await run("1~3만원대 세럼 추천해줘");
 const desc=await run("가격 높은 순");assert.equal(desc.shoppingPlan?.priceSortOrder,"DESC");
 const asc=await run("가격 낮은 순");assert.equal(asc.ranking.ranked[0].candidate.productId,"cheap");
 for(const message of requests){const r=await run(message);assert.equal(r.shoppingPlan?.query,"세럼");
 assert.equal(r.shoppingPlan?.maxTotalWon,39999);assert.equal(r.shoppingPlan?.minTotalWon,10000);
 assert.equal(r.shoppingPlan?.priceSortOrder,undefined);assert.equal(r.ranking.ranked[0].candidate.productId,"expensive");}
 assert.equal(calls,1);
});

test("QA09 a genuinely new product with 그냥 is not captured as sort cancellation",async()=>{
 const fast=createFastIntentPort({extract:async()=>({query:"커피",queryMode:"SET",budgetMode:"CLEAR",requirementsMode:"CLEAR",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})});
 const next=await resolveTurnPlan(req("그냥 커피 추천해줘"),prepared(),previous,{intent:fast} as ResearchDeps);
 assert.notEqual(next.query,"세럼");assert.equal(next.priceSortOrder,undefined);
});


test("QA09 new product request simply strips discourse 그냥 without retaining the prior task",async()=>{
 const fast=createFastIntentPort({extract:async()=>{throw Error("simple product uses fast path");}});
 const next=await resolveTurnPlan(req("그냥 커피 추천해줘"),prepared(),previous,{intent:fast} as ResearchDeps);
 assert.equal(next.query,"커피");assert.equal(next.maxTotalWon,null);
});
