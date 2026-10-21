import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createIntentPort} from "../../src/brain/intent.ts";
import {resolveShoppingPlan} from "../../src/brain/shopping-plan.ts";
import {rankProducts} from "../../src/brain/personalization.ts";
import {buildGroundedExplanation} from "../../src/brain/grounded-response.ts";
import type {EvidenceRecord} from "../../src/brain/contracts.ts";
import type {ShoppingPlan} from "../../src/brain/shopping-plan.ts";

const dataset=JSON.parse(readFileSync(new URL("../../eval/brain/intent-v1.json",import.meta.url),"utf8"));
test("goldset: each hand-labeled extracted intent resolves to its expected Shopping Plan",async()=>{
 assert.ok(dataset.cases.length>=10);
 for(const c of dataset.cases){
  const port=createIntentPort({complete:async()=>JSON.stringify(c.goldOutput)});
  const predicted=resolveShoppingPlan(c.previous,
    await port.extract(c.message,[],c.previous??undefined));
  const got={query:predicted.query,maxTotalWon:predicted.maxTotalWon,
    requiredConditions:predicted.requiredConditions,currentPreferences:predicted.currentPreferences};
  assert.deepEqual(got,c.expected,"bad case "+c.id);
 }
});

test("v2: 60 labeled shopping cases resolve consistently; no real-product data",async()=>{
 const v2=JSON.parse(readFileSync(new URL("../../eval/brain/intent-v2.json",import.meta.url),"utf8"));
 assert.equal(v2.version,"brain-intent-eval-v2");
 assert.equal(v2.dataClass,"EVALUATION_ONLY");
 assert.equal(v2.cases.length,60);
 assert.equal(v2.counts.candidate_holdout,15);
 assert.equal(v2.counts.development,45);
 assert.equal(new Set(v2.cases.map((c:{id:string})=>c.id)).size,60);
 for(const c of v2.cases){
   assert.equal(c.dataClass,"EVALUATION_ONLY");
   assert.equal(c.annotationStatus,"author_review_required");
   const port=createIntentPort({complete:async()=>JSON.stringify(c.goldOutput)});
   const plan=resolveShoppingPlan(c.previous,
     await port.extract(c.message,[],c.previous??undefined));
   const got={query:plan.query,maxTotalWon:plan.maxTotalWon,
     requiredConditions:plan.requiredConditions,currentPreferences:plan.currentPreferences};
   assert.deepEqual(got,c.expected,"evaluation label mismatch "+c.id);
 }
});
test("negative control: mutated expected budget must be scored wrong",()=>{
 const original={query:"monitor",maxTotalWon:500000,requiredConditions:["FHD"],currentPreferences:{}};
 const mutated={...original,maxTotalWon:600000};
 assert.notDeepEqual(original,mutated,"a changed label must not be accepted silently");
});
function mockCandidate(id:string,verified=true){
 return {productId:"p-"+id,variantId:"v-"+id,productName:"CI item "+id,
  unitPriceWon:id==="a"?100000:290000,shippingFeeWon:3000,rating:4.5,ratingScale:5,
  wholeReviewCount:30,wholeReviewCountVerified:verified,
  conditions:{},facets:{
   performance:{score:id==="a"?.4:.9,evidenceIds:["p-"+id+"-performance"]},
   eye_comfort:{score:id==="a"?.6:.8,evidenceIds:["p-"+id+"-eye_comfort"]},
   noise:{score:.6,evidenceIds:["p-"+id+"-noise"]}
  }};
}
const evidence=(id:string):EvidenceRecord[]=>["performance","eye_comfort","noise"].map((aspect:string)=>({
 id:"p-"+id+"-"+aspect,productId:"p-"+id,variantId:null,
 kind:"REVIEW" as const,sourceKind:"REAL" as const,sourceRef:"CI-only-fixture"
}));
const ctx:ShoppingPlan={query:"monitor",revision:1,maxTotalWon:500000,requiredConditions:[],
 currentPreferences:{price_priority:"performance"}};
