import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createFastIntentPort} from "../../src/brain/fast-intent.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {routeBrainMessage} from "../../src/brain/routing.ts";
import type {EvidenceRecord,ProductCandidate} from "../../src/brain/contracts.ts";

function setup(search:()=>Promise<{candidates:ProductCandidate[];evidence:EvidenceRecord[]}> = async()=>({candidates:[],evidence:[]})){
 let searches=0,modelCalls=0,groundedCalls=0,sequence=0;
 const requested:{query:string;maxTotalWon:number|null}[]=[];
 const intent=createFastIntentPort({async extract(message,_memories,previous){
  modelCalls++;
  return {query:previous?.query??message,queryMode:previous?"KEEP":"SET",
   budgetMode:"KEEP",requirementsMode:"KEEP",
   context:{maxTotalWon:previous?.maxTotalWon??null,requiredConditions:previous?.requiredConditions??[],currentPreferences:{}}};
 }});
 const groundedResponder=async()=>{
  groundedCalls++;
  return {kind:"NO_MATCH",text:"fixture",items:[],limitations:[]};
 };
 const graph=createPersistentResearchGraph({
  clarifyBeforeSearch:true,
  conversations:{async assertOwned(){},async appendUserMessage(_actor,_conversation,action){return action;}},
  memory:{async list(){return [];},async put(){},async delete(){return false;}},
  route:routeBrainMessage,intent,
  retriever:{async search(input){searches++;requested.push({query:input.query,maxTotalWon:input.maxTotalWon});return await search();}},
  fastResponses:false,
 },new MemorySaver() as never,undefined,undefined,groundedResponder as never);
 return {graph,requested,get searches(){return searches;},get modelCalls(){return modelCalls;},get groundedCalls(){return groundedCalls;},
  turn(userMessage:string,clientActionId=`action-${++sequence}`){return graph.invoke({actorUserId:"actor",conversationId:"conversation",requestId:`request-${sequence}`,clientActionId,userMessage});}};
}

test("specific named product types search directly without an interview",async()=>{
 for(const product of ["단백질 쉐이크","마스크팩","식기세척기 세제"]){
  const s=setup();
  const result=await s.turn(`${product} 추천해줘`);
  assert.notEqual(result.explanation?.kind,"CLARIFICATION",product);
  assert.equal(s.searches,1,product);
  assert.equal(s.modelCalls,0,product);
 }
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

test("an ordinary empty search remains distinct from retrieval failure",async()=>{
 const s=setup();
 const result=await s.turn("마스크팩 추천해줘");
 assert.equal(result.explanation?.failure,undefined);
 assert.equal(result.explanation?.kind,"NO_MATCH");
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
