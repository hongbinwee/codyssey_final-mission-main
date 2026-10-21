import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {parseAgentSearchIntent} from "../../src/brain/agent-search-intent.ts";
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
