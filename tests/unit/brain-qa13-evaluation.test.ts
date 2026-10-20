import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

type RegressionCase={text:string;aspect:string;expected:"POSITIVE"|"NEGATIVE"|"MIXED"|"UNRELATED"|"UNCERTAIN";reason:string};
const cases=JSON.parse(readFileSync(new URL("../fixtures/qa13-review-opinions.json",import.meta.url),"utf8")) as RegressionCase[];
const {classifyReviewOpinion}=await import("../../src/brain/review-analysis.ts");

test("fixed Korean review-opinion regression preserves target aspect, polarity, mixed evidence, and uncertainty",()=>{
 assert.ok(cases.length>=20,"the fixed regression set must contain at least 20 cases");
 const mismatches=cases.flatMap((item,index)=>{
  const actual=classifyReviewOpinion(item.text,item.aspect);
  return actual===item.expected?[]:[{index:index+1,text:item.text,aspect:item.aspect,expected:item.expected,actual,reason:item.reason}];
 });
 const correct=cases.length-mismatches.length;
 const accuracy=correct/cases.length;
 console.log(`QA13 fixed regression opinion evaluation: ${correct}/${cases.length} correct (${(accuracy*100).toFixed(1)}%); misclassified=${JSON.stringify(mismatches)}`);
 assert.deepEqual(mismatches,[],"fixed regression classifications must match the recorded expectations");
});
