import test from "node:test";
import assert from "node:assert/strict";
import {captureDisplayedReviewTargets,resolveDisplayedReviewTargets} from "../../src/brain/review-targets.ts";
import {resolveShoppingPlan,type ShoppingPlan} from "../../src/brain/shopping-plan.ts";
import type {RankingResult} from "../../src/brain/contracts.ts";
const candidate=(productId:string,verified=true)=>({productId,variantId:"v-"+productId,
 productName:"상품 "+productId,commerceVerified:verified,unitPriceWon:10000,shippingFeeWon:0,
 rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{}});
const row=(id:string,verified=true):RankingResult["ranked"][number]=>({candidate:candidate(id,verified),
 score:1,evidenceCoverage:1,missingAspects:[],effectivePreferences:{} as never});
test("QA13 P1 captures actual display positions, not undisplayed candidates",()=>{
 const ranking:RankingResult={ranked:[row("a"),row("b"),row("hidden"),row("c")],
  referenceOnly:[{candidate:candidate("reference",true),reasons:[]}],rejected:[],evaluatedCount:5};
 const explanation={kind:"VERIFIED_CANDIDATES" as const,items:[
  {productId:"a",variantId:"v-a",name:"상품 a",totalPriceWon:10000,evidenceIds:[],indicators:[]},
  {productId:"b",variantId:"v-b",name:"상품 b",totalPriceWon:10000,evidenceIds:[],indicators:[]}
 ],text:"",limitations:[]};
 const displayed=captureDisplayedReviewTargets(ranking,explanation);
 assert.deepEqual(displayed.map(x=>[x.displayIndex,x.productId,x.variantId]),[
  [1,"a","v-a"],[2,"b","v-b"],[3,"reference","v-reference"]]);
 assert.deepEqual(resolveDisplayedReviewTargets(displayed,[2],false)?.map(x=>x.productId),["b"]);
 assert.deepEqual(resolveDisplayedReviewTargets(displayed,undefined,true)?.map(x=>x.productId),["a","b","reference"]);
});
test("QA13 P1 rejects unverified references and guessed ranks",()=>{
 const rows=captureDisplayedReviewTargets({ranked:[row("a")],referenceOnly:[{candidate:candidate("b",false),reasons:[]}],
  rejected:[],evaluatedCount:2},{kind:"VERIFIED_CANDIDATES",items:[
   {productId:"a",variantId:"v-a",name:"상품 a",totalPriceWon:10000,evidenceIds:[],indicators:[]}],text:"",limitations:[]});
 assert.equal(resolveDisplayedReviewTargets(rows,[2],false),null);
 assert.equal(resolveDisplayedReviewTargets(rows,[3],false),null);
 assert.equal(resolveDisplayedReviewTargets(rows,[1,1],false),null);
});
test("QA13 P1 retains snapshot on same shopping task and clears on new discovery",()=>{
 const snapshot=[{displayIndex:1,productId:"a",variantId:"v-a",name:"상품 a",commerceVerified:true}];
 const previous:ShoppingPlan={query:"수분크림",revision:2,maxTotalWon:30000,requiredConditions:[],
   currentPreferences:{},lastDisplayedProducts:snapshot,lastDisplayedProductIds:["a"]};
 const keep=resolveShoppingPlan(previous,{query:"수분크림",queryMode:"KEEP",budgetMode:"KEEP",
   context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}});
 assert.deepEqual(keep.lastDisplayedProducts,snapshot);
 const other=resolveShoppingPlan(previous,{query:"로션",queryMode:"SET",budgetMode:"CLEAR",
   context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}});
 assert.equal(other.lastDisplayedProducts,undefined);
 assert.equal(other.lastDisplayedProductIds,undefined);
});
