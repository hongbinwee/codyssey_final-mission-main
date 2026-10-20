import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {summarizeHermesEvaluation,evaluateHermesGate,type HermesEvalCase} from "../../src/brain/hermes-evaluation.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";

/**
 * Evaluation-only paraphrases: these are NOT implemented Agent routing rules.
 * A scripted model stub tests graph/tool contracts. Real model quality remains NOT_MEASURED.
 */
const inputs=[
 {id:"c01",kind:"CART",text:"내 장바구니 보여줘"},
 {id:"c02",kind:"CART",text:"장바구니에 뭐 있어?"},
 {id:"c03",kind:"CART",text:"카트에 담긴 것 확인해줘"},
 {id:"c04",kind:"CART",text:"장바구니 확인"},
 {id:"o01",kind:"ORDERS",text:"내 주문 조회"},
 {id:"o02",kind:"ORDERS",text:"내 주문 목록 보여줘"},
 {id:"o03",kind:"ORDERS",text:"주문 내역 알려줘"},
 {id:"o04",kind:"ORDERS",text:"제 주문 목록 확인"},
 {id:"s01",kind:"SHIPPING",text:"내 주문 배송 어디까지 왔어?"},
 {id:"s02",kind:"SHIPPING",text:"택배 배송 상태 알려줘"},
 {id:"s03",kind:"SHIPPING",text:"배송 상태 알려줘"},
 {id:"s04",kind:"SHIPPING",text:"내 주문 배송 조회"}
] as const;
test("H6 invariant QA measures multi-phrase LangGraph Tool paths and zero unnecessary RAG",async()=>{
 const scores:HermesEvalCase[]=[];
 for(const entry of inputs){
  const actorUserId="actor-"+entry.id;
  const tools:string[]=[];
  let retrievals=0,modelCalls=0;
  const provider={chat:async(messages:Array<{content?:string|null}>)=>{
   modelCalls++;
   const data=JSON.parse(messages.at(-1)?.content??"{}");
   const seen=data.observed_tools??[];
   if(!seen.length)return {content:null,tool_calls:[{id:"first",name:entry.kind==="CART"?"get_cart":"get_orders",arguments:"{}"}]};
   if(entry.kind==="SHIPPING"&&seen.at(-1).tool==="get_orders")
    return {content:null,tool_calls:[{id:"shipping",name:"get_shipping_status",arguments:'{"order_id":"owned-order"}'}]};
   return {content:"조회 완료"};
  }};
  const deps={conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
   memory:{list:async()=>[]},
   intent:{extract:async()=>{throw Error("Unexpected shopping plan");}},
   retriever:{search:async()=>{retrievals++;throw Error("Unnecessary RAG");}},
   hermes:{provider,history:async()=>[],reviewCount:async()=>null,
    toolPorts:(actor:string)=>{
     assert.equal(actor,actorUserId);
     return {
      cart:async()=>{tools.push("get_cart");return {items:[],itemCount:0,itemsTotalWon:0,
       shippingFeeWon:0,totalWon:0,canCheckout:false};},
      orders:async()=>{tools.push("get_orders");return {orders:[{orderId:"owned-order",
       itemSummary:"이어폰",status:"CONFIRMED",createdAt:"today",totalWon:10000,shippingStatus:"PREPARING",
       cancelEligible:false}],hasMore:false};},
      shipping:async(id:string)=>{assert.equal(id,"owned-order");tools.push("get_shipping_status");
       return {orderId:id,information:"AVAILABLE",status:"PREPARING",estimatedArrivalAt:null,events:[]};}
     };
    }}
  } as unknown as ResearchDeps;
  const start=performance.now();
  const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke({
   actorUserId,conversationId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),
   requestId:crypto.randomUUID(),userMessage:entry.text
  });
  const expected=entry.kind==="CART"?["get_cart"]:entry.kind==="ORDERS"?["get_orders"]:
   ["get_orders","get_shipping_status"];
  assert.deepEqual(tools,expected,entry.id);
  assert.equal(retrievals,0,entry.id);
  assert.equal(result.trace.hermesToolCalls,expected.length,entry.id);
  assert.equal(result.trace.hermesFailedTools,0,entry.id);
  assert.equal(result.trace.hermesDecisions,modelCalls,entry.id);
  assert.ok(result.trace.hermesDecisionMs>=0,entry.id);
  assert.ok(result.trace.hermesToolMs>=0,entry.id);
  scores.push({caseId:entry.id,mode:"DETERMINISTIC_MOCK",expectedTools:expected as HermesEvalCase["expectedTools"],
   actualTools:tools as HermesEvalCase["actualTools"],searchRequired:false,
   outcomeExpected:"ANSWERED",outcomeActual:"ANSWERED",grounded:null,actorIsolated:null,
   writeWithoutApproval:false,durationMs:performance.now()-start});
 }
 const summary=summarizeHermesEvaluation(scores);
 assert.equal(summary.cases,inputs.length);
 assert.equal(summary.toolSequenceExact.rate,1);
 assert.equal(summary.unnecessarySearch.count,0);
 assert.equal(summary.latencyMs.p95!==null,true);
 assert.equal(summary.liveModelValidated,false);
 assert.equal(summary.connectedE2eValidated,false);
 const gate=evaluateHermesGate(summary,{minExactToolRate:.9,maxUnnecessarySearchRate:0,
  maxP95Ms:30000,requireLiveModel:true,requireConnectedE2e:true});
 assert.equal(gate.passed,false);
 assert.ok(gate.reasons.includes("LIVE_MODEL_NOT_MEASURED"));
});
