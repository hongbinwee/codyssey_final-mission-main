import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {parseAgentSearchIntent} from "../../src/brain/agent-search-intent.ts";
import {resolveShoppingPlan} from "../../src/brain/shopping-plan.ts";
import {isScopedProsConsFollowup,canFinishSimpleDiscovery} from "../../src/brain/agent-v2-flow.ts";
import {appendAgentToolTranscript} from "../../src/brain/hermes-agent-step.ts";
import {hermesToolDefinitions} from "../../src/brain/hermes-tools.ts";
import type {ProductCandidate} from "../../src/brain/contracts.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";
const request=(message:string)=>({actorUserId:"actor-a",conversationId:crypto.randomUUID(),
 requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage:message});
const candidate:ProductCandidate={productId:"p-serum",variantId:"v-serum",productName:"세럼",
 unitPriceWon:15000,shippingFeeWon:2500,rating:null,ratingScale:null,wholeReviewCount:null,
 wholeReviewCountVerified:false,conditions:{},facets:{},sourceKind:"REAL",commerceVerified:true};
const searchIntent=(more:Record<string,unknown>={})=>({intent:{
 query:"세럼",maxTotalWon:null,requiredConditions:[],currentPreferences:{},queryMode:"SET",
 budgetMode:"CLEAR",requirementsMode:"REPLACE",...more
}});
function deps(chat:(messages:{role:string;content:string|null}[],defs:unknown)=>Promise<unknown>){
 let intentCalls=0,retrievals=0,modelCalls=0,lastQuery:unknown;
 const data={
  agentPlanning:true,clarifyBeforeSearch:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},
  intent:{extract:async()=>{intentCalls++;throw Error("legacy planner must not run");}},
  retriever:{search:async(query:unknown)=>{retrievals++;lastQuery=query;return {candidates:[candidate],evidence:[]};}},
  hermes:{provider:{chat:async(messages:unknown,defs:unknown)=>{modelCalls++;return chat(messages as never,defs);}},
   history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 return {data,counts:()=>({intentCalls,retrievals,modelCalls,lastQuery})};
}
test("V2 extracts Plan and calls search_products from a SINGLE model decision",async()=>{
 const audit=deps(async(messages,defs)=>{
  const names=(defs as Array<{function:{name:string;parameters:unknown}}>).map(x=>x.function.name);
  assert.ok(names.includes("search_products"));
  const prompt=JSON.parse(messages.at(-1)?.content??"{}");
  assert.equal(prompt.user_message,"세럼 추천해줘");
  return {content:null,tool_calls:[{id:"one",name:"search_products",
   arguments:JSON.stringify(searchIntent())}]};
 });
 const result=await createPersistentResearchGraph(audit.data,new MemorySaver() as never)
  .invoke(request("세럼 추천해줘"));
 assert.deepEqual({intentCalls:audit.counts().intentCalls,retrievals:audit.counts().retrievals,modelCalls:audit.counts().modelCalls},
  {intentCalls:0,retrievals:1,modelCalls:1});
 assert.equal(result.shoppingPlan?.query,"세럼");
 assert.equal(result.ranking.ranked[0]?.candidate.productId,"p-serum");
 assert.equal(result.trace.hermesDecisions,1);
});
test("V2 Tool schema requires proposed search intent, legacy schema remains empty",()=>{
 const tools={purchases:async()=>[],search:async()=>({products:[]})};
 const old=hermesToolDefinitions(tools,true);
 const next=hermesToolDefinitions(tools,true,true);
 assert.deepEqual(old.find(x=>x.function.name==="search_products")?.function.parameters,{type:"object",properties:{},additionalProperties:false});
 assert.deepEqual((next.find(x=>x.function.name==="search_products")?.function.parameters as {required:string[]}).required,["intent"]);
});
test("V2 denies invented hard conditions and silent budget deletion",()=>{
 const forged=searchIntent({requiredConditions:["피부과 인증"]});
 assert.equal(parseAgentSearchIntent(forged,"세럼 추천해줘"),null);
 const previous={query:"세럼",revision:1,maxTotalWon:30000,requiredConditions:["무향"],
  currentPreferences:{}} as const;
 assert.equal(parseAgentSearchIntent(searchIntent({query:"세럼",queryMode:"KEEP",budgetMode:"CLEAR",requiredConditions:[]}),
  "다른 거 추천해줘",previous as never),null);
});
test("V2 keeps explicit audience and grounded attributes without promoting them to hard requirements",()=>{
 const proposed=searchIntent({query:"남성용 팬티",requiredConditions:["남성용"],category:"fashion",
  attributePreferences:["breathability"],attributeSources:{breathability:"통풍"}});
 const result=parseAgentSearchIntent(proposed,"남성용 팬티 추천해줘. 통풍이 중요해");
 assert.deepEqual(result?.context.requiredConditions,["남성용"]);
 assert.deepEqual(result?.context.attributePreferences,["breathability"]);
});
test("V2 does not search on malformed model Tool arguments",async()=>{
 const audit=deps(async()=>({content:null,tool_calls:[{id:"bad",name:"search_products",arguments:"{}"}]}));
 const result=await createPersistentResearchGraph(audit.data,new MemorySaver() as never).invoke(request("세럼 추천해줘"));
 assert.equal(audit.counts().retrievals,0);
 assert.equal(audit.counts().intentCalls,0);
 assert.deepEqual(result.ranking.ranked,[]);
});

test("V2 will not invent a numeric budget without a price stated by the user",()=>{
 const proposal=searchIntent({maxTotalWon:30000,budgetMode:"SET"});
 assert.equal(parseAgentSearchIntent(proposal,"세럼 추천해줘"),null);
 assert.equal(parseAgentSearchIntent(proposal,"세럼 3만원 이하로 추천해줘")?.context.maxTotalWon,30000);
});
test("V2 retains verified previous hard requirements on price-preference follow-ups",()=>{
 const previous={query:"남성용 팬티",maxTotalWon:30000,revision:1,
  requiredConditions:["남성용"],category:"fashion",attributePreferences:["breathability"],currentPreferences:{}} as const;
 const proposal=searchIntent({query:"남성용 팬티",queryMode:"KEEP",budgetMode:"KEEP",
  requirementsMode:"KEEP",requiredConditions:[],category:"fashion",currentPreferences:{price_priority:"value"}});
 const intent=parseAgentSearchIntent(proposal,"그럼 더 저렴한 걸로",previous as never);
 assert.ok(intent);
 assert.equal(intent?.queryMode,"KEEP");
 assert.equal(intent?.requirementsMode,"KEEP");
 assert.equal(intent?.context.currentPreferences.price_priority,"value");
});
test("V2 rejects guessed numeric budgets on follow-ups",()=>{
 const previous={query:"세럼",maxTotalWon:50000,revision:1,requiredConditions:[],currentPreferences:{}} as const;
 const proposal=searchIntent({query:"세럼",queryMode:"KEEP",maxTotalWon:20000,budgetMode:"SET"});
 assert.equal(parseAgentSearchIntent(proposal,"그냥 다른 걸로",previous as never),null);
});

test("V2 preserves the native Tool Call/Result pair with bounded verified observations",()=>{
 const transcript=appendAgentToolTranscript([],{
  name:"get_orders",args:{query:""},callId:"call-1",
  modelMessage:{role:"assistant",content:null,tool_calls:[{id:"call-1",name:"get_orders",arguments:"{}"}]}
 },{tool:"get_orders",ok:true,data:{orders:{orders:[{orderId:"o-1",status:"CONFIRMED",itemSummary:"상품",
 shippingStatus:"IN_TRANSIT",totalWon:10000,cancelEligible:false}],hasMore:false}}});
 assert.equal(transcript.length,2);
 assert.equal(transcript[0]?.role,"assistant");
 assert.equal(transcript[1]?.role,"tool");
 assert.equal(transcript[1]?.tool_call_id,"call-1");
 assert.match(transcript[1]?.content??"",/o-1/);
 assert.doesNotMatch(transcript[1]?.content??"",/actorUserId|password/);
});
test("V2 continues one ordered Tool transcript across order and shipping decisions without RAG",async()=>{
 const toolNames:string[]=[];
 let llmCalls=0,complete=false,ragCalls=0;
 const deps2={agentPlanning:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},
  intent:{extract:async()=>{throw Error("unexpected Planner");}},
  retriever:{search:async()=>{ragCalls++;throw Error("RAG not allowed");}},
  hermes:{provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[])=>{
    llmCalls++;
    const priorTools=messages.filter(m=>m.role==="tool");
    if(!priorTools.length)return {content:null,tool_calls:[{id:"order-id",name:"get_orders",arguments:"{}"}]};
    assert.equal(priorTools[0]?.tool_call_id,"order-id");
    if(priorTools.length===1){
     const order=JSON.parse(priorTools[0]!.content??"{}");
     assert.equal(order.orders.orders[0].orderId,"owned-1");
     return {content:null,tool_calls:[{id:"shipping-id",name:"get_shipping_status",arguments:'{"order_id":"owned-1"}'}]};
    }
    assert.equal(priorTools[1]?.tool_call_id,"shipping-id");
    complete=true;
    return {content:"done",tool_calls:[]};
   }},
   history:async()=>[],reviewCount:async()=>null,toolPorts:()=>({
    orders:async()=>{toolNames.push("orders");return {orders:[{orderId:"owned-1",createdAt:"2026-10-21",
      itemSummary:"이어폰",totalWon:20000,status:"CONFIRMED",shippingStatus:"IN_TRANSIT",cancelEligible:false}],hasMore:false};},
    shipping:async(id:string)=>{toolNames.push("shipping "+id);return {orderId:id,information:"AVAILABLE",
      status:"IN_TRANSIT",estimatedArrivalAt:null,events:[]};}
   })}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(deps2,new MemorySaver() as never)
  .invoke(request("내 주문 배송 어디까지 왔어?"));
 assert.equal(complete,true);
 assert.equal(llmCalls,3);
 assert.equal(ragCalls,0);
 assert.deepEqual(toolNames,["orders","shipping owned-1"]);
 assert.equal(result.taskState?.kind,"ORDER");
});

