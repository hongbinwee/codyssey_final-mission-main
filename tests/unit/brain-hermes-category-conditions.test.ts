import test from "node:test";
import assert from "node:assert/strict";
import {resolveTurnPlan,retrieveTurn} from "../../src/brain/read-flow.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";

const basePlan={query:"남성용 니플패치",revision:1,maxTotalWon:null,requiredConditions:["남성용"],currentPreferences:{},category:"beauty"};
const input=(text:string)=>({actorUserId:"u",conversationId:"c",requestId:"r",clientActionId:"a",userMessage:text});
const prepared={messageId:"m",memories:[],startedAt:0,memoryMs:0};
test("explicit male condition cannot be erased by a model omitting requiredConditions",async()=>{
 const deps={intent:{extract:async()=>({query:"남성용 팬티",queryMode:"SET",budgetMode:"CLEAR",requirementsMode:"REPLACE",
   context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{},category:"fashion"}})}} as unknown as ResearchDeps;
 const plan=await resolveTurnPlan(input("남성용 팬티 찾아줘"),prepared,null,deps);
 assert.deepEqual(plan.requiredConditions,["남성용"]);
});
test("empty inferred category retries only once in verified multi-category RAG",async()=>{
 const categories:string[]=[];
 const deps={retriever:{supportsGlobalCategorySearch:true,search:async({category}:{category?:string})=>{
   categories.push(category??"omitted");return {candidates:[],evidence:[]};
 }}} as unknown as ResearchDeps;
 await retrieveTurn(input("남성용 니플패치 찾아줘"),prepared,basePlan,deps);
 assert.deepEqual(categories,["beauty",""]);
 categories.length=0;
 await retrieveTurn(input("뷰티 카테고리에서 남성용 니플패치 찾아줘"),prepared,basePlan,deps);
 assert.deepEqual(categories,["beauty"]);
 categories.length=0;
 const single={retriever:{search:async({category}:{category?:string})=>{
   categories.push(category??"omitted");return {candidates:[],evidence:[]};
 }}} as unknown as ResearchDeps;
 await retrieveTurn(input("남성용 니플패치 찾아줘"),prepared,basePlan,single);
 assert.deepEqual(categories,["beauty"]);
});
