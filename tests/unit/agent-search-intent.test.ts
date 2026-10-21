import assert from "node:assert/strict";
import test from "node:test";
import {parseAgentSearchIntent} from "../../src/brain/agent-search-intent.ts";

test("category-free search output stays valid and keeps an explicit gender as a hard condition",()=>{
 const result=parseAgentSearchIntent({intent:{
  query:"남성 운동용 팬티 통풍",maxTotalWon:null,requiredConditions:[],
  currentPreferences:{price_priority:"balanced"},queryMode:"SET",budgetMode:"CLEAR",
  attributePreferences:["breathability","moisture_wicking"],
 }} ,"운동할 때 입을 남성용 팬티 추천해줘. 통풍이 잘되면 좋겠어.");
 assert.ok(result);
 assert.equal(result.query,"남성 운동용 팬티 통풍");
 assert.deepEqual(result.context.requiredConditions,["남성용"]);
 assert.equal(result.context.category,undefined);
 assert.equal(result.context.attributePreferences,undefined);
});

test("category-scoped attributes still require evidence from the current user message",()=>{
 const result=parseAgentSearchIntent({intent:{
  query:"남성 운동용 팬티",maxTotalWon:null,requiredConditions:["남성용"],
  currentPreferences:{price_priority:"balanced"},category:"fashion",
  attributePreferences:["breathability"],attributeSources:{breathability:"통풍이 잘되면 좋겠어"},
  queryMode:"SET",budgetMode:"CLEAR",
 }} ,"운동할 때 입을 남성용 팬티 추천해줘. 통풍이 잘되면 좋겠어.");
 assert.ok(result);
 assert.deepEqual(result.context.requiredConditions,["남성용"]);
 assert.deepEqual(result.context.attributePreferences,["breathability"]);
});