test("V2 treats same-product SET as a follow-up and preserves hard/soft conditions",()=>{
 const prior={query:"남성용 팬티",revision:4,maxTotalWon:30000,
  requiredConditions:["남성용"],category:"fashion",attributePreferences:["breathability"],
  currentPreferences:{},lastDisplayedProductIds:["p-1"]};
 const proposal=searchIntent({query:"남성용 팬티",queryMode:"SET",budgetMode:"KEEP",
  requirementsMode:"KEEP",requiredConditions:[],category:"fashion",attributePreferences:[]});
 const change=parseAgentSearchIntent(proposal,"같은 남성용 팬티 다른 거 추천해 줘",prior as never);
 assert.equal(change?.queryMode,"KEEP");
 assert.equal(change?.context.attributePreferences,undefined);
 const next=resolveShoppingPlan(prior as never,change!);
 assert.deepEqual(next.requiredConditions,["남성용"]);
 assert.deepEqual(next.attributePreferences,["breathability"]);
 assert.equal(next.maxTotalWon,30000);
 assert.deepEqual(next.lastDisplayedProductIds,["p-1"]);
});
test("V2 rejects changing category while claiming the previous query is unchanged",()=>{
 const prior={query:"남성용 팬티",revision:1,maxTotalWon:null,
  requiredConditions:["남성용"],category:"fashion",currentPreferences:{}};
 const proposal=searchIntent({query:"남성용 팬티",queryMode:"KEEP",budgetMode:"KEEP",
  category:"beauty"});
 assert.equal(parseAgentSearchIntent(proposal,"더 저렴하게",prior as never),null);
});
test("V2 conserves simple-model latency without skipping grounded preference or review searches",()=>{
 const ranking={ranked:[{candidate:{commerceVerified:true,productId:"p-1"}}],
  referenceOnly:[],rejected:[],evaluatedCount:1} as never;
 const obs=[{tool:"search_products",ok:true,data:{}}] as never;
 assert.equal(canFinishSimpleDiscovery({intentKind:"SHOPPING_SEARCH",ranking,
  plan:{attributePreferences:[]} as never,observations:obs}),true);
 assert.equal(canFinishSimpleDiscovery({intentKind:"SHOPPING_SEARCH",ranking,
  plan:{attributePreferences:["breathability"]} as never,observations:obs}),false);
 assert.equal(canFinishSimpleDiscovery({intentKind:"REVIEW_COMPARE",ranking,
  plan:{} as never,observations:obs}),false);
 assert.equal(canFinishSimpleDiscovery({intentKind:"SHOPPING_SEARCH",
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},plan:{} as never,observations:obs}),false);
});
test("V2 scoped pros and cons requires a verified displayed product and does not hijack comparisons",()=>{
 const shown=[{displayIndex:1,productId:"p-1",variantId:"v-1",name:"세럼",commerceVerified:true}];
 assert.equal(isScopedProsConsFollowup("그중 1번 상품 단점 알려줘",shown),true);
 assert.equal(isScopedProsConsFollowup("그중 1번 상품 단점 비교해줘",shown),false);
 assert.equal(isScopedProsConsFollowup("그중 1번 상품 단점 알려줘",[]),false);
 assert.equal(isScopedProsConsFollowup("그중 1번 상품 단점 알려줘",
  [{...shown[0],commerceVerified:false}]),false);
});
test("V2 follow-up reads only the first displayed product's reviews and retains the full shopping task",async()=>{
 const conversationId=crypto.randomUUID(),actorUserId="actor-a";
 const repoCalls:string[]=[],toolSeen:string[]=[];
 let intents=0;
 const deps3={agentPlanning:true,clarifyBeforeSearch:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},
  intent:{extract:async()=>{intents++;throw Error("Unexpected legacy Planner");}},
  retriever:{search:async()=>({candidates:[candidate],evidence:[]})},
  hermes:{
   provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[])=>{
    const user=JSON.parse(messages.find(x=>x.role==="user")?.content??"{}") as Record<string,unknown>;
    const q=String(user.user_message??"");
    if(q==="세럼 추천해줘")return {content:null,tool_calls:[{id:"find",name:"search_products",
     arguments:JSON.stringify(searchIntent())}]};
    if(!messages.some(x=>x.role==="tool")){
     const displayed=user.previous_displayed_products as Array<{productId:string}>;
     assert.equal(displayed[0]?.productId,"p-serum");
     return {content:null,tool_calls:[{id:"reviews",name:"get_product_reviews",
       arguments:'{"product_id":"p-serum","query":"단점"}'}]};
    }
    const tool=messages.find(x=>x.role==="tool");
    assert.equal(tool?.tool_call_id,"reviews");
    toolSeen.push(String(tool?.content));
    return {content:"조회 완료"};
   }},
   history:async()=>[],reviewCount:async()=>null,
   toolPorts:()=>({reviews:async(productId:string,query:string)=>{
    repoCalls.push(productId,query);
    return {productId,query,totalMatching:1,reviews:[{id:"rv-1",body:"향이 강해요",rating:2}]};
   }})
  }
 } as unknown as ResearchDeps;
 const graph=createPersistentResearchGraph(deps3,new MemorySaver() as never);
 const first=await graph.invoke({actorUserId,conversationId,requestId:crypto.randomUUID(),
  clientActionId:crypto.randomUUID(),userMessage:"세럼 추천해줘"});
 assert.equal(first.shoppingPlan?.lastDisplayedProducts?.[0]?.productId,"p-serum");
 const second=await graph.invoke({actorUserId,conversationId,requestId:crypto.randomUUID(),
  clientActionId:crypto.randomUUID(),userMessage:"그중 1번 상품 단점 알려줘"});
 assert.deepEqual(repoCalls,["p-serum","단점"]);
 assert.equal(intents,0);
 assert.equal(toolSeen.length,1);
 assert.deepEqual(second.taskState?.displayedProductIds,["p-serum"]);
 assert.deepEqual(second.shoppingPlan?.lastDisplayedProductIds,["p-serum"]);
 assert.match(second.explanation?.text??"",/향이 강해요/);
});

