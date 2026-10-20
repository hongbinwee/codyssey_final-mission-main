import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {decideHermesAction,readAgentRoute,summarizeAgentObservations} from "../../src/brain/hermes-agent-step.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";
import type {ProductCandidate} from "../../src/brain/contracts.ts";

const candidate=(id:string,price:number):ProductCandidate=>({
 productId:id,variantId:"v-"+id,productName:"상품 "+id,unitPriceWon:price,
 shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,
 wholeReviewCountVerified:false,conditions:{},facets:{},sourceKind:"REAL",commerceVerified:true
});
function baseDeps(provider:NonNullable<ResearchDeps["hermes"]>["provider"],tools:Record<string,unknown>={}){
 let retrievals=0,plans=0;
 const deps={
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},
  intent:{extract:async()=>{plans++;return {query:"이어폰",context:{category:"audio",maxTotalWon:50000,requiredConditions:[],currentPreferences:{}}};}},
  retriever:{search:async()=>{retrievals++;return {candidates:[candidate("p1",10000)],evidence:[]};}},
  hermes:{provider,history:async()=>[],reviewCount:async()=>null,toolPorts:()=>tools}
 } as unknown as ResearchDeps;
 return {deps,getCounts:()=>({retrievals,plans})};
}
const request=(message:string,id=crypto.randomUUID())=>({actorUserId:"actor-a",conversationId:id,
 requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage:message});

test("H4 order → shipping uses observed order ID, zero product/RAG search",async()=>{
 const toolCalls:string[]=[];
 const provider={chat:async(messages:Array<{content?:string|null}>)=>{
  const obs=JSON.parse(messages.at(-1)?.content??"{}").observed_tools??[];
  if(!obs.length)return {content:null,tool_calls:[{id:"o",name:"get_orders",arguments:"{}"}]};
  if(obs.at(-1).tool==="get_orders")return {content:null,tool_calls:[{id:"s",name:"get_shipping_status",arguments:'{"order_id":"order-a"}'}]};
  return {content:"확인했어요"};
 }};
 const {deps,getCounts}=baseDeps(provider,{
  orders:async()=>{toolCalls.push("orders");return {orders:[{orderId:"order-a",itemSummary:"이어폰",status:"CONFIRMED",shippingStatus:"IN_TRANSIT",totalWon:30000,createdAt:"today",cancelEligible:false}],hasMore:false};},
  shipping:async(id:string)=>{toolCalls.push("shipping "+id);return {orderId:id,information:"AVAILABLE",status:"IN_TRANSIT",estimatedArrivalAt:null,events:[]};}
 });
 const graph=createPersistentResearchGraph(deps,new MemorySaver() as never);
 const result=await graph.invoke(request("내 주문 배송 어디까지 왔어?"));
 assert.deepEqual(toolCalls,["orders","shipping order-a"]);
 assert.deepEqual(getCounts(),{retrievals:0,plans:0});
 assert.equal(result.taskState?.kind,"ORDER");
 assert.equal(result.trace.hermesToolCalls,2);
 assert.match(result.explanation?.text??"",/IN_TRANSIT/);
 assert.deepEqual(result.ranking.ranked,[]);
});

test("H4 cart read ends without a forced product search",async()=>{
 let cartCalls=0;
 const provider={chat:async(messages:Array<{content?:string|null}>)=>{
  const obs=JSON.parse(messages.at(-1)?.content??"{}").observed_tools??[];
  return obs.length?{content:"완료"}:{content:null,tool_calls:[{id:"c",name:"get_cart",arguments:"{}"}]};
 }};
 const {deps,getCounts}=baseDeps(provider,{cart:async()=>{cartCalls++;return {items:[{productId:"p1",variantId:"v1",productName:"이어폰",quantity:2,unitPriceWon:10000,availability:"AVAILABLE"}],itemCount:1,itemsTotalWon:20000,shippingFeeWon:3000,totalWon:23000,canCheckout:true};}});
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke(request("장바구니에 뭐 있어?"));
 assert.equal(cartCalls,1);
 assert.equal(result.taskState?.kind,"CART");
 assert.match(result.explanation?.text??"",/23,000원/);
 assert.equal(result.trace.hermesToolCalls,1);
 assert.deepEqual(getCounts(),{retrievals:0,plans:0});
});

test("H4 user-specified order cancellation remains on guarded UI path",async()=>{
 const {deps,getCounts}=baseDeps({chat:async()=>{throw Error("model must not run");}},{
  orders:async()=>{throw Error("read not requested");}
 });
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke(request("내 주문 취소해 줘"));
 assert.equal(result.taskState?.kind,"ORDER");
 assert.match(result.explanation?.text??"",/주문 화면/);
 assert.deepEqual(getCounts(),{retrievals:0,plans:0});
});

