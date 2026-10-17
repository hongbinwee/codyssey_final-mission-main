import test from "node:test";
import assert from "node:assert/strict";
import {gradeShoppingPlan,fullPlanPass} from "../../src/brain/evaluation-rubric.ts";
const expected={query:"monitor",maxTotalWon:500000,requiredConditions:["QHD","USB-C"],
 currentPreferences:{price_priority:"value",eye_comfort:"important"}};
test("scoring ignores independent constraint order, NOT missing or duplicate constraints",()=>{
 const reordered={...expected,requiredConditions:["USB-C","QHD"],
  currentPreferences:{eye_comfort:"important",price_priority:"value"}};
 assert.equal(fullPlanPass(gradeShoppingPlan(reordered,expected)),true);
 assert.equal(gradeShoppingPlan({...expected,requiredConditions:["QHD"]},expected).requiredConditions,false);
 assert.equal(gradeShoppingPlan({...expected,requiredConditions:["QHD","QHD"]},expected).requiredConditions,false);
});
test("negative controls: mutated hard budget or current preference fail exact plan",()=>{
 assert.equal(fullPlanPass(gradeShoppingPlan({...expected,maxTotalWon:600000},expected)),false);
 assert.equal(fullPlanPass(gradeShoppingPlan({...expected,currentPreferences:{price_priority:"performance"}},expected)),false);
 assert.equal(fullPlanPass({query:true,maxTotalWon:true,requiredConditions:true}),false);
});