test("V2 Agent, not the regex router, answers arbitrary capability phrasing",async()=>{
 let routed=0,planned=0,retrieved=0,chatCalls=0;
 const data={
  agentPlanning:true,
  route:async()=>{routed++;throw Error("semantic router must not execute");},
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},
  intent:{extract:async()=>{planned++;throw Error("separate intent planner must not execute");}},
  retriever:{search:async()=>{retrieved++;throw Error("RAG must not execute");}},
  hermes:{provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[],defs:unknown)=>{
    chatCalls++;
    const data=JSON.parse(messages.find(m=>m.role==="user")?.content??"{}");
    assert.equal(data.user_message,"넌 뭘할수있어?");
    assert.ok((defs as Array<{function:{name:string}}>).some(d=>d.function.name==="respond_to_user"));
    assert.ok((defs as Array<{function:{name:string}}>).some(d=>d.function.name==="ask_user"));
    return {content:null,tool_calls:[{id:"answer",name:"respond_to_user",
     arguments:JSON.stringify({text:"상품 검색과 리뷰 비교, 찜 목록 조회를 도와드릴 수 있어요.",intent_kind:"CAPABILITY"})}]};
   }},
   history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(data,new MemorySaver() as never)
  .invoke(request("넌 뭘할수있어?"));
 assert.equal(result.intentKind,"CAPABILITY");
 assert.equal(result.explanation?.text,"상품 검색과 리뷰 비교, 찜 목록 조회를 도와드릴 수 있어요.");
 assert.deepEqual([routed,planned,retrieved,chatCalls],[0,0,0,1]);
 assert.equal(result.trace.hermesToolCalls,0);
});
test("V2 combines greeting and wishlist read through one Agent rather than an early GREETING route",async()=>{
 let routes=0,rag=0,tool=0;
 const data={
  agentPlanning:true,
  route:async()=>{routes++;throw Error("no router");},
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("no planner");}},
  retriever:{search:async()=>{rag++;throw Error("no RAG");}},
  wishlist:async()=>{tool++;return [{productId:"owned-1",name:"무선 이어폰",active:true,minPriceWon:18000}];},
  hermes:{provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[])=>{
   const tools=messages.filter(m=>m.role==="tool");
   if(!tools.length)return {content:null,tool_calls:[{id:"wish",name:"get_wishlist",arguments:"{}"}]};
   assert.equal(tools[0].tool_call_id,"wish");
   assert.match(tools[0].content??"",/owned-1/);
   return {content:"조회한 찜 목록을 알려드릴게요."};
  }},history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(data,new MemorySaver() as never)
  .invoke(request("안녕! 내가 찜한 상품도 보여줄래?"));
 assert.equal(routes,0);assert.equal(rag,0);assert.equal(tool,1);
 assert.match(result.explanation?.text??"",/무선 이어폰/);
 assert.equal(result.taskState?.kind,"WISHLIST");
 assert.equal(result.trace.hermesToolCalls,1);
});
test("V2 Agent asks a question directly and keeps prior shopping state across small talk",async()=>{
 const conversationId=crypto.randomUUID();
 const data={
  agentPlanning:true,route:async()=>{throw Error("no intent routing");},
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("no planner");}},
  retriever:{search:async()=>{throw Error("no RAG");}},
  hermes:{provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[])=>{
   const text=JSON.parse(messages.find(m=>m.role==="user")?.content??"{}").user_message;
   if(text==="상품을 좀 찾아줘")return {content:null,tool_calls:[{id:"ask",name:"ask_user",
     arguments:'{"question":"어떤 종류의 상품을 찾으세요?"}'}]};
   return {content:"안녕하세요! 이전 조건도 기억하고 있어요."};
  }},history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const g=createPersistentResearchGraph(data,new MemorySaver() as never);
 const first=await g.invoke({...request("상품을 좀 찾아줘"),conversationId});
 assert.equal(first.explanation?.text,"어떤 종류의 상품을 찾으세요?");
 assert.equal(first.taskState?.phase,"AWAITING_INPUT");
 const second=await g.invoke({...request("안녕, 고마워"),conversationId});
 assert.match(second.explanation?.text??"",/안녕하세요/);
 assert.equal(second.taskState?.phase,"AWAITING_INPUT");
});
test("V2 cannot treat a model-requested write as a callable Commerce Tool",async()=>{
 const data={
  agentPlanning:true,conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("no intent planner");}},
  retriever:{search:async()=>{throw Error("RAG not allowed");}},
  hermes:{provider:{chat:async()=>({content:null,tool_calls:[{id:"bad",
    name:"cancel_order",arguments:'{"order_id":"owned-1"}'}]})},
   history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(data,new MemorySaver() as never)
  .invoke(request("내 주문 취소해줘"));
 assert.equal(result.trace.hermesToolCalls,0);
 assert.match(result.explanation?.text??"",/AI 응답을 만들지 못했어요/);
});