test("H4 recommendation: LLM observes owned history before deciding to search",async()=>{
 const seen:string[]=[];
 const provider={chat:async(messages:Array<{content?:string|null}>)=>{
  const obs=JSON.parse(messages.at(-1)?.content??"{}").observed_tools??[];
  if(!obs.length)return {content:null,tool_calls:[{id:"hist",name:"get_purchase_history",arguments:"{}"}]};
  if(obs.at(-1).tool==="get_purchase_history"){seen.push("history-observed");return {content:null,tool_calls:[{id:"search",name:"search_products",arguments:"{}"}]};}
  if(obs.at(-1).tool==="search_products"){seen.push("rank-observed");return {content:"완료"};}
  throw Error("unexpected");
 }};
 const {deps,getCounts}=baseDeps(provider);
 deps.hermes!.history=async()=>[{productId:"old",variantId:"old-v",productName:"기존 이어폰",category:"audio",unitPriceWon:20000,purchasedAt:"2026-10-20"}];
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never)
  .invoke(request("전에 산 이어폰보다 더 저렴한 이어폰 추천해줘"));
 assert.deepEqual(seen,["history-observed","rank-observed"]);
 assert.equal(getCounts().retrievals,1);
 assert.equal(result.ranking.ranked[0]?.candidate.productId,"p1");
 assert.equal(result.trace.hermesToolCalls,2);
});

test("H4 model unavailable on order read does not trigger RAG or fake order",async()=>{
 const {deps,getCounts}=baseDeps({chat:async()=>{throw Error("LLM timeout");}},{
  orders:async()=>{throw Error("should not call");}
 });
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke(request("내 주문 조회"));
 assert.deepEqual(getCounts(),{retrievals:0,plans:0});
 assert.match(result.explanation?.text??"",/확인된 조회 결과가 없어요/);
 assert.equal(result.trace.hermesToolCalls,0);
});
test("tool-policy router distinguishes reads from sensitive writes",()=>{
 for(const m of ["장바구니에 뭐 있어?","내 주문 조회","배송 어디쯤이야","택배 상황 알려줘",
   "최근 주문의 상세 구성과 총 주문 금액 보여줘","장바구니에 담아 둔 상품 옵션 조회해줘",
   "장바구니에 담아놓은 상품 옵션 확인해줘"])
  assert.equal(readAgentRoute(m),true,m);
 for(const m of ["주문 취소해 줘","결제 내역 확인","장바구니에 넣어 줘","장바구니에 담아줘",
   "장바구니에 담아 주세요","반품 진행해",
   "무료배송 상품 추천해줘","배송 빠른 이어폰 추천해줘","내 주문 제품 중 다른 상품 추천해줘"])
  assert.equal(readAgentRoute(m),false,m);
});
test("model cannot use guessed product ID or execute a write",async()=>{
 const base={provider:{chat:async()=>({content:null,tool_calls:[{id:"x",name:"get_product_detail",arguments:'{"product_id":"guessed"}'}]})},
  message:"상품 설명해줘",memories:[],task:null,observations:[],tools:{purchases:async()=>[],search:async()=>({products:[]}),product:async()=>{throw Error("forbidden");}},offerSearch:true,startedAt:Date.now()};
 const answer=await decideHermesAction(base as never);
 assert.deepEqual(answer,{kind:"FINISH",reason:"INVALID"});
});
test("server responses never invent order details when no Tool ran",()=>{
 assert.match(summarizeAgentObservations([]),/확인된 조회 결과가 없어요/);
});

test("H4 explicit product discovery recovers with verified retrieval when model stops prematurely",async()=>{
 const {deps,getCounts}=baseDeps({chat:async()=>({content:"완료"})});
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never)
  .invoke(request("무선 이어폰 추천해줘"));
 assert.equal(getCounts().retrievals,1);
 assert.equal(result.ranking.ranked[0]?.candidate.productId,"p1");
 assert.equal(result.trace.hermesRecovered,1);
});
test("H4 missing shopping requirement can ask a question without an unnecessary RAG call",async()=>{
 const {deps,getCounts}=baseDeps({chat:async()=>({content:"어느 용도의 이어폰을 찾으세요?"})});
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never)
  .invoke(request("무선 이어폰 추천해줘"));
 assert.equal(getCounts().retrievals,0);
 assert.match(result.explanation?.text??"",/용도의 이어폰/);
});

