import test from "node:test";
import assert from "node:assert/strict";
import {explainPreviousRecommendation} from "../../src/brain/recommendation-followup.ts";
import type {ResearchResult} from "../../src/brain/read-flow.ts";

const candidate=(id:string,name:string,price:number)=>({candidate:{
 productId:id,variantId:id+"-v",productName:name,commerceVerified:true,
 unitPriceWon:price,shippingFeeWon:3000
}});
const prior={
 datasetVersion:"set-v1",
 shoppingPlan:{maxTotalWon:30000,query:"이어폰"},
 ranking:{ranked:[candidate("p1","상품 하나",12000),candidate("p2","상품 둘",16000)],referenceOnly:[],rejected:[],evaluatedCount:2},
 explanation:{kind:"VERIFIED_CANDIDATES",text:"2개 추천",items:[
  {productId:"p1",variantId:"p1-v",name:"상품 하나",reason:"저렴한 옵션이 확인됐어요."},
  {productId:"p2",variantId:"p2-v",name:"상품 둘",reason:"예산에 맞는 다른 옵션이에요."}
 ],limitations:[]}
} as unknown as ResearchResult;

test("explains the previous first product without searching or changing the list",()=>{
 const answer=explainPreviousRecommendation("1순위는 왜 추천한 거야?",prior,"set-v1");
 assert.equal(answer?.kind,"CONVERSATION");
 assert.match(answer!.text,/상품 하나/);
 assert.match(answer!.text,/15,000원/);
 assert.match(answer!.text,/저렴한 옵션/);
 assert.equal(answer?.items.length,2);
});
test("supports successive ordinal follow-ups with preserved reasons",()=>{
 const first=explainPreviousRecommendation("첫 번째 상품 왜?",prior,"set-v1");
 const next={...prior,explanation:first} as ResearchResult;
 const second=explainPreviousRecommendation("2순위는 왜?",next,"set-v1");
 assert.match(second!.text,/상품 둘/);
 assert.match(second!.text,/19,000원/);
 assert.doesNotMatch(second!.text,/상품 하나/);
});
test("a previous slow model must not cause another timeout banner on the reason follow-up",()=>{
 const slow={...prior,explanation:{...prior.explanation!,failure:{code:"MODEL_TIMEOUT"}}} as ResearchResult;
 const explanation=explainPreviousRecommendation("1순위는 왜?",slow,"set-v1");
 assert.equal(explanation?.failure,undefined);
 assert.match(explanation!.text,/15,000원/);
});
test("does not reuse stale, unavailable or unrelated recommendations",()=>{
 assert.equal(explainPreviousRecommendation("1순위는 왜 추천한 거야?",prior,"set-v2"),null);
 assert.equal(explainPreviousRecommendation("새로운 이어폰 추천해 줘",prior,"set-v1"),null);
 assert.equal(explainPreviousRecommendation("3순위는 왜?",prior,"set-v1"),null);
 assert.equal(explainPreviousRecommendation("1순위는 왜?",{...prior,explanation:{...prior.explanation!,failure:{code:"RETRIEVAL_UNAVAILABLE"}}} as ResearchResult,"set-v1"),null);
});