test("V2 Agent-initiated reset clears only task context after explicit user confirmation in words",async()=>{
 const conversationId=crypto.randomUUID();
 let retrievals=0,planner=0;
 const data={
  agentPlanning:true,route:async()=>{throw Error("legacy router");},
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{planner++;throw Error("legacy planner");}},
  retriever:{search:async()=>{retrievals++;return {candidates:[candidate],evidence:[]};}},
  hermes:{provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[])=>{
    const message=JSON.parse(messages.find(m=>m.role==="user")?.content??"{}").user_message;
    if(message==="세럼 추천해줘")return {content:null,tool_calls:[{id:"search",name:"search_products",
      arguments:JSON.stringify(searchIntent())}]};
    if(message==="처음부터 시작")return {content:null,tool_calls:[{id:"reset",name:"reset_shopping_task",arguments:"{}"}]};
    throw Error("unexpected");
   }},history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const graph=createPersistentResearchGraph(data,new MemorySaver() as never);
 const first=await graph.invoke({...request("세럼 추천해줘"),conversationId});
 assert.equal(first.shoppingPlan?.query,"세럼");
 assert.equal(retrievals,1);
 const reset=await graph.invoke({...request("처음부터 시작"),conversationId});
 assert.equal(reset.shoppingPlan,undefined);
 assert.equal(reset.taskState,undefined);
 assert.match(reset.explanation?.text??"",/초기화/);
 assert.equal(retrievals,1);assert.equal(planner,0);
});
test("V2 never allows an Agent-only reset without the user's explicit reset request",async()=>{
 const data={agentPlanning:true,conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("legacy planner");}},
  retriever:{search:async()=>{throw Error("no RAG");}},
  hermes:{provider:{chat:async()=>({content:null,tool_calls:[{id:"bad",name:"reset_shopping_task",arguments:"{}"}]})},
   history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(data,new MemorySaver() as never).invoke(request("안녕"));
 assert.equal(result.trace.hermesToolCalls,0);
 assert.doesNotMatch(result.explanation?.text??"",/초기화했어요/);
});

