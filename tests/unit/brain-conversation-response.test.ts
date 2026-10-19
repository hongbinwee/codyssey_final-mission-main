import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createConversationResponder} from "../../src/brain/conversation-response.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {createDecisionsRouter} from "../../src/brain/decisions-route.ts";

const capability={kind:"CAPABILITY" as const,search:false,text:"기본 기능 안내"};
const previous={query:"수분크림",maxTotalWon:30000,requiredConditions:["무향"],currentPreferences:{},revision:2};

test("CAPABILITY calls configured Claude provider with no tools, not a product clarifier",async()=>{
 const calls:{messages:unknown;tools:unknown}[]=[];
 const responder=createConversationResponder({async chat(messages,tools){
  calls.push({messages,tools});
  return {content:"저는 예산과 사용 목적에 맞춰 상품을 찾고, 찜과 장바구니를 참고해 최대 세 가지 추천을 비교해 드려요."};
 }});
 const result=await responder({message:"넌 뭘 할수있어?",route:capability,previous});
 assert.equal(result.kind,"CONVERSATION");
 assert.match(result.text,/찜과 장바구니/);
 assert.ok(!result.text.includes("어떤 상품이나 조건을"));
 assert.deepEqual(calls[0]?.tools,[]);
 assert.match(JSON.stringify(calls[0]?.messages),/넌 뭘 할수있어/);
 assert.equal(calls.length,1);
});

test("purchase history, delivery and cancellation requests remain deterministic and distinct",async()=>{
 let invoked=0;
 const respond=createConversationResponder({async chat(){invoked++;throw Error("must not run");}});
 const cases=[
  ["나 엊그제 뭐 구매했었지","이전 구매 내역을 확인하고 싶으시군요!",/취소|반품|배송/],
  ["나 어제 뭐 샀지","이전 구매 내역을 확인하고 싶으시군요!",/취소|반품|배송/],
  ["지난주 산 거 뭐였지","이전 구매 내역을 확인하고 싶으시군요!",/취소|반품|배송/],
  ["내 주문 배송은?","배송 상황을 확인하고 싶으시군요.",/취소|이전 구매 내역/],
  ["내 주문 취소해줘","주문 취소·반품 같은 변경 요청은 이 대화에서 아직 처리할 수 없어요.",/이전 구매 내역|배송 상황/],
 ] as const;
 for(const [message,expected,forbidden] of cases){
  const result=await respond({message,route:{kind:"CS_REQUEST",search:false,text:"기존 라우터 안내"}});
  assert.equal(result.text.includes(expected),true,message);
  assert.doesNotMatch(result.text,forbidden,message);
  assert.deepEqual(result.items,[]);
 }
 assert.equal(invoked,0);
});
test("provider errors and attempted tool calls fail closed without pretending the model replied",async()=>{
 for(const provider of [
  {async chat(){throw Error("LLM http 429");}},
  {async chat(){return {content:"장바구니 변경 완료",tool_calls:[{id:"x",name:"add_to_cart",arguments:"{}"}]};}},
 ]){
  const result=await createConversationResponder(provider)({message:"너는 뭘 할 수 있어?",route:capability});
  assert.equal(result.kind,"CONVERSATION");
  assert.ok(result.failure);
  assert.ok(!result.text.includes("변경 완료"));
 }
});

test("an async typed Decisions route reaches Claude converse with no retrieval or preference mutation",async()=>{
 let decisions=0,llm=0,search=0,plans=0,memWrites=0;
 const route=async()=>{decisions++;return capability;};
 const converse=createConversationResponder({async chat(messages,tools){
  llm++;assert.deepEqual(tools,[]);
  assert.match(JSON.stringify(messages),/넌 뭘 할수있어/);
  return {content:"안녕하세요! 구매 목적과 예산을 알려주시면 상품 비교를 도와드려요."};
 }});
 const graph=createPersistentResearchGraph({
  route,converse,datasetVersion:"fixture-t2",fastResponses:true,
  conversations:{async assertOwned(){},async appendUserMessage(){return "m1";}},
  memory:{async list(){return []},async save(){memWrites++;}},
  intent:{async extract(){plans++;throw Error("intent not needed");}},
  retriever:{async search(){search++;throw Error("search not needed");}}
 } as never,new MemorySaver() as never);
 const input={actorUserId:"qa-actor",conversationId:"qa-conv",requestId:"r1",clientActionId:"c1",userMessage:"넌 뭘 할수있어?"};
 const result=await graph.invoke(input);
 assert.equal(result.intentKind,"CAPABILITY");
 assert.equal(result.explanation?.kind,"CONVERSATION");
 assert.match(result.explanation?.text??"",/예산/);
 assert.equal(result.datasetVersion,"fixture-t2");
 assert.deepEqual([decisions,llm,search,plans,memWrites],[1,1,0,0,0]);
 assert.ok((result.trace.routeMs??-1)>=0);
 assert.ok((result.trace.responseMs??-1)>=0);
 assert.equal((await graph.invoke(input)).messageId,"m1");
 assert.deepEqual([decisions,llm,search,plans],[1,1,0,0]);
});

test("Decisions mocked CAPABILITY is parsed then independently rendered by provider",async()=>{
 const mockResponse={ok:true,json:async()=>({answers:[{type:"choice",name:"intent",choice:"CAPABILITY",confidence:.91,
  probabilities:[{value:"CAPABILITY",probability:.91},{value:"SHOPPING_SEARCH",probability:.09}]}]})};
 const decisions=createDecisionsRouter({apiKey:"test-key",fetcher:(async()=>mockResponse) as never});
 const route=await decisions("넌 뭘 할수있어?");
 assert.equal(route.kind,"CAPABILITY");assert.equal(route.search,false);
 const result=await createConversationResponder({async chat(){return {content:"저는 쇼핑 상품을 찾아 비교하고 리뷰 근거를 알려드려요."};}})({
  message:"넌 뭘 할수있어?",route});
 assert.match(result.text,/상품을 찾아 비교/);
});
