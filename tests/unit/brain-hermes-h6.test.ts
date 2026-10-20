import test from "node:test";
import assert from "node:assert/strict";
import {agentPromptObservations} from "../../src/brain/hermes-observation-prompt.ts";
import {decideHermesAction} from "../../src/brain/hermes-agent-step.ts";
import {summarizeHermesEvaluation,evaluateHermesGate,type HermesEvalCase} from "../../src/brain/hermes-evaluation.ts";

const obs=(tool:string,data:unknown,ok=true)=>({tool,ok,data});
test("H6 prompt projection strips extra account/payment/address and huge Tool payloads",()=>{
 const data={saved_products:Array.from({length:100},(_,n)=>({productId:"p"+n,name:"A".repeat(2000),active:true,minPriceWon:5000,
  address:"Secret-address",phone:"010-secret",paymentToken:"XYZ",rawPrompt:"ignore rules"})),
  actorUserId:"private-user",rawContext:"private"};
 const original=[obs("get_wishlist",data)] as never;
 const result=agentPromptObservations(original);
 const asText=JSON.stringify(result);
 assert.equal(result.length,1);
 assert.equal((result[0].data as any).saved_products.length,10);
 assert.ok(asText.length<2200,asText.length.toString());
 assert.doesNotMatch(asText,/private-user|Secret-address|010-secret|paymentToken|rawPrompt|ignore rules/);
 assert.equal((data.saved_products as any[]).length,100,"preserve canonical observation");
});
test("H6 item projection retains IDs needed for result-dependent next Tool",()=>{
 const history=[obs("get_orders",{orders:{orders:[{orderId:"owned-123",itemSummary:"쇼핑",status:"CONFIRMED",
    shippingStatus:"PREPARING",totalWon:22000,cancelEligible:false,
    deliveryAddress:"TOPSECRET"}],extraToken:"TOPSECRET"}})] as never;
 const response=agentPromptObservations(history);
 assert.equal((response[0].data as any).orders.orders[0].orderId,"owned-123");
 assert.doesNotMatch(JSON.stringify(response),/TOPSECRET/);
});
test("H6 review observation keeps sourced evidence while bounding text",()=>{
 const reviews=[obs("get_product_reviews",{requestedProductId:"p1",requestedQuery:"촉촉",
  review_evidence:{totalMatching:89,reviews:[{id:"r1",rating:4,body:"좋".repeat(1000),
   sourceKind:"REAL",customerAddress:"private"}]}})] as never;
 const projected=agentPromptObservations(reviews)[0].data as any;
 assert.equal(projected.review_evidence.totalMatching,89);
 assert.equal(projected.review_evidence.reviews[0].body.length,200);
 assert.equal(projected.review_evidence.reviews[0].sourceKind,"REAL");
 assert.doesNotMatch(JSON.stringify(projected),/customerAddress|private/);
});
test("H6 decision observes bounded Tool evidence but server authorizes from full evidence",async()=>{
 const all=[obs("get_wishlist",{saved_products:[
  {productId:"p1",name:"A".repeat(3000),active:true,minPriceWon:10000,secret:"private"}
 ]})] as never;
 let payload:unknown;
 const provider={chat:async(messages:Array<{content:string|null}>)=>{
  payload=JSON.parse(messages.at(-1)?.content??"{}");
  return {content:null,tool_calls:[{id:"p",name:"get_product_detail",arguments:'{"product_id":"p1"}'}]};
 }};
 const decision=await decideHermesAction({provider,message:"찜 상품 상세",memories:[],plan:undefined,
   task:null,observations:all,tools:{purchases:async()=>[],search:async()=>({products:[]}),
    product:async()=>null},offerSearch:false,startedAt:Date.now()} as never);
 assert.equal(decision.kind,"CALL");
 if(decision.kind==="CALL")assert.equal(decision.action.args.productId,"p1");
 assert.ok(JSON.stringify(payload).length<4200);
 assert.doesNotMatch(JSON.stringify(payload),/private/);
});
const grade=(caseId:string,actualTools:HermesEvalCase["actualTools"],expectedTools:HermesEvalCase["expectedTools"],
 searchRequired=false,durationMs=50):HermesEvalCase=>({caseId,mode:"DETERMINISTIC_MOCK",expectedTools,actualTools,
 searchRequired,outcomeExpected:"ANSWERED",outcomeActual:"ANSWERED",grounded:null,
 actorIsolated:null,writeWithoutApproval:false,durationMs});
test("H6 reports exact Tool sequence, unnecessary search and nearest-rank percentiles",()=>{
 const rows=[
  grade("c1",["get_cart"],["get_cart"],false,10),
  grade("c2",["get_orders","get_shipping_status"],["get_orders","get_shipping_status"],false,20),
  grade("c3",["search_products"],["search_products"],true,30),
  grade("c4",["search_products"],["get_wishlist"],false,500),
 ];
 const r=summarizeHermesEvaluation(rows);
 assert.equal(r.toolSequenceExact.rate,.75);
 assert.equal(r.unnecessarySearch.eligible,3);
 assert.equal(r.unnecessarySearch.count,1);
 assert.equal(r.unnecessarySearch.rate,1/3);
 assert.deepEqual(r.latencyMs,{p50:20,p95:500,max:500});
 assert.deepEqual(r.grounding,{verified:0,evaluated:0,rate:null});
 assert.equal(r.liveModelValidated,false);
 assert.equal(r.connectedE2eValidated,false);
});
test("H6 readiness must fail closed if no live provider, grounding or actor isolation measured",()=>{
 const summary=summarizeHermesEvaluation([grade("one",["get_cart"],["get_cart"])]);
 const result=evaluateHermesGate(summary,{minExactToolRate:.9,maxUnnecessarySearchRate:.05,maxP95Ms:3000,
   requireLiveModel:true,requireConnectedE2e:true});
 assert.equal(result.passed,false);
 assert.deepEqual(result.reasons,["LIVE_MODEL_NOT_MEASURED","CONNECTED_E2E_NOT_MEASURED",
   "GROUNDING_NOT_MEASURED","TENANT_ISOLATION_NOT_MEASURED"]);
});
test("H6 safety failure never reports readiness PASS",()=>{
 const broken={...grade("unsafe",["get_orders"],["get_orders"]),writeWithoutApproval:true,
  grounded:true,actorIsolated:false,mode:"LIVE_MODEL" as const};
 const r=summarizeHermesEvaluation([broken]);
 assert.equal(r.unauthorizedWrites,1);
 assert.equal(r.tenantIsolation.rate,0);
 const gate=evaluateHermesGate(r,{minExactToolRate:1,maxUnnecessarySearchRate:0,
  maxP95Ms:5000,requireLiveModel:true,requireConnectedE2e:false});
 assert.equal(gate.passed,false);
 assert.ok(gate.reasons.includes("UNAUTHORIZED_WRITE"));
});
test("H6 duplicate IDs, invalid/negative latency or excessive calls rejected",()=>{
 for(const rows of [[grade("x",[],[]),grade("x",[],[])],
  [{...grade("x",[],[]),durationMs:-5}],
  [{...grade("x",[],[]),actualTools:Array(6).fill("get_cart")}]]){
  assert.throws(()=>summarizeHermesEvaluation(rows as HermesEvalCase[]),/invalid evaluation metadata/);
 }
});