test("explanation cannot display foreign-product review IDs",()=>{
 const pool=[mockCandidate("a"),mockCandidate("b")];
 const ev=[...evidence("a"),...evidence("b")];
 // A's performance score claims B evidence: source-aware ranker must reject A.
 pool[0].facets.performance.evidenceIds=["p-b-performance"];
 const ranking=rankProducts(pool,ev,ctx,[]);
 assert.equal(ranking.ranked.some(x=>x.candidate.productId==="p-a"),false);
 const explanation=buildGroundedExplanation(ranking,ev,ctx);
 assert.ok(explanation.items.every(i=>i.evidenceIds.every(id=>id.startsWith(i.productId+"-"))));
 assert.doesNotMatch(explanation.text,/p-b-performance.*p-a/);
});
test("unverified review totals remain disclosed without inventing counts",()=>{
 const candidate=mockCandidate("a",false),ev=evidence("a");
 const ranked=rankProducts([candidate],ev,ctx,[]);
 const result=buildGroundedExplanation(ranked,ev,ctx);
 assert.equal(result.items.length,1);
 assert.equal(result.kind,"VERIFIED_CANDIDATES");
 assert.ok(result.limitations.includes("whole_review_count_unverified"));
});
test("synthetic REVIEW evidence must fail even when matching product identity",()=>{
 const p=mockCandidate("a"),ev=evidence("a");
 ev[0].sourceKind="SYNTHETIC";
 const ranked=rankProducts([p],ev,ctx,[]);
 const result=buildGroundedExplanation(ranked,ev,ctx);
 assert.equal(ranked.ranked.length,0);
 assert.equal(result.items.length,0);
});
test("ranking explanations never exceed the approved top three candidates",()=>{
 const ids=["a","b","c","d"];
 const candidates=ids.map(id=>({...mockCandidate(id),commerceVerified:true})),ev=ids.flatMap(evidence);
 const r=rankProducts(candidates,ev,ctx,[]);
 const result=buildGroundedExplanation(r,ev,ctx);
 assert.ok(result.items.length<=3);
 for(const item of result.items){
  assert.equal(item.evidenceIds.length,new Set(item.evidenceIds).size);
  assert.equal(typeof item.totalPriceWon,'number');
  assert.ok(item.totalPriceWon!==null&&item.totalPriceWon>=0);
 }
});
test("grounded explanation deduplicates product cards and hides internal evidence IDs",()=>{
 const first=mockCandidate("same"),sameProduct={...mockCandidate("same"),variantId:"v-same-other",facets:{}};
 const others=[mockCandidate("b"),mockCandidate("c"),mockCandidate("d")];
 const ev=[...evidence("same"),...evidence("b"),...evidence("c"),...evidence("d")];
 const base=rankProducts([first,...others] as never,ev,ctx,[]);
 const duplicate={...base.ranked[0],candidate:sameProduct};
 const ranking={...base,ranked:[base.ranked[0],duplicate,...base.ranked.slice(1)]};
 const result=buildGroundedExplanation(ranking,ev,ctx);
 assert.deepEqual(result.items.map(item=>item.productId),["p-same","p-b","p-c"]);
 assert.doesNotMatch(result.text,/p-same|v-same|p-b-performance/);
});
test("reference-only explanation counts the same three unique product slots as the UI",()=>{
 const rows=["same","same","b","c","d"].map(id=>({candidate:mockCandidate(id),reasons:["unverified"]}));
 const ranking={ranked:[],referenceOnly:rows,rejected:[],evaluatedCount:rows.length};
 const result=buildGroundedExplanation(ranking as never,[],ctx);
 assert.match(result.text,/3개 상품/);
 assert.doesNotMatch(result.text,/5개 상품/);
});
test("invalid LLM output does not fallback to invented shopping intent",async()=>{
 for(const response of ["bad json","{}",JSON.stringify({
   query:"monitor",maxTotalWon:500000,requiredConditions:[],currentPreferences:{},
   queryMode:"SYSTEM",budgetMode:"KEEP"
 })]){
  const port=createIntentPort({complete:async()=>response});
  await assert.rejects(()=>port.extract("모니터 추천",[]));
 }
});