test("V2 model outage on greeting returns a retry message, without product-routing fallback",async()=>{
 let rag=0,reads=0;
 const data={agentPlanning:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("unexpected planner");}},
  retriever:{search:async()=>{rag++;throw Error("unexpected RAG");}},
  hermes:{provider:{chat:async()=>{throw Error("model offline");}},
   history:async()=>{reads++;return [];},reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(data,new MemorySaver() as never).invoke(request("안녕?"));
 assert.equal(result.trace.agentModelUnavailable,1);
 assert.equal(result.trace.hermesToolCalls,0);
 assert.deepEqual([reads,rag],[0,0]);
 assert.match(result.explanation?.text??"",/AI 응답을 만들지 못했어요/);
 assert.doesNotMatch(result.explanation?.text??"",/어떤 상품이나 조건/);
});
test("V2 accepts safe multiline natural capability explanations",async()=>{
 const data={agentPlanning:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("planner");}},
  retriever:{search:async()=>{throw Error("RAG");}},
  hermes:{provider:{chat:async()=>({content:"안녕하세요!\n- 상품 추천\n- 리뷰 분석\n- 주문 조회"})},
   history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(data,new MemorySaver() as never)
  .invoke(request("넌 어떤 걸 해줄 수 있어?"));
 assert.equal(result.explanation?.text,"안녕하세요!\n- 상품 추천\n- 리뷰 분석\n- 주문 조회");
 assert.equal(result.trace.agentDecisionInvalid,0);
 assert.equal(result.trace.hermesToolCalls,0);
});
test("V2 distinguishes a new product task from the existing product follow-up",async()=>{
 const conversationId=crypto.randomUUID();let searches=0;
 const data={agentPlanning:true,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[]},intent:{extract:async()=>{throw Error("planner");}},
  retriever:{search:async()=>{searches++;return {candidates:[candidate],evidence:[]};}},
  hermes:{provider:{chat:async(messages:import("../../src/llm.ts").ChatMsg[])=>{
   const prompt=JSON.parse(messages.find(x=>x.role==="user")?.content??"{}");
   const change=prompt.user_message==="이번에는 무선 이어폰 추천해줘";
   return {content:null,tool_calls:[{id:change?"new":"old",name:"search_products",
     arguments:JSON.stringify(change?searchIntent({query:"무선 이어폰",category:"audio"}):searchIntent())}]};
  }},history:async()=>[],reviewCount:async()=>null}
 } as unknown as ResearchDeps;
 const graph=createPersistentResearchGraph(data,new MemorySaver() as never);
 await graph.invoke({...request("세럼 추천해줘"),conversationId});
 const result=await graph.invoke({...request("이번에는 무선 이어폰 추천해줘"),conversationId});
 assert.equal(searches,2);
 assert.equal(result.intentKind,"SHOPPING_SEARCH");
 assert.equal(result.shoppingPlan?.query,"무선 이어폰");
});
