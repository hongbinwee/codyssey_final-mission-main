import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {rememberInterview,interviewAnswer} from "../../src/brain/interview.ts";
import {createFastIntentPort} from "../../src/brain/fast-intent.ts";
import {routeBrainMessage} from "../../src/brain/routing.ts";
import {decideHermesAction} from "../../src/brain/hermes-agent-step.ts";
import {resolveBrainInterviewState} from "../../src/web/brain-interview-state.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";
import type {ProductCandidate} from "../../src/brain/contracts.ts";
const base={query:"팬티",revision:1,maxTotalWon:null,requiredConditions:[],currentPreferences:{}};
const candidate=(id:string,price=32900):ProductCandidate=>({productId:id,variantId:"v-"+id,
 productName:"확인된 묶음 상품",unitPriceWon:price,shippingFeeWon:3000,commerceVerified:true,
 rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{}});
function setup(candidates=[candidate("p1")]){
 let plans=0,searches=0;const inputs:unknown[]=[];
 const intent=createFastIntentPort({extract:async()=>{plans++;return {query:"팬티",queryMode:"SET",budgetMode:"CLEAR",
   context:{category:"fashion",maxTotalWon:null,requiredConditions:[],currentPreferences:{},attributePreferences:["breathability"]},attributeSources:{breathability:"통풍이 잘 되면 좋겠어"}};}});
 const deps={clarifyBeforeSearch:true,datasetVersion:"budget-test",intent,route:routeBrainMessage,
 conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[]},
 retriever:{search:async(input:unknown)=>{searches++;inputs.push(input);return {candidates,evidence:[]};}}
 } as unknown as ResearchDeps;
 const saver=new MemorySaver();let graph=createPersistentResearchGraph(deps,saver as never);
 const conversationId=crypto.randomUUID();const run=(userMessage:string)=>graph.invoke({actorUserId:"owner",conversationId,
   requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage});
 return {run,deps,inputs,restore:()=>{graph=createPersistentResearchGraph(deps,saver as never);},counts:()=>({plans,searches})};
}
test("unasked budget/purpose stay unknown, including legacy auto-answered checkpoints",()=>{
 for(const prior of [base,{...base,interview:{answered:["budget","purpose"] as ("budget"|"purpose")[],pending:[]}}]){
  const p=rememberInterview(prior,"팬티 추천해줘",[]);
  assert.equal(p.interview?.answered.includes("budget"),false);
  assert.equal(p.interview?.answered.includes("purpose"),false);
 }
});
test("one verified product remains visible and asks a shipping-inclusive budget once",async()=>{
 const s=setup();const result=await s.run("팬티 추천해줘. 통풍이 잘 되면 좋겠어");
 assert.equal(result.ranking.ranked.length,1);assert.notEqual(result.explanation?.kind,"CLARIFICATION");
 assert.equal(result.explanation?.clarification?.questions[0]?.key,"budget");
 assert.match(result.explanation?.clarification?.questions[0]?.text??"",/35,900/);
 assert.equal(result.taskState?.phase,"AWAITING_INPUT");assert.equal(result.taskState?.pendingQuestion,"budget");
 assert.equal(resolveBrainInterviewState([{text:"팬티 추천해줘",reply:result}],false).questions.length,1);
 s.restore();const next=await s.run("3만원 이하");
 assert.equal(next.shoppingPlan?.query,"팬티");assert.equal(next.shoppingPlan?.maxTotalWon,30000);
 assert.deepEqual(next.shoppingPlan?.attributePreferences,["breathability"]);
 assert.equal(next.explanation?.clarification,undefined);assert.equal(next.ranking.ranked.length,0);
 assert.equal(next.ranking.rejected[0]?.reasons.includes("over_total_budget"),true);
 assert.equal(s.counts().searches,2);
});
test("unrestricted and deferred answers are different and neither repeats the question",async()=>{
 const states:unknown[]=[];
 for(const answer of ["상관없어요","나중에 정할게요","그냥 추천해줘"]){
  const s=setup();await s.run("팬티 추천해줘");s.restore();const result=await s.run(answer);
  assert.equal(result.shoppingPlan?.query,"팬티");assert.equal(result.shoppingPlan?.maxTotalWon,null);
  assert.equal(result.explanation?.clarification,undefined);assert.equal(result.ranking.ranked.length,1);
  assert.equal(result.taskState?.phase,"ACTIVE");states.push(result.shoppingPlan?.interview);
  const again=await s.run("다른 상품 보기");assert.equal(again.explanation?.clarification,undefined);
 }
 assert.notDeepEqual(states[0],states[1]);
});
test("budget confirmation is selective: comparable prices, zero results and explicit ordering do not ask",async()=>{
 const cases=[{items:[candidate("a",10000),candidate("b",12000)],message:"팬티 추천해줘"},
  {items:[],message:"팬티 추천해줘"},{items:[candidate("a")],message:"가격 낮은 순으로 팬티 추천해줘"}];
 for(const c of cases){const s=setup(c.items);const result=await s.run(c.message);assert.equal(result.explanation?.clarification,undefined,c.message);}
 const spread=setup([candidate("a",10000),candidate("b",60000)]);const result=await spread.run("팬티 추천해줘");
 assert.equal(result.explanation?.clarification?.questions[0]?.key,"budget");
});
test("explicit unrestricted budget in a new request never prompts for a number",async()=>{
 const s=setup();const r=await s.run("가격은 상관없어요. 팬티 추천해줘");
 assert.equal(r.explanation?.clarification,undefined);assert.equal(r.ranking.ranked.length,1);
});
test("budget reply preserves existing conditions, preferences and scope",()=>{
 const plan={...base,requiredConditions:["남성용"],currentPreferences:{price_priority:"value" as const},
  category:"fashion",attributePreferences:["breathability"],interview:{answered:[],pending:["budget" as const]}};
 const r=interviewAnswer("예산은 3만원 이하",plan)!;
 assert.equal(r.query,plan.query);assert.deepEqual(r.requiredConditions,plan.requiredConditions);
 assert.deepEqual(r.attributePreferences,plan.attributePreferences);assert.deepEqual(r.currentPreferences,plan.currentPreferences);
});

