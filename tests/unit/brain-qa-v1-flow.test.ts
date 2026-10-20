import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createFastIntentPort} from "../../src/brain/fast-intent.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {routeBrainMessage} from "../../src/brain/routing.ts";
import type {EvidenceRecord,Preference,ProductCandidate} from "../../src/brain/contracts.ts";

function setup(search:()=>Promise<{candidates:ProductCandidate[];evidence:EvidenceRecord[]}> = async()=>({candidates:[],evidence:[]}), memories:Preference[] = []){
 let searches=0,modelCalls=0,groundedCalls=0,sequence=0;
 const requested:{query:string;maxTotalWon:number|null}[]=[];
 const intent=createFastIntentPort({async extract(message,_memories,previous){
  modelCalls++;
  const matchedBudget=message.match(/(\d+(?:,\d{3})*)\s*(만원|만\s*원|원)\s*(?:이하|까지)?/);
  const budget=matchedBudget?Number(matchedBudget[1].replaceAll(",",""))*(matchedBudget[2].replace(/\s/g,"")==="만원"?10000:1):previous?.maxTotalWon??null;
  const requiredConditions=message.includes("통화용")?["통화용"]:message.includes("선물용")?["선물용"]:previous?.requiredConditions??[];
  const query=previous?.query??message.replace(/(?:\d+(?:,\d{3})*\s*(?:만원|만\s*원|원)\s*(?:이하|까지)?|통화용|선물용|추천해\s*줘|추천)/g," ").replace(/\s+/g," ").trim();
  return {query:query||previous?.query||message,queryMode:previous?"KEEP":"SET",
   budgetMode:matchedBudget?"SET":previous?"KEEP":"CLEAR",requirementsMode:previous?"ADD":"REPLACE",
   context:{maxTotalWon:budget,requiredConditions,currentPreferences:{}}};
 }});
 const groundedResponder=async()=>{
  groundedCalls++;
  return {kind:"NO_MATCH",text:"fixture",items:[],limitations:[]};
 };
 const graph=createPersistentResearchGraph({
  clarifyBeforeSearch:true,
  conversations:{async assertOwned(){},async appendUserMessage(_actor,_conversation,action){return action;}},
  memory:{async list(){return memories;},async put(){},async delete(){return false;}},
  route:routeBrainMessage,intent,
  retriever:{async search(input){searches++;requested.push({query:input.query,maxTotalWon:input.maxTotalWon});return await search();}},
  fastResponses:false,
 },new MemorySaver() as never,undefined,undefined,groundedResponder as never);
 return {graph,requested,get searches(){return searches;},get modelCalls(){return modelCalls;},get groundedCalls(){return groundedCalls;},
  turn(userMessage:string,clientActionId=`action-${++sequence}`){return graph.invoke({actorUserId:"actor",conversationId:"conversation",requestId:`request-${sequence}`,clientActionId,userMessage});}};
}

test("a bare named product asks one optional budget question, then skip searches without asking again",async()=>{
 const s=setup();
 const first=await s.turn("마스크팩 추천해줘");
 assert.equal(first.explanation?.kind,"CLARIFICATION");
 assert.deepEqual(first.explanation?.clarification?.questions.map(q=>q.key),["budget"]);
 assert.equal(first.shoppingPlan?.query,"마스크팩");
 assert.equal(first.shoppingPlan?.maxTotalWon,null);
 assert.equal(first.ranking?.evaluatedCount,0);
 assert.equal(s.searches,0);assert.equal(s.modelCalls,0);assert.equal(s.groundedCalls,0);
 const skipped=await s.turn("상관없어요");
 assert.notEqual(skipped.explanation?.kind,"CLARIFICATION");
 assert.equal(skipped.shoppingPlan?.query,"마스크팩");
 assert.equal(skipped.shoppingPlan?.maxTotalWon,null);
 assert.equal(s.searches,1);assert.equal(s.modelCalls,0);assert.equal(s.groundedCalls,1);
});

test("choosing a budget preserves the named plan and searches once",async()=>{
 const s=setup();
 const first=await s.turn("마스크팩 추천해줘");
 assert.deepEqual(first.explanation?.clarification?.questions.map(q=>q.key),["budget"]);
 const answered=await s.turn("예산은 5만원 이하");
 assert.notEqual(answered.explanation?.kind,"CLARIFICATION");
 assert.equal(answered.shoppingPlan?.query,"마스크팩");
 assert.equal(answered.shoppingPlan?.maxTotalWon,50000);
 assert.deepEqual(s.requested,[{query:"마스크팩",maxTotalWon:50000}]);
 assert.equal(s.searches,1);
});

test("broad product-type answer does not prompt for a second budget",async()=>{
 const s=setup();
 const first=await s.turn("다이어트식품 추천해줘");
 assert.deepEqual(first.explanation?.clarification?.questions.map(q=>q.key),["product_type"]);
 const answered=await s.turn("두유쉐이크로");
 assert.notEqual(answered.explanation?.kind,"CLARIFICATION");
 assert.equal(answered.shoppingPlan?.query,"두유쉐이크");
 assert.equal(answered.shoppingPlan?.maxTotalWon,null);
 assert.deepEqual(s.requested,[{query:"두유쉐이크",maxTotalWon:null}]);
 assert.equal(s.searches,1);
});

