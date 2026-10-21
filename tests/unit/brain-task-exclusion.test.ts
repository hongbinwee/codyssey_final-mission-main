import test from "node:test";
import assert from "node:assert/strict";
import {resolveTurnPlan,retrieveTurn} from "../../src/brain/read-flow.ts";
import type {ShoppingPlan} from "../../src/brain/shopping-plan.ts";
const prev:ShoppingPlan={query:"에센스",maxTotalWon:30000,minTotalWon:20000,requiredConditions:[],currentPreferences:{},revision:1,lastDisplayedProductIds:["p-a","p-b"],excludedProductIds:[]};
const row=(id:string)=>({productId:id,variantId:"v-"+id,productName:id,commerceVerified:true,unitPriceWon:23000,shippingFeeWon:3000,rating:4.5,ratingScale:5,wholeReviewCount:30,wholeReviewCountVerified:true,conditions:{},facets:{},sourceKind:"REAL" as const});
const prepared={messageId:"msg",memories:[],startedAt:performance.now(),memoryMs:0};
const req=(userMessage:string)=>({actorUserId:"tester_05",conversationId:"c",requestId:"r",clientActionId:"a",userMessage});
const deps={conversations:{assertOwned:async()=>{},appendUserMessage:async()=>""},memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("should not invoke model for explicit rejection");}},
 retriever:{search:async()=>({candidates:[row("p-a"),row("p-b"),row("p-c")],evidence:[]})},
 activity:async()=>({wishlistProductIds:["p-a"],cartProductIds:["p-a"]})};
test("exclude button rejects exactly the last shown product, preserves other purchase requirements",async()=>{
 const plan=await resolveTurnPlan(req("이 상품 제외: p-a"),prepared,prev,deps as never);
 assert.deepEqual(plan.excludedProductIds,["p-a"]);assert.equal(plan.maxTotalWon,30000);
 assert.equal(plan.minTotalWon,20000);assert.equal(plan.query,"에센스");
 const result=await retrieveTurn(req("이 상품 제외: p-a"),prepared,plan,deps as never);
 assert.ok(result.result.ranking.ranked.every(r=>r.candidate.productId!=="p-a"));
 assert.deepEqual(result.result.shoppingPlan?.lastDisplayedProductIds,["p-b","p-c"]);
 assert.ok(result.result.ranking.rejected.some(r=>r.candidate.productId==="p-a"&&r.reasons.includes("user_excluded")));
});
test("exclude all only uses previously displayed cards and never accepts invented product IDs",async()=>{
 const all=await resolveTurnPlan(req("다른 제품 보기"),prepared,prev,deps as never);
 assert.deepEqual(all.excludedProductIds,["p-a","p-b"]);
 const ignored=await resolveTurnPlan(req("이 상품 제외: p-unknown"),prepared,prev,{...deps,intent:{extract:async()=>({
  query:"에센스",queryMode:"KEEP",budgetMode:"KEEP",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}
 })}} as never);
 assert.deepEqual(ignored.excludedProductIds,[]);
});
