import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseKrwTenThousandBand} from "../../src/brain/price-band.ts";
import {rankProducts} from "../../src/brain/personalization.ts";
import {curateRecommendations} from "../../src/brain/recommendation-strategies.ts";
import {positiveForAspect,requestedPositiveReviewSort,sortByVerifiedPositiveReviews} from "../../src/brain/review-sort.ts";
import {resolveTurnPlan,retrieveTurn} from "../../src/brain/read-flow.ts";
import type {EvidenceRecord,ProductCandidate} from "../../src/brain/contracts.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";

const candidate=(id:string,unitPriceWon:number,shippingFeeWon:number|null=3000):ProductCandidate=>({
 productId:id,variantId:"v-"+id,productName:"세럼 "+id,unitPriceWon,shippingFeeWon,
 rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
 conditions:{},facets:{},sourceKind:"REAL",commerceVerified:true,datasetVersion:"qa09"
});
const evidence=(id:string,productId:string,text:string,variantId:string|null=null):EvidenceRecord=>({
 id:"rag-chunk-"+id+"-"+Math.random().toString(36).slice(2),sourceId:id,
 productId,variantId,kind:"REVIEW",sourceKind:"REAL",sourceRef:"commerce-reviews",
 text,verified:true,datasetVersion:"qa09"
});
const plan=(min=10000,max=39999)=>({query:"세럼",revision:1,minTotalWon:min,maxTotalWon:max,
 requiredConditions:[],currentPreferences:{},reviewSortAspect:"촉촉"});
