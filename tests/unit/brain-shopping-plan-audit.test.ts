import test from "node:test";
import assert from "node:assert/strict";
import {resolveShoppingPlan} from "../../src/brain/shopping-plan.ts";

const old={query:"monitor",revision:3,maxTotalWon:500000,
 requiredConditions:["QHD","USB-C"],currentPreferences:{eye_comfort:"important" as const}};
test("AUD-02 new category ADD must not retain QHD or USB-C from old monitor",()=>{
 const next=resolveShoppingPlan(old,{
  query:"headphones",queryMode:"SET",budgetMode:"CLEAR",
  requirementsMode:"ADD",context:{maxTotalWon:null,requiredConditions:["Bluetooth"],
   currentPreferences:{}}
 });
 assert.deepEqual(next.requiredConditions,["Bluetooth"]);
 assert.equal(next.maxTotalWon,null);
 assert.deepEqual(next.currentPreferences,{});
});
test("ADD remains cumulative for same task, but KEEP/REPLACE/CLEAR retain their meaning",()=>{
 const more=resolveShoppingPlan(old,{
  query:"monitor",queryMode:"KEEP",budgetMode:"KEEP",requirementsMode:"ADD",
  context:{maxTotalWon:null,requiredConditions:["HDR"],currentPreferences:{}}
 });
 assert.deepEqual(more.requiredConditions,["QHD","USB-C","HDR"]);
 assert.deepEqual(old.requiredConditions,["QHD","USB-C"]);
});