test("pending budget never blocks explicit sort, a numeric range, or a new product task",async()=>{
 const sorted=setup();await sorted.run("팬티 추천해줘");const asc=await sorted.run("가격 낮은 순");
 assert.equal(asc.shoppingPlan?.priceSortOrder,"ASC");assert.equal(asc.ranking.ranked.length,1);
 assert.equal(asc.explanation?.kind,"VERIFIED_CANDIDATES");
 assert.equal(asc.explanation?.clarification,undefined);
 const range=setup();await range.run("팬티 추천해줘");const band=await range.run("1~3만원대");
 assert.equal(band.shoppingPlan?.maxTotalWon,39999);assert.equal(band.explanation?.kind,"VERIFIED_CANDIDATES");
 const next=setup();await next.run("팬티 추천해줘");await next.run("상관없어요");
 const coffee=await next.run("커피 추천해줘");assert.equal(coffee.shoppingPlan?.query,"커피");
 assert.equal(coffee.shoppingPlan?.interview?.budgetStatus,"UNKNOWN");
 assert.equal(coffee.explanation?.clarification?.questions[0]?.key,"budget");
});
test("LLM agent sees explicit budget resolution and does not confuse deferral with unlimited",async()=>{
 for(const budgetStatus of ['UNKNOWN','UNRESTRICTED','DEFERRED'] as const){
  let observed:Record<string,any>={};
  await decideHermesAction({provider:{chat:async messages=>{observed=JSON.parse(messages.at(-1)?.content??'{}');return {content:'확인했어요'};}},
   message:'팬티 추천해줘',plan:{...base,interview:{answered:[],pending:[],budgetStatus}},memories:[],task:null,
   observations:[],tools:{purchases:async()=>[],search:async()=>({products:[]})},offerSearch:true,startedAt:Date.now()});
  assert.equal(observed.current_shopping_plan.budgetStatus,budgetStatus);
 }
});

test("Hermes Tool Loop keeps candidates and budget question through checkpoint and answer",async()=>{
 const s=setup();s.deps.hermes={provider:{chat:async messages=>{
  const data=JSON.parse(messages.at(-1)?.content??'{}');
  return data.observed_tools.length?{content:'확인했어요'}:
   {content:null,tool_calls:[{id:'search',name:'search_products',arguments:'{}'}]};
 }},history:async()=>[],reviewCount:async()=>null};
 s.restore();const first=await s.run('팬티 추천해줘');
 assert.equal(first.trace.hermesToolCalls,1);assert.equal(first.ranking.ranked.length,1);
 assert.equal(first.taskState?.pendingQuestion,'budget');s.restore();
 const next=await s.run('예산은 5만원 이하');
 assert.equal(next.shoppingPlan?.maxTotalWon,50000);assert.equal(next.ranking.ranked.length,1);
 assert.equal(next.shoppingPlan?.interview?.budgetStatus,'SET');
 assert.equal(next.taskState?.phase,'ACTIVE');assert.equal(next.explanation?.clarification,undefined);
});

test("budget skip keeps a prior numeric ceiling; explicit removal clears it",()=>{
 const p={...base,maxTotalWon:20000,interview:{answered:[],pending:['budget' as const]}};
 assert.equal(interviewAnswer('상관없어요',p)?.maxTotalWon,20000);
 assert.equal(interviewAnswer('예산은 상관없어요',p)?.maxTotalWon,null);
});
test("budget shortcut never swallows a new product or compound request",()=>{
 const p={...base,interview:{answered:[],pending:['budget' as const]}};
 for(const text of ['1~3만원대 커피 추천해줘','가격은 상관없어요. 커피 추천해줘','예산 제한 없지만 남성용은 필수'])
  assert.equal(interviewAnswer(text,p),undefined,text);
});

test("optional budget question never blocks browsing and is not repeatedly forced",async()=>{
 const s=setup();await s.run('팬티 추천해줘');
 const other=await s.run('다른 상품 보기');
 assert.notEqual(other.explanation?.kind,'CLARIFICATION');assert.equal(other.explanation?.clarification,undefined);
 assert.equal(s.counts().searches,2);assert.equal(other.shoppingPlan?.interview?.budgetStatus,'UNKNOWN');
});

test("price question uses only the products actually displayed, not a hidden expensive candidate",async()=>{
 const s=setup([candidate('a',10000),candidate('b',11000),candidate('c',12000),candidate('d',90000)]);
 const r=await s.run('팬티 추천해줘');assert.equal(r.explanation?.clarification,undefined);
});