test("an explicit budget and purpose answer resolves a pending question without a clarification loop",async()=>{
 const s=setup();
 await s.turn("마스크팩 추천해줘");
 const answered=await s.turn("예산은 5만원 이하, 선물용");
 assert.notEqual(answered.explanation?.kind,"CLARIFICATION");
 assert.equal(answered.shoppingPlan?.query,"마스크팩");
 assert.equal(answered.shoppingPlan?.maxTotalWon,50000);
 assert.deepEqual(answered.shoppingPlan?.requiredConditions,["선물용"]);
 assert.equal(s.modelCalls,1,"free-text budget plus purpose uses the model-backed intent mock");
 assert.equal(s.searches,1);
});

test("existing budget, explicit purpose or condition, and approved price memory skip optional budget",async()=>{
 const budget=setup();
 const budgetResult=await budget.turn("5만원 이하 마스크팩 추천해줘");
 assert.notEqual(budgetResult.explanation?.kind,"CLARIFICATION");
 assert.equal(budgetResult.shoppingPlan?.maxTotalWon,50000);
 assert.equal(budget.searches,1);
 for(const message of ["통화용 무선 이어폰 추천해줘","선물용 마스크팩 추천해줘"]){
  const s=setup(),result=await s.turn(message);
  assert.notEqual(result.explanation?.kind,"CLARIFICATION",message);
  assert.equal(s.searches,1,message);
 }
 const memory:Preference={userId:"actor",key:"price_priority",value:"value",
  sourceConversationId:"memory-source",sourceMessageId:"memory-message",updatedAt:"2026-10-20T00:00:00.000Z"};
 const remembered=setup(undefined,[memory]),result=await remembered.turn("마스크팩 추천해줘");
 assert.notEqual(result.explanation?.kind,"CLARIFICATION");
 assert.equal(remembered.searches,1);
 const unrelated:Preference={...memory,key:"eye_comfort",value:"important"};
 const eye=setup(undefined,[unrelated]),eyeResult=await eye.turn("마스크팩 추천해줘");
 assert.equal(eyeResult.explanation?.kind,"CLARIFICATION");
 assert.deepEqual(eyeResult.explanation?.clarification?.questions.map(q=>q.key),["budget"]);
 assert.equal(eye.searches,0);
});

test("broad food question asks one product type; its free-text answer keeps the budget",async()=>{
 const s=setup();
 const first=await s.turn("5만원 이하 다이어트식품 추천해줘");
 assert.equal(s.searches,0);
 assert.deepEqual(first.explanation?.clarification?.questions.map(q=>q.key),["product_type"]);
 assert.equal(first.shoppingPlan?.maxTotalWon,50000);
 const answered=await s.turn("두유쉐이크로");
 assert.equal(answered.shoppingPlan?.query,"두유쉐이크");
 assert.equal(answered.shoppingPlan?.maxTotalWon,50000);
 assert.equal(s.searches,1);
 assert.deepEqual(s.requested,[{query:"두유쉐이크",maxTotalWon:50000}]);
});

test("skipping the current product-type question retrieves the broad request and preserves budget",async()=>{
 const s=setup();
 const first=await s.turn("5만원 이하 식품 추천해줘");
 assert.deepEqual(first.explanation?.clarification?.questions.map(q=>q.key),["product_type"]);
 const skipped=await s.turn("상관없어요");
 assert.notEqual(skipped.explanation?.kind,"CLARIFICATION");
 assert.equal(skipped.shoppingPlan?.query,"식품");
 assert.equal(skipped.shoppingPlan?.maxTotalWon,50000);
 assert.equal(s.searches,1);
});

test("condition change reopens only the budget question after an optional gift purpose",async()=>{
 const s=setup();
 await s.turn("선물용 단백질 쉐이크 추천해줘");
 assert.equal(s.searches,1);
 const changed=await s.turn("조건 바꾸기");
 assert.deepEqual(changed.explanation?.clarification?.questions.map(q=>q.key),["budget"]);
 assert.equal(s.searches,1);
});

test("retrieval failure preserves the plan, sets its typed failure, and skips grounded LLM response",async()=>{
 const s=setup(async()=>{throw new Error("offline retrieval fixture");});
 const result=await s.turn("5만원 이하 마스크팩 추천해줘");
 assert.equal(result.explanation?.failure?.code,"RETRIEVAL_UNAVAILABLE");
 assert.equal(result.shoppingPlan?.query,"마스크팩");
 assert.equal(result.shoppingPlan?.maxTotalWon,50000);
 assert.equal(s.searches,1);assert.equal(s.groundedCalls,0);assert.equal(s.modelCalls,0);
});

test("an ordinary empty search with an explicit budget remains distinct from retrieval failure",async()=>{
 const s=setup();
 const result=await s.turn("5만원 이하 마스크팩 추천해줘");
 assert.equal(result.explanation?.failure,undefined);
 assert.equal(result.explanation?.kind,"NO_MATCH");
 assert.equal(result.shoppingPlan?.query,"마스크팩");
 assert.equal(result.shoppingPlan?.maxTotalWon,50000);
 assert.equal(s.searches,1);assert.equal(s.groundedCalls,1);
});

test("clarification action replay stays idempotent and does not retrieve",async()=>{
 const s=setup();
 const first=await s.turn("다이어트식품 추천해줘","same-clarification-action");
 const replay=await s.turn("다이어트식품 추천해줘","same-clarification-action");
 assert.deepEqual(replay.explanation,first.explanation);
 assert.deepEqual(replay.shoppingPlan?.interview?.pending,["product_type"]);
 assert.equal(s.searches,0);
});
