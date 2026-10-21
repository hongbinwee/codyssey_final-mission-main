import test from "node:test";
import assert from "node:assert/strict";
import {buildAgentDecisionContext} from "../../src/brain/agent-context.ts";
import {decideHermesAction} from "../../src/brain/hermes-agent-step.ts";
import type {ShoppingPlan} from "../../src/brain/shopping-plan.ts";
const plan:ShoppingPlan={
 query:"남성용 팬티",revision:3,category:"fashion",maxTotalWon:30000,minTotalWon:10000,
 requiredConditions:["남성용"],currentPreferences:{price_priority:"balanced"},
 attributePreferences:["breathability"],
 interview:{answered:["budget","purpose"],pending:[],purpose:"운동용",budgetStatus:"SET"},
 lastDisplayedProductIds:["p-1","p-2"],lastDisplayedProducts:[
 {displayIndex:1,productId:"p-1",variantId:"v-1",name:"첫 번째 팬티",commerceVerified:true},
 {displayIndex:2,productId:"p-2",variantId:"v-2",name:"두 번째 팬티",commerceVerified:true}
 ],excludedProductIds:["p-old"],priceSortOrder:"ASC"
};
test("bounded context retains purpose, preferences, hard conditions and verified display order",()=>{
 const data=buildAgentDecisionContext({message:"두 번째 단점",plan,task:null,memories:[],observations:[],
 displayedProducts:plan.lastDisplayedProducts});
 assert.equal(data.current_shopping_plan?.purpose,"운동용");
 assert.deepEqual(data.current_shopping_plan?.attributePreferences,["breathability"]);
 assert.deepEqual(data.current_shopping_plan?.requiredConditions,["남성용"]);
 assert.equal(data.current_shopping_plan?.maxTotalWon,30000);
 assert.equal(data.previous_displayed_products[1]?.productId,"p-2");
});
test("model cannot receive unverified displayed product IDs",()=>{
 const data=buildAgentDecisionContext({message:"상세",task:null,memories:[],observations:[],
 displayedProducts:[{displayIndex:1,productId:"bad",variantId:"v-bad",name:"다른 상품",commerceVerified:false}]});
 assert.deepEqual(data.previous_displayed_products,[]);
});
test("verified prior product can be passed to review Tool without fabricated IDs",async()=>{
 const decision=await decideHermesAction({
 provider:{chat:async messages=>{
   const ctx=JSON.parse(messages.at(-1)?.content??"{}");
   assert.equal(ctx.previous_displayed_products[1].productId,"p-2");
   assert.equal(ctx.current_shopping_plan.purpose,"운동용");
   return {content:null,tool_calls:[{id:"reviews",name:"get_product_reviews",
    arguments:'{"product_id":"p-2","query":"통풍"}'}]};
 }},
 message:"그중 2번의 통풍 리뷰",plan,task:null,memories:[],observations:[],
 displayedProducts:plan.lastDisplayedProducts,
 tools:{purchases:async()=>[],search:async()=>({products:[]}),reviews:async()=>({totalMatching:0,reviews:[]})},
 offerSearch:true,startedAt:Date.now()
 });
 assert.equal(decision.kind,"CALL");
 if(decision.kind==="CALL")assert.equal(decision.action.args.productId,"p-2");
});
test("unknown IDs are rejected even with prior product snapshot",async()=>{
 const decision=await decideHermesAction({
 provider:{chat:async()=>({content:null,tool_calls:[{id:"fake",name:"get_product_reviews",
 arguments:'{"product_id":"other-user-product"}'}]})},
 message:"리뷰",plan,task:null,memories:[],observations:[],displayedProducts:plan.lastDisplayedProducts,
 tools:{purchases:async()=>[],search:async()=>({products:[]}),reviews:async()=>({totalMatching:0,reviews:[]})},
 offerSearch:true,startedAt:Date.now()
 });
 assert.deepEqual(decision,{kind:"FINISH",reason:"INVALID"});
});