const fixture=()=>{
 const products=[candidate("cheap",16000),candidate("moist",26000)];
 const reviews=[
  evidence("a-one","cheap","피부가 촉촉해요."),
  evidence("b-one","moist","바르고 나면 촉촉해요."),
  evidence("b-two","moist","수분감이 좋고 촉촉해서 만족했어요.")];
 return {products,reviews};
};
test("QA09 1-2 price range spans preserve single bands and reject ambiguous bounds",()=>{
 assert.deepEqual(parseKrwTenThousandBand("2만원대 상품 추천"),{minTotalWon:20000,maxTotalWon:29999});
 assert.deepEqual(parseKrwTenThousandBand("1~3만원대 상품 추천"),{minTotalWon:10000,maxTotalWon:39999});
 assert.deepEqual(parseKrwTenThousandBand("1만~3만원대에서"),{minTotalWon:10000,maxTotalWon:39999});
 assert.equal(parseKrwTenThousandBand("3~1만원대"),null);
 assert.equal(parseKrwTenThousandBand("1~3만원대 이하"),null);
});
test("QA09 commerce total decides 31k inclusion and 42k exclusion",()=>{
 const result=rankProducts([candidate("included",28000),candidate("excluded",39000)],[],plan(),[]);
 assert.deepEqual(result.ranked.map(x=>x.candidate.productId),["included"]);
 assert.equal(result.rejected[0].candidate.productId,"excluded");
 assert.ok(result.rejected[0].reasons.includes("over_total_budget"));
});
test("QA09 unknown shipping is never silently free or a verified total",()=>{
 const result=rankProducts([candidate("unknown",28000,null)],[],plan(),[]);
 assert.equal(result.ranked.length,0);
 assert.ok(result.rejected[0].reasons.includes("price_or_shipping_unverified"));
});
test("QA09 explicit review sort detected; generic review comparison is not recast as positive count",()=>{
 assert.equal(requestedPositiveReviewSort("1~3만원대에서 촉촉하다는 리뷰가 많은 순으로 추천해줘"),"촉촉");
 assert.equal(requestedPositiveReviewSort("촉촉하다는 후기가 많은 순으로"),"촉촉");
 assert.equal(requestedPositiveReviewSort("촉촉한 세럼 비교해줘"),null);
 assert.equal(requestedPositiveReviewSort("리뷰 많은 상품"),null);
});
test("QA09 positive review count B outranks cheaper A; activity is not allowed to reshuffle the requested order",()=>{
 const {products,reviews}=fixture(),r=rankProducts(products,reviews,plan(),[]);
 assert.deepEqual(r.ranked.map(x=>x.candidate.productId),["cheap","moist"],"default lower-price score");
 const sorted=sortByVerifiedPositiveReviews(r,reviews,"촉촉");
 assert.equal(sorted.status,"VERIFIED_SAMPLE_ORDER");
 assert.deepEqual(sorted.ranking.ranked.map(x=>x.candidate.productId),["moist","cheap"]);
 assert.equal(sorted.counts.get("moist"),2);
 assert.equal(sorted.counts.get("cheap"),1);
});
test("QA09 original Commerce review ID counts only once across multiple RAG chunks",()=>{
 const {products,reviews}=fixture(),duplicates=[reviews[0],reviews[0],reviews[0],...reviews.slice(1)];
 const sorted=sortByVerifiedPositiveReviews(rankProducts(products,duplicates,plan(),[]),duplicates,"촉촉");
 assert.equal(sorted.counts.get("cheap"),1);
});
test("QA09 negation, unrelated quoted reviews and questions do not count as positive",()=>{
 for(const text of ["촉촉하지 않아요.","안 촉촉해요.","촉촉하다는 리뷰가 있나요?",
  "남들은 촉촉하다고 하는데 저는 별로예요.","‘촉촉해요’라고 광고해요."]){
  assert.equal(positiveForAspect(text,"촉촉"),false,text);
 }
 assert.equal(positiveForAspect("피부가 촉촉해요.","촉촉"),true);
});
test("QA09 forged and cross-product/variant/unverified review evidence cannot raise sample count",()=>{
 const {products,reviews}=fixture();
 const fake=[evidence("f","moist","촉촉해요.","wrong-variant"),
  {...evidence("u","moist","촉촉해요."),verified:false},
  {...evidence("x","not-the-product","촉촉해요.")},
  {...evidence("stale","moist","촉촉해요."),datasetVersion:"stale"}];
 const output=sortByVerifiedPositiveReviews(rankProducts(products,reviews,plan(),[]),
  [...reviews,...fake],"촉촉");
 assert.equal(output.counts.get("moist"),2);
});
test("QA09 insufficient sample cannot masquerade as verified ranked, relevance or cheaper-price sort",()=>{
 const products=[candidate("a",10000),candidate("b",25000)];
 const reviews=[evidence("one","b","촉촉해요.")];
 const result=sortByVerifiedPositiveReviews(rankProducts(products,reviews,plan(),[]),reviews,"촉촉");
 assert.equal(result.status,"INSUFFICIENT");
 assert.equal(result.ranking.ranked.length,0);
 assert.equal(result.ranking.referenceOnly.length,2);
});
test("QA09 ordinary recommendation keeps its personalized sorting and cart affinity",()=>{
 const {products,reviews}=fixture();
 const ranked=rankProducts(products,reviews,plan(),[]);
 const personalized=curateRecommendations(ranked,{cartProductIds:["moist"],wishlistProductIds:[]});
 assert.equal(personalized.ranked[0].candidate.productId,"moist");
});
test("QA09 plan retains review sort and price band on follow-up; clears on explicit other sort",async()=>{
 const base={query:"세럼",queryMode:"KEEP",budgetMode:"KEEP",requirementsMode:"KEEP",
  context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};
 const deps={intent:{extract:async()=>base}} as unknown as ResearchDeps;
 const prepared={messageId:"m",memories:[],startedAt:performance.now(),memoryMs:0};
 const req=(msg:string)=>({actorUserId:"me",conversationId:"thread",requestId:"req",clientActionId:"a",userMessage:msg});
 const first=await resolveTurnPlan(req("1~3만원대에서 촉촉하다는 리뷰가 많은 순으로 추천해줘"),
  prepared,undefined,{...deps,intent:{extract:async()=>({...base,queryMode:"SET",budgetMode:"CLEAR"})}} as never);
 assert.equal(first.reviewSortAspect,"촉촉");
 assert.equal(first.minTotalWon,10000);assert.equal(first.maxTotalWon,39999);
 const next=await resolveTurnPlan(req("그럼 향이 은은한 것만"),prepared,first,deps);
 assert.equal(next.reviewSortAspect,"촉촉");
 assert.equal(next.minTotalWon,10000);assert.equal(next.maxTotalWon,39999);
 const cleared=await resolveTurnPlan(req("이번엔 가격순으로"),prepared,next,deps);
 assert.equal(cleared.reviewSortAspect,undefined);
});
test("QA09 retrieve integration preserves requested rank ahead of cart/previous-purchase personalization",async()=>{
 const {products,reviews}=fixture();let inputs:any[]=[];
 const deps={retriever:{search:async(input:unknown)=>{inputs.push(input);return {candidates:products,evidence:reviews};}},
  activity:async()=>({cartProductIds:["cheap"],wishlistProductIds:["cheap"]})
 } as unknown as ResearchDeps;
 const prepared={messageId:"m",memories:[],startedAt:performance.now(),memoryMs:0};
 const result=await retrieveTurn({actorUserId:"actor",conversationId:"c",requestId:"req",
  clientActionId:"a",userMessage:"촉촉하다는 리뷰가 많은 순으로"},prepared,plan(),deps);
 assert.equal(inputs[0].reviewSortAspect,"촉촉");
 assert.deepEqual(result.result.ranking.ranked.map(x=>x.candidate.productId),["moist","cheap"]);
 assert.equal(result.result.reviewSortInfo?.status,"VERIFIED_SAMPLE_ORDER");
});
test("QA09 price breakdown is wired in the Brain card and CSS wraps narrow totals",()=>{
 const tsx=readFileSync("src/web/components/BrainPreview.tsx","utf8");
 const css=readFileSync("src/web/styles.css","utf8");
 assert.match(tsx,/상품가/);assert.match(tsx,/배송비 포함 합계/);
 assert.match(tsx,/Number\.isSafeInteger\(p\.unitPriceWon\+p\.shippingFeeWon\)/);
 assert.match(tsx,/금액 확인 필요/);assert.match(css,/\.brain-price-breakdown/);
 assert.match(css,/overflow-wrap:anywhere/);
});
