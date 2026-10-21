import test from "node:test";
import assert from "node:assert/strict";
import {rankProducts} from "../../src/brain/personalization.ts";
const candidate={productId:"p",variantId:"v",productName:"Verified product",commerceVerified:true,
 unitPriceWon:10000,shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{},sourceKind:"REAL" as const};
const ctx={maxTotalWon:20000,requiredConditions:[],currentPreferences:{}};
test("rating and review-count absence or low values are ranking signals, not mandatory qualification",()=>{
 for(const p of [candidate,{...candidate,rating:2,ratingScale:5,wholeReviewCount:2,wholeReviewCountVerified:true}]){
  const r=rankProducts([p],[],ctx,[]);assert.equal(r.ranked.length,1);
  assert.equal(r.ranked[0].candidate.rating,p.rating);
 }
});
test("hard constraints, identity and source separation remain enforced",()=>{
 assert.equal(rankProducts([{...candidate,unitPriceWon:25000}],[],ctx,[]).rejected.length,1);
 assert.equal(rankProducts([candidate],[],{...ctx,requiredConditions:["waterproof"]},[]).rejected.length,1);
 assert.equal(rankProducts([{...candidate,commerceVerified:false}],[],ctx,[]).ranked.length,0);
 assert.equal(rankProducts([{...candidate,sourceKind:"SYNTHETIC",isSimulated:true}],[],ctx,[]).ranked.length,0);
});
