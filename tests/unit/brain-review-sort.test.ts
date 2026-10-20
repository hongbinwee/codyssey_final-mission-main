import test from "node:test";
import assert from "node:assert/strict";
import {rankProducts} from "../../src/brain/personalization.ts";
import {curateRecommendations} from "../../src/brain/recommendation-strategies.ts";

const review=(id:string,sourceId:string,productId:string,text:string,extra:Record<string,unknown>={})=>({
 id,sourceId,productId,variantId:null,kind:"REVIEW",sourceKind:"REAL",verified:true,datasetVersion:"reviews-v1",text,...extra,
});
const item=(productId:string,rating:number,count:number)=>({
 productId,variantId:`${productId}-v1`,unitPriceWon:10000,shippingFeeWon:0,rating,ratingScale:5,
 wholeReviewCount:count,wholeReviewCountVerified:true,conditions:{},facets:{},sourceKind:"REAL",datasetVersion:"reviews-v1",commerceVerified:true,
});
const rank=(reviews:unknown[],reviewSort={aspect:"moisturizing",direction:"MOST_POSITIVE"})=>rankProducts(
 [item("p-a",3,2),item("p-b",5,100)] as never,
 reviews as never,
 {maxTotalWon:null,requiredConditions:[],currentPreferences:{},reviewSort} as never,
 [],
) as any;

test("explicit positive review sort precedes general score and deduplicates three chunks by sourceId",()=>{
 const result=rank([
  review("review-a1","source-a1","p-a","촉촉해서 만족스러워요."),
  review("review-a1-copy","source-a1","p-a","촉촉해서 만족스러워요."),
  review("review-a1-third","source-a1","p-a","촉촉해서 만족스러워요."),
  review("review-a2","source-a2","p-a","촉촉함이 좋아서 추천합니다."),
  review("review-b1","source-b1","p-b","촉촉하지 않아 아쉬워요."),
  review("review-b2","source-b2","p-b","보습이 부족해서 별로예요."),
 ]);
 assert.equal(result.ranked[0].candidate.productId,"p-a");
 assert.deepEqual(result.explicitReviewSort,{aspect:"moisturizing",status:"APPLIED",scope:"RETRIEVED_REVIEWS"});
 assert.deepEqual(result.ranked[0].reviewSortEvidence,{aspect:"moisturizing",positiveCount:2,negativeCount:0,reviewIds:["source-a1","source-a2"],sourceKinds:["REAL"]});
 assert.deepEqual(result.ranked[1].reviewSortEvidence,{aspect:"moisturizing",positiveCount:0,negativeCount:2,reviewIds:["source-b1","source-b2"],sourceKinds:["REAL"]});
});

test("recommendation curation preserves an applied explicit review order",()=>{
 const ranked=rank([
  review("review-a1","source-a1","p-a","촉촉해서 만족스러워요."),
  review("review-a2","source-a2","p-a","촉촉함이 좋아서 추천합니다."),
  review("review-b1","source-b1","p-b","촉촉하지 않아 아쉬워요."),
  review("review-b2","source-b2","p-b","보습이 부족해서 별로예요."),
 ]);
 const curated=curateRecommendations(ranked,{wishlistProductIds:["p-b"],cartProductIds:["p-b"],purchasedProductIds:["p-b"]});
 assert.deepEqual(curated.ranked.map((row:any)=>row.candidate.productId),["p-a","p-b"]);
});

test("invalid or source-conflicting review rows cannot inflate evidence",()=>{
 const result=rank([
  review("a-valid","source-a","p-a","촉촉해서 만족스러워요."),
  review("a-no-source-id","","p-a","촉촉해서 만족스러워요."),
  review("a-cross","source-cross","p-a","촉촉해서 만족스러워요."),
  review("b-cross","source-cross","p-b","촉촉해서 만족스러워요."),
  review("a-variant","source-variant","p-a","촉촉해서 만족스러워요.",{variantId:"different-variant"}),
  review("a-version","source-version","p-a","촉촉해서 만족스러워요.",{datasetVersion:"other-v1"}),
  review("a-unverified","source-unverified","p-a","촉촉해서 만족스러워요.",{verified:false}),
  review("a-wrong-source","source-wrong","p-a","촉촉해서 만족스러워요.",{sourceKind:"SYNTHETIC"}),
  review("b-valid1","source-b1","p-b","촉촉하지 않아 아쉬워요."),
  review("b-valid2","source-b2","p-b","보습이 부족해서 별로예요."),
 ]);
 assert.deepEqual(result.explicitReviewSort,{aspect:"moisturizing",status:"APPLIED",scope:"RETRIEVED_REVIEWS"});
 assert.equal(result.ranked[0].candidate.productId,"p-a","one verified source per compared product is enough");
 assert.deepEqual(result.ranked.find((row:any)=>row.candidate.productId==="p-a").reviewSortEvidence.reviewIds,["source-a"]);
 assert.equal(result.ranked.find((row:any)=>row.candidate.productId==="p-a").reviewSortEvidence.positiveCount,1);
});

