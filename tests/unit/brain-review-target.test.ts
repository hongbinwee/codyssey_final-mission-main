import test from "node:test";
import assert from "node:assert/strict";
import type {ResearchResult} from "../../src/brain/read-flow.ts";
import {resolveReviewFollowup} from "../../src/brain/review-target.ts";
import {parseReviewSummaryRequest,routeBrainMessage} from "../../src/brain/routing.ts";

const productRows=[
 {productId:"p-mask",variantId:"v-mask",name:"노프랍 하이드로겔 마스크팩",displayIndex:1},
 {productId:"p-cream",variantId:"v-cream",name:"노프랍 수분 크림",displayIndex:2},
];
function previous(patch:Record<string,unknown>={}):ResearchResult{
 return {
  datasetVersion:"dataset-1",conversationId:"c",messageId:"m",
  shoppingPlan:{query:"마스크팩",lastDisplayedProductIds:["p-mask","p-cream"],lastDisplayedProducts:productRows},
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
  explanation:{kind:"VERIFIED_CANDIDATES",text:"",items:productRows.map(row=>({
   productId:row.productId,variantId:row.variantId,name:row.name,totalPriceWon:1,evidenceIds:[],indicators:[],
  })),limitations:[]},
  ...patch,
 } as unknown as ResearchResult;
}

test("explicit product name plus '이거 리뷰 분석해줘' resolves one verified displayed product",()=>{
 const message="노프랍 하이드로겔 마스크팩 이거 리뷰 분석해줘";
 assert.deepEqual(parseReviewSummaryRequest(message),{query:"노프랍 하이드로겔 마스크팩",focus:"ALL"});
 assert.deepEqual(resolveReviewFollowup(message,previous(),"dataset-1"),
  {productId:"p-mask",variantId:"v-mask",focus:"ALL"});
});

test("a name correction after an ambiguous review keeps the pending review focus",()=>{
 const message="노프랍 하이드로겔 마스크팩 이라고 얘기했는데?";
 const fullName="노프랍 수분 진정 대용량 하이드로겔 패드 [NEW3종/5+1매] 마스크팩 기획 6종";
 const rows=[{productId:"p-mask",variantId:"v-mask",name:fullName,displayIndex:1},
  {productId:"p-other",variantId:"v-other",name:"노프랍 워시오프 마스크",displayIndex:2}];
 const prior=previous({
  pendingReview:{query:"노프랍 마스크팩",focus:"CONS"},
  shoppingPlan:{query:"마스크팩",lastDisplayedProductIds:["p-mask","p-other"],lastDisplayedProducts:rows},
  explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:{
   status:"AMBIGUOUS",focus:"CONS",choices:[{productId:"p-mask",name:fullName},
    {productId:"p-other",name:"노프랍 워시오프 마스크"}],evidence:[],
  }},
 });
 assert.deepEqual(resolveReviewFollowup(message,prior,"dataset-1"),
  {productId:"p-mask",variantId:"v-mask",focus:"CONS"});
});

test("a conflicting display number and product name never picks either ID",()=>{
 const result=resolveReviewFollowup("2번 노프랍 하이드로겔 마스크팩 리뷰 요약해줘",previous(),"dataset-1");
 assert.equal(result?.productId,undefined);
 assert.equal(result?.displayIndex,undefined);
 assert.equal(result?.useCurrent,true);
});

test("duplicate displayed names stay ambiguous instead of selecting the first ID",()=>{
 const duplicate=previous({shoppingPlan:{query:"마스크팩",lastDisplayedProductIds:["p-mask","p-cream"],
  lastDisplayedProducts:[
   {productId:"p-mask",variantId:"v-mask",name:"노프랍 마스크팩",displayIndex:1},
   {productId:"p-cream",variantId:"v-cream",name:"노프랍 마스크팩",displayIndex:2},
  ]}});
 const result=resolveReviewFollowup("노프랍 마스크팩 이거 리뷰 요약해줘",duplicate,"dataset-1");
 assert.equal(result?.productId,undefined);
 assert.equal(result?.useCurrent,true);
});

test("an explicit new product recommendation remains a fresh search",()=>{
 assert.equal(resolveReviewFollowup("다른 상품 추천해줘",previous(),"dataset-1"),undefined);
});

test("an unmatched explicit product name keeps its query instead of selecting the current item",()=>{
 const result=resolveReviewFollowup("바이오 셀룰로오스 수딩 마스크 이거 리뷰 분석해줘",previous(),"dataset-1");
 assert.deepEqual(result,{query:"바이오 셀룰로오스 수딩 마스크",focus:"ALL"});
});

test("a dataset change never reuses an ID from the prior displayed products",()=>{
 const result=resolveReviewFollowup("노프랍 하이드로겔 마스크팩 이거 리뷰 분석해줘",previous(),"dataset-2");
 assert.equal(result?.productId,undefined);
});

test("ordinal words embedded in a product name are not mistaken for display indexes",()=>{
 const result=resolveReviewFollowup("노프랍 두피 케어 하이드로겔 마스크팩 리뷰 요약해줘",
  previous({shoppingPlan:{query:"",lastDisplayedProductIds:["p-mask"],
   lastDisplayedProducts:[{productId:"p-mask",variantId:"v-mask",name:"노프랍 두피 케어 하이드로겔 마스크팩",displayIndex:1}]}}),
  "dataset-1");
 assert.equal(result?.productId,"p-mask");
 assert.equal(result?.displayIndex,undefined);
});

test("generic current, targetless summary and explicit ID requests pass through to the existing graph path",()=>{
 const prior=previous({explanation:{kind:"REVIEW_SUMMARY",text:"",items:[],limitations:[],reviewSummary:{
  status:"READY",focus:"ALL",product:{id:"p-cream",name:"노프랍 수분 크림"},evidence:[],
 }}});
 assert.equal(resolveReviewFollowup("그거 단점만 알려줘",prior,"dataset-1"),undefined);
 assert.equal(resolveReviewFollowup("리뷰 요약해줘",prior,"dataset-1"),undefined);
 assert.equal(resolveReviewFollowup("리뷰 요약 상품 선택: p1",prior,"dataset-1"),undefined);
 assert.deepEqual(parseReviewSummaryRequest("이 제품 단점만 알려줘"),{useCurrent:true,focus:"CONS"});
});

test("review comparisons and sort requests rejected by the summary parser stay on existing routes",()=>{
 for(const message of ["수분크림과 로션 리뷰 비교해줘","촉촉하다는 긍정 리뷰가 많은 순"]){
  assert.equal(routeBrainMessage(message,previous().shoppingPlan).kind,"REVIEW_COMPARE");
  assert.equal(resolveReviewFollowup(message,previous(),"dataset-1"),undefined,message);
 }
});
