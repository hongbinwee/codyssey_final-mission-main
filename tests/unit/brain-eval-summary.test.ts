import test from "node:test";
import assert from "node:assert/strict";
import {summarizeIntentQuality} from "../../src/brain/eval-summary.ts";
test("M12 evaluation separates model quality and latency by group/split",()=>{
 const rows=[
  {group:"followup",split:"development",passed:true,latencyMs:10,fields:{query:true,maxTotalWon:true,requiredConditions:true,currentPreferences:true}},
  {group:"followup",split:"development",passed:false,latencyMs:20,error:"invalid JSON",fields:{query:true,maxTotalWon:false,requiredConditions:true,currentPreferences:true}},
  {group:"injection",split:"candidate_holdout",passed:false,latencyMs:30,error:"rate limit 429 secret",fields:{query:false,maxTotalWon:false,requiredConditions:false,currentPreferences:false}},
  {group:"injection",split:"candidate_holdout",passed:true,latencyMs:40,fields:{query:true,maxTotalWon:true,requiredConditions:true,currentPreferences:true}}
 ];
 const m=summarizeIntentQuality(rows);
 assert.equal(m.groups.followup.exactPlanAccuracy,.5);
 assert.equal(m.splits.candidate_holdout.cases,2);
 assert.equal(m.fieldAccuracy.maxTotalWon,.5);
 assert.equal(m.errorsByType.INVALID_OUTPUT,1);
 assert.equal(m.errorsByType.RATE_LIMIT,1);
 assert.equal(m.latencyMs.p50,20);
 assert.equal(m.latencyMs.p95,40);
 assert.equal(m.providerCallCostStatus,"NOT_MEASURED");
 assert.doesNotMatch(JSON.stringify(m),/secret/);
});
test("M12 empty dataset must not produce fake 100% accuracy",()=>{
 assert.throws(()=>summarizeIntentQuality([]),/empty/);
});
