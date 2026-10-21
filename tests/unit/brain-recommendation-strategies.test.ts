import test from "node:test";
import assert from "node:assert/strict";
import {curateRecommendations,meetsV07ReviewBar} from "../../src/brain/recommendation-strategies.ts";
import {readCommerceActivity} from "../../src/brain/commerce-signals.ts";
import type {RankedCandidate,RankingResult} from "../../src/brain/contracts.ts";
function row(id:string,score:number,rating:number|null,count:number|null,verified=true):RankedCandidate{
 return {candidate:{productId:id,variantId:"v-"+id,unitPriceWon:10000,shippingFeeWon:3000,rating,
 ratingScale:5,wholeReviewCount:count,wholeReviewCountVerified:verified,conditions:{},facets:{},commerceVerified:true},
 score,evidenceCoverage:1,missingAspects:[],effectivePreferences:{price_priority:"balanced",eye_comfort:"normal",noise_sensitivity:"normal"}};
}
function ranking(...r:RankedCandidate[]):RankingResult{return {ranked:r,referenceOnly:[],rejected:[],evaluatedCount:r.length};}
test("cart and wishlist are strong bounded preference signals; strict A slot uses only verified whole counts",()=>{
 const result=curateRecommendations(ranking(row("popular",.75,4.9,120),row("saved",.58,null,null),row("cheap",.51,4.8,2)),{
 wishlistProductIds:["saved"],cartProductIds:["saved"]});
 assert.deepEqual(result.ranked.slice(0,3).map(x=>x.candidate.productId),["saved","popular","cheap"]);
 assert.deepEqual(result.ranked.slice(0,3).map(x=>x.recommendationRole),["PERSONALIZED","REVIEW_VERIFIED","ALTERNATIVE"]);
 assert.deepEqual(result.ranked[0].personalizationSignals,["CART","WISHLIST"]);
 assert.equal(result.ranked[0].candidate.wholeReviewCount,null);
});
test("no verified rating/count cannot create a review-verified recommendation; do not invent 3 products",()=>{
 const result=curateRecommendations(ranking(row("one",.9,null,null),row("two",.8,4.8,1)));
 assert.deepEqual(result.ranked.map(x=>x.recommendationRole),["PERSONALIZED","ALTERNATIVE"]);
 assert.equal(meetsV07ReviewBar(row("one",.9,4.9,100,false)),false);
 assert.equal(meetsV07ReviewBar(row("one",.9,3.5,10)),false);
 assert.equal(meetsV07ReviewBar(row("one",.9,3.6,10)),true);
});
test("dedupe product IDs even if multiple variants are retrieved and preserve hard rejections",()=>{
 const rejected={candidate:row("excluded",1,5,100).candidate,reasons:["over_total_budget"]};
 const results=curateRecommendations({...ranking(row("same",.6,4.9,100),row("same",.5,4.8,120),row("other",.4,4.1,15)),rejected:[rejected]});
 assert.deepEqual(results.ranked.map(x=>x.candidate.productId),["same","other"]);
 assert.deepEqual(results.rejected,[rejected]);
});
test("SQL activity lookup is actor-scoped and read-only",async()=>{
 const calls:{query:string;args:unknown[]}[]=[];
 const db={unsafe:async(q:string,args:unknown[] = [])=>{calls.push({query:q,args});return [{product_id:"p-a"}];}};
 const result=await readCommerceActivity(db as never,"tester_05");
 assert.deepEqual(result,{wishlistProductIds:["p-a"],cartProductIds:["p-a"]});
 assert.equal(calls.length,3);
 assert.ok(calls.every(c=>/^SELECT /i.test(c.query)));
 assert.ok(calls.filter(c=>c.args.length).every(c=>c.args[0]==="tester_05"));
 await assert.rejects(()=>readCommerceActivity(db as never,""),/invalid activity actor/);
});

test("purchase interest reads confirmed orders only when the signed-in DB role can read them",async()=>{
 const queries:string[]=[];
 const db={unsafe:async(q:string,args?:unknown[])=>{
  queries.push(q);
  if(q.includes("has_table_privilege"))return [{can_read:true}];
  if(q.includes("FROM orders o")){assert.equal(args?.[0],"tester_05");assert.match(q,/o\.status='CONFIRMED'/);return [{product_id:"p-purchased"}];}
  return [{product_id:"p-saved"}];
 }};
 const result=await readCommerceActivity(db as never,"tester_05");
 assert.deepEqual(result.purchasedProductIds,["p-purchased"]);
 assert.equal(queries.length,4);
});
