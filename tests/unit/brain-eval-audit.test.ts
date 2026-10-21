import test from "node:test";
import assert from "node:assert/strict";
import {auditIntentDataset,suggestCrossSplitNearDuplicates} from "../../src/brain/eval-audit.ts";
const item=(id:string,split:string,message:string,status="author_review_required")=>({
 id,split,message,group:"budget",previous:null,dataClass:"EVALUATION_ONLY",annotationStatus:status
});
test("M14 independent dataset audit flags same logical prompt leaked across development and holdout",()=>{
 const r=auditIntentDataset([
  item("1","development","모니터 50만원"),
  item("2","candidate_holdout","모니터   50만원!"),
  item("3","candidate_holdout","헤드폰 20만원")
 ]);
 assert.equal(r.crossSplitDuplicateGroups,1);
 assert.equal(r.safeForBlindHoldout,false);
 assert.equal(r.independentlyApproved,false);
 assert.doesNotMatch(JSON.stringify(r),/헤드폰|모니터/);
});
test("M14 independent approval is mandatory before calling a split verified",()=>{
 const r=auditIntentDataset([
  item("1","development","monitor one","independently_adjudicated"),
  item("2","candidate_holdout","monitor two","independently_adjudicated")
 ]);
 assert.equal(r.crossSplitDuplicateGroups,0);
 assert.equal(r.safeForBlindHoldout,true);
 assert.equal(r.independentlyApproved,true);
});
test("M14 duplicate case ID, invalid data class and empty goldset are never silently approved",()=>{
 const r=auditIntentDataset([item("1","development","a"),item("1","candidate_holdout","b"),
  {...item("3","candidate_holdout","c"),dataClass:"CI_FIXTURE"}]);
 assert.equal(r.invalidCases,2);
 assert.equal(r.safeForBlindHoldout,false);
 assert.throws(()=>auditIntentDataset([]),/empty/);
});

test("M15 near-duplicate candidates remain review-only and never reveal prompt text",()=>{
 const cases=[item("dev1","development","개발용 모니터 50만원 추천"),
 item("h1","candidate_holdout","개발용 모니터 50만원 이하 추천해줘"),
 item("h2","candidate_holdout","헤드폰 방수 성능은?")];
 const report=suggestCrossSplitNearDuplicates(cases,.55);
 assert.equal(report.independentSemanticAuditComplete,false);
 assert.ok(report.reviewRequiredPairs>=1);
 assert.equal(report.candidates[0].developmentId,"dev1");
 assert.equal(report.candidates[0].holdoutId,"h1");
 assert.doesNotMatch(JSON.stringify(report),/개발용|헤드폰/);
 assert.throws(()=>suggestCrossSplitNearDuplicates(cases,1.5),/invalid/);
});