test("H4 agent clarification is checkpointed and a neutral answer resumes the same shopping task",async()=>{
 const {routeBrainMessage}=await import("../../src/brain/routing.ts");
 const provider={chat:async(messages:Array<{content?:string|null}>)=>{
  const data=JSON.parse(messages.at(-1)?.content??"{}");
  if(data.user_message==="무선 이어폰 추천해줘")return {content:"어떤 상황에서 사용할 이어폰을 찾으세요?"};
  if(data.user_message==="상관없어요"){
   if(!data.observed_tools.length)return {content:null,tool_calls:[{id:"s",name:"search_products",arguments:"{}"}]};
   return {content:"검증 완료"};
  }
  return {content:"완료"};
 }};
 const {deps,getCounts}=baseDeps(provider);
 deps.route=routeBrainMessage;
 const thread=crypto.randomUUID();
 const graph=createPersistentResearchGraph(deps,new MemorySaver() as never);
 const first=await graph.invoke(request("무선 이어폰 추천해줘",thread));
 assert.equal(first.taskState?.kind,"DISCOVERY");
 assert.equal(first.taskState?.phase,"AWAITING_INPUT");
 assert.equal(first.taskState?.pendingQuestion,"agent_followup");
 assert.equal(getCounts().retrievals,0);
 const second=await graph.invoke(request("상관없어요",thread));
 assert.equal(getCounts().retrievals,1);
 assert.equal(second.taskState?.phase,"ACTIVE");
 assert.equal(second.ranking.ranked[0]?.candidate.productId,"p1");
});

test("H4 product summary uses the cheapest actually available option and explicit shipping fee",()=>{
 const text=summarizeAgentObservations([{tool:"get_product_detail",ok:true,data:{product:{
  name:"무선 이어폰",active:true,shippingFeeWon:3000,variants:[
   {priceWon:5000,availability:"SOLD_OUT"},{priceWon:20000,availability:"AVAILABLE"},
   {priceWon:14000,availability:"AVAILABLE"}]}}}]);
 assert.match(text,/14,000원/);
 assert.match(text,/배송비는 3,000원/);
 assert.doesNotMatch(text,/5,000원/);
});

test("H4 verified summaries combine cart, deduplicated order details and honest shipping; arrival routing stays scoped",()=>{
 const text=summarizeAgentObservations([
  {tool:"get_cart",ok:true,data:{cart:{items:[{productId:"product-private-cart",productName:"무선 이어폰",quantity:1,availability:"SOLD_OUT"}],totalWon:22000}}},
  {tool:"get_orders",ok:true,data:{orders:{orders:[
   {orderId:"order-private-42",itemSummary:"무선 이어폰 외 1건",status:"PAID",totalWon:65000,shippingStatus:"IN_TRANSIT"},
   {orderId:"order-private-43",itemSummary:"키보드",status:"SHIPPED",totalWon:40000,shippingStatus:"IN_TRANSIT"}
  ],hasMore:false}}},
  {tool:"get_order",ok:true,data:{requestedOrderId:"order-private-42",order:{orderId:"order-private-42",status:"PAID",totalWon:65000,shippingStatus:"IN_TRANSIT",items:[
   {productId:"product-private-order",productName:"무선 이어폰",quantity:1},
   {productId:"product-private-case",productName:"케이스",quantity:2}
  ]}}},
  {tool:"get_shipping_status",ok:true,data:{requestedOrderId:"order-private-42",shipping:{orderId:"order-private-42",information:"NO_INFORMATION",status:null,estimatedArrivalAt:null}}}
 ],"모델이 생성한 최종 답변은 관측 사실이 아니에요.");
 assert.match(text,/장바구니에 무선 이어폰 1개가 있어요/);
 assert.match(text,/현재 합계는 22,000원/);
 assert.match(text,/장바구니 상품 상태: 무선 이어폰 품절/);
 assert.match(text,/주문 상품: 무선 이어폰 1개, 케이스 2개/);
 assert.match(text,/키보드/);
 assert.match(text,/배송 정보가 아직 등록되지 않았어요/);
 assert.equal(text.split("주문 상품: ").length-1,1);
 assert.doesNotMatch(text,/무선 이어폰 외 1건|order-private|product-private|모델이 생성한 최종 답변/);
 assert.equal(readAgentRoute("주문은 언제 도착해?"),true);
 for(const message of ["배송 빠른 제품 추천해줘","무료배송 상품 추천해줘","다른 상품 배송은 언제야?"])
  assert.equal(readAgentRoute(message),false,message);
});