test("only explicit positive review-count requests for bounded aspects are parsed",async()=>{
 const {parseExplicitReviewSort}=await import("../../src/brain/review-sort.ts");
 assert.deepEqual(parseExplicitReviewSort("촉촉하다는 긍정 리뷰가 많은 순으로 보여줘"),{aspect:"moisturizing",direction:"MOST_POSITIVE"});
 assert.deepEqual(parseExplicitReviewSort("촉촉함 긍정 후기 많은순"),{aspect:"moisturizing",direction:"MOST_POSITIVE"});
 assert.deepEqual(parseExplicitReviewSort("촉촉하다는 리뷰가 많은 순"),{aspect:"moisturizing",direction:"MOST_POSITIVE"});
 assert.deepEqual(parseExplicitReviewSort("촉촉한 리뷰가 많은순"),{aspect:"moisturizing",direction:"MOST_POSITIVE"});
 assert.deepEqual(parseExplicitReviewSort("촉촉함 리뷰가 많은 순"),{aspect:"moisturizing",direction:"MOST_POSITIVE"});
 assert.deepEqual(parseExplicitReviewSort("배터리 긍정 후기가 많은 순"),{aspect:"battery_life",direction:"MOST_POSITIVE"});
 assert.equal(parseExplicitReviewSort("촉촉하지 않은 리뷰가 많은 순"),undefined);
 assert.equal(parseExplicitReviewSort("촉촉한 게 아니라 리뷰가 많은 순"),undefined);
 assert.equal(parseExplicitReviewSort("촉촉한 부정 리뷰가 많은 순"),undefined);
 assert.equal(parseExplicitReviewSort("촉촉한 리뷰가 적은 순"),undefined);
 assert.equal(parseExplicitReviewSort("진정력 긍정 리뷰가 많은 순"),undefined);
 assert.equal(parseExplicitReviewSort("Acme 브랜드 리뷰가 많은 순"),undefined);
 assert.equal(parseExplicitReviewSort("가격 낮은 순"),undefined);
});

test("canonical and original Korean aspect names share a stable display label and conservative polarity",async()=>{
 const {normalizeReviewSortAspect,reviewSortAspectLabel,reviewAspectPolarity}=await import("../../src/brain/review-sort.ts");
 assert.equal(normalizeReviewSortAspect("보습력"),"moisturizing");
 assert.equal(reviewSortAspectLabel("moisturizing"),"보습력");
 assert.equal(reviewSortAspectLabel("보습력"),"보습력");
 assert.equal(reviewAspectPolarity("보습이 좋아서 만족해요.","보습력"),"POSITIVE");
 assert.equal(reviewAspectPolarity("촉촉하지 않아요.","moisturizing"),"NEGATIVE");
 assert.equal(reviewAspectPolarity("촉촉한 편이에요.","moisturizing"),"NEUTRAL");
 assert.equal(reviewAspectPolarity("촉촉해서 만족하지만 보습은 아쉬워요.","moisturizing"),"NEUTRAL");
});

test("conflicting chunks of one source stay neutral and unsupported aspects stay insufficient",()=>{
 const mixed=rank([
  review("mixed-positive","source-mixed","p-a","촉촉해서 만족스러워요."),
  review("mixed-negative","source-mixed","p-a","보습이 아쉬워요."),
  review("a-positive","source-a","p-a","촉촉함이 좋아서 추천합니다."),
  review("b-negative1","source-b1","p-b","촉촉하지 않아 아쉬워요."),
  review("b-negative2","source-b2","p-b","보습이 부족해서 별로예요."),
 ]);
 assert.equal(mixed.explicitReviewSort.status,"APPLIED");
 assert.equal(mixed.ranked[0].candidate.productId,"p-a");
 assert.equal(mixed.ranked.find((row:any)=>row.candidate.productId==="p-a").reviewSortEvidence.positiveCount,1);
 assert.deepEqual(mixed.ranked.find((row:any)=>row.candidate.productId==="p-a").reviewSortEvidence.reviewIds,["source-a"]);
 const unsupported=rank([], {aspect:"firmness",direction:"MOST_POSITIVE"});
 assert.deepEqual(unsupported.explicitReviewSort,{aspect:"firmness",status:"INSUFFICIENT",scope:"RETRIEVED_REVIEWS"});
 assert.ok(unsupported.ranked.every((row:any)=>row.reviewSortEvidence.positiveCount===0&&row.reviewSortEvidence.negativeCount===0));
});

test("one observed product alone is insufficient, while top ten sorts only evidenced candidates",()=>{
 const one=rank([review("only","source-only","p-a","촉촉해서 만족스러워요.")]);
 assert.equal(one.explicitReviewSort.status,"INSUFFICIENT");
 assert.equal(one.ranked[0].candidate.productId,"p-b","one observed product cannot be compared to an unseen review sample");
 const candidates=Array.from({length:10},(_,index)=>item(`p-${index}`,4,10));
 const reviews=[
  review("p0-a","p0-a","p-0","촉촉해서 만족스러워요."),
  review("p0-b","p0-b","p-0","보습력이 좋아 추천해요."),
  review("p1-a","p1-a","p-1","촉촉해서 만족스러워요."),
 ];
 const topTen=rankProducts(candidates as never,reviews as never,{
  maxTotalWon:null,requiredConditions:[],currentPreferences:{},reviewSort:{aspect:"moisturizing",direction:"MOST_POSITIVE"},
 } as never,[]);
 assert.equal(topTen.explicitReviewSort?.status,"APPLIED");
 assert.deepEqual(topTen.ranked.slice(0,3).map(row=>row.candidate.productId),["p-0","p-1","p-2"]);
 assert.equal(topTen.ranked.length,10);
});
