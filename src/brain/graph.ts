import {guardBrainMessage} from './routing.ts';
import {runHermesReadLoop} from "./hermes-tools.ts";
import {wishlistIntent,wishlistReply,type WishlistIntent} from "./wishlist-task.ts";
import {ownedTask,nextTask,retainTask,taskForWishlistSelection,resetTaskRequested,type AgentTaskState,type TaskScope} from "./task-state.ts";
import {explainPreviousRecommendation} from "./recommendation-followup.ts";
import {interviewAnswer,needsInterview,rememberInterview} from './interview.ts';
import {Annotation,StateGraph,START,END} from "@langchain/langgraph";
import {AsyncLocalStorage} from "node:async_hooks";
import type {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import type {BrainTrace,EvidenceRecord} from "./contracts.ts";
import type {PreparedTurn,ResearchDeps,ResearchResult} from "./read-flow.ts";
import {prepareTurn,resolveTurnPlan,retrieveTurn,RetrievalUnavailableError} from "./read-flow.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import {buildGroundedExplanation,type GroundedResponder} from "./grounded-response.ts";
import type {BrainGraphPort} from "./api.ts";
import type {TurnLock,TurnLease} from "./turn-lock.ts";
import type {FencedTurns} from "./fenced-turns.ts";
import type {BrainRoute} from "./routing.ts";
import {currentDatasetResult} from "./dataset-state.ts";

export type GraphRequest=BrainTrace & {clientActionId:string;userMessage:string};
const State=Annotation.Root({
 request:Annotation<GraphRequest>(),
 prepared:Annotation<PreparedTurn>(),
 shoppingPlan:Annotation<ShoppingPlan>(),
 evidence:Annotation<EvidenceRecord[]>(),
 researchResult:Annotation<ResearchResult>()
 ,intentRoute:Annotation<BrainRoute>(),routeMs:Annotation<number>(),
 priorExplanation:Annotation<import("./grounded-response.ts").GroundedExplanation|null>(),
 wishlistRequest:Annotation<WishlistIntent|null>(),
 activeTask:Annotation<AgentTaskState|null>()
});
/**
 * Four explicit phases, each with a persisted checkpoint. Only a server-owned
 * conversation may invoke/read this graph. RAG/Commerce actions stay read-only.
 * Long-term preferences are re-read every turn, never stored as the authority
 * in a previous checkpoint.
 */
export function createPersistentResearchGraph(
 deps:ResearchDeps,checkpointer:PostgresSaver,turnLock?:TurnLock,fencing?:FencedTurns,
 groundedResponder?:GroundedResponder
):BrainGraphPort {
 // Context is per invocation, not per compiled graph: different conversations
 // may run concurrently without sharing lock ownership.
 if(fencing&&!turnLock)throw Error("fenced Brain requires distributed turn lock");
 const activeLease=new AsyncLocalStorage<TurnLease>();
 const verify=async()=>{await activeLease.getStore()?.assertHeld();};
 const taskScope=(request:GraphRequest):TaskScope=>({actorUserId:request.actorUserId,conversationId:request.conversationId,datasetVersion:deps.datasetVersion});
 const unavailable=(request:GraphRequest,prepared:PreparedTurn,plan:ShoppingPlan,route:BrainRoute,previousTask:AgentTaskState|null)=>({
   researchResult:{conversationId:request.conversationId,messageId:prepared.messageId,clientActionId:request.clientActionId,
     intentKind:route.kind,shoppingPlan:plan,datasetVersion:deps.datasetVersion,
     taskState:nextTask(taskScope(request),route.kind==="REVIEW_COMPARE"?"REVIEW_COMPARE":"DISCOVERY",previousTask,{phase:"UNAVAILABLE"}),
     ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
     explanation:{kind:'NO_MATCH',text:'상품 정보를 불러오는 연결에 문제가 생겼어요.\n\n말씀하신 조건은 그대로 보관했어요. 잠시 후 다시 찾아볼까요?',items:[],limitations:[],failure:{code:'RETRIEVAL_UNAVAILABLE'}},
     trace:{memoryMs:prepared.memoryMs,intentMs:0,retrievalMs:0,rankMs:0,responseMs:0,totalMs:performance.now()-prepared.startedAt}} as ResearchResult,
   evidence:[] as EvidenceRecord[],
 });
 const compiled=new StateGraph(State)
   .addNode("prepare",async state=>{
     const prepared=await prepareTurn(state.request,deps);
     await verify();
     return {prepared};
   })
   .addNode("route",async state=>{
     const started=performance.now();
     const previous=state.researchResult?.shoppingPlan;
     const activeTask=ownedTask(state.researchResult?.taskState,taskScope(state.request));
     if(resetTaskRequested(state.request.userMessage)){
       await verify();return {activeTask:null,priorExplanation:null,wishlistRequest:null,
         intentRoute:{kind:"UNCERTAIN" as const,search:false,
           text:"현재 쇼핑 작업과 조건을 초기화했어요. 저장된 장기 선호와 주문 기록은 그대로예요. 어떤 상품을 찾아볼까요?"},
         routeMs:performance.now()-started};
     }
     const priorExplanation=explainPreviousRecommendation(state.request.userMessage,state.researchResult,deps.datasetVersion);
     if(priorExplanation){await verify();return {priorExplanation,activeTask,intentRoute:{kind:"SHOPPING_FOLLOWUP" as const,search:false},
       routeMs:performance.now()-started};}
     const wishlistRequest=deps.wishlist?wishlistIntent(state.request.userMessage,taskForWishlistSelection(activeTask)):null;
     if(wishlistRequest){await verify();return {wishlistRequest,activeTask,priorExplanation:null,
       intentRoute:{kind:"SHOPPING_FOLLOWUP" as const,search:false},routeMs:performance.now()-started};}
     const answer=deps.clarifyBeforeSearch&&interviewAnswer(state.request.userMessage,previous);
     const follow=previous&&['다른 상품 보기','다른 제품 보기','조건 바꾸기'].includes(state.request.userMessage.trim());
     const route=guardBrainMessage(state.request.userMessage)??(answer||follow?{kind:"SHOPPING_FOLLOWUP" as const,search:true}:await (deps.route?.(state.request.userMessage,state.researchResult?.shoppingPlan)??{kind:"SHOPPING_SEARCH" as const,search:true}));
     await verify();return {intentRoute:route,activeTask,priorExplanation:null,wishlistRequest:null,routeMs:performance.now()-started};
   })
   .addNode("explain_previous",async state=>{
     const start=performance.now();
     if(!state.priorExplanation||!state.researchResult)throw Error("prior recommendation missing");
     // Preserve the ranked snapshot and reasons for subsequent ordinal questions,
     // but the conversation-kind reply does not re-display product cards.
     const result:ResearchResult={...state.researchResult,
       conversationId:state.request.conversationId,messageId:state.prepared.messageId,
       clientActionId:state.request.clientActionId,intentKind:"SHOPPING_FOLLOWUP",
       explanation:state.priorExplanation,
       trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,
        intentMs:0,retrievalMs:0,rankMs:0,responseMs:performance.now()-start,
        totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {researchResult:result,evidence:[]};
   })
   .addNode("wishlist",async state=>{
     const started=performance.now();
     if(!state.wishlistRequest)throw Error("wishlist task missing");
     let items:import("./wishlist-task.ts").WishlistItem[]=[];
     let ready=!!deps.wishlist;
     if(deps.wishlist){try{items=await deps.wishlist(state.request.actorUserId);}catch{ready=false;}}
     await verify();
     const reply=ready?wishlistReply(state.wishlistRequest,items,taskForWishlistSelection(state.activeTask)):null;
     const researchResult:ResearchResult={
       conversationId:state.request.conversationId,messageId:state.prepared.messageId,
       clientActionId:state.request.clientActionId,intentKind:"SHOPPING_FOLLOWUP",
       ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
       ...(reply?{agentUi:reply.view}:{}),datasetVersion:deps.datasetVersion,
       taskState:nextTask(taskScope(state.request),"WISHLIST",state.activeTask,{
         phase:reply?"ACTIVE":"UNAVAILABLE",displayedProductIds:reply?.view.items.map(item=>item.productId)??[],
         selectedProductId:reply?.view.selectedProductId}),
       explanation:{kind:"CONVERSATION",items:[],limitations:[],text:reply?.text??"지금은 찜 목록을 불러올 수 없어요. 잠시 후 다시 확인해 주세요."},
       trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,
         responseMs:performance.now()-started,totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {researchResult,evidence:[]};
   })
   .addNode("converse",async state=>{
     const previous=resetTaskRequested(state.request.userMessage)?null:state.researchResult?.shoppingPlan;
     const started=performance.now();
     const explanation=deps.converse?await deps.converse({message:state.request.userMessage,route:state.intentRoute,previous}):
       {kind:"CONVERSATION" as const,text:state.intentRoute.text??"어떤 상품을 찾으시는지 알려주세요.",items:[],limitations:[]};
     await verify();
     const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,
       clientActionId:state.request.clientActionId,intentKind:state.intentRoute.kind,
       ...(previous?{shoppingPlan:previous}:{}),
       ...(state.intentRoute.kind==="CS_REQUEST"?{taskState:nextTask(taskScope(state.request),"ORDER",state.activeTask,{phase:"UNAVAILABLE"})}
         :{taskState:retainTask(state.activeTask,taskScope(state.request))}),
       ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
       explanation,
       datasetVersion:deps.datasetVersion,trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,responseMs:performance.now()-started,
         totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {researchResult,evidence:[]};
   })
   .addNode("plan",async state=>{
     const shoppingPlan=await resolveTurnPlan(state.request,state.prepared,
       state.researchResult?.explanation ? state.researchResult.shoppingPlan : null,deps);
     await verify();
     return {shoppingPlan:deps.clarifyBeforeSearch?rememberInterview(shoppingPlan,state.request.userMessage,state.prepared.memories):shoppingPlan};
   })
   .addNode("clarify",async state=>{
     const questions=needsInterview(state.shoppingPlan,state.request.userMessage,state.prepared.memories);
     const plan={...state.shoppingPlan,interview:{...state.shoppingPlan.interview,answered:state.shoppingPlan.interview?.answered??[],pending:questions.map(q=>q.key)}};
     const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,clientActionId:state.request.clientActionId,intentKind:state.intentRoute.kind,shoppingPlan:plan,datasetVersion:deps.datasetVersion,
       taskState:nextTask(taskScope(state.request),state.intentRoute.kind==="REVIEW_COMPARE"?"REVIEW_COMPARE":"DISCOVERY",state.activeTask,
         {phase:"AWAITING_INPUT",pendingQuestion:questions[0]?.key}),ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},explanation:{kind:"CLARIFICATION",text:questions[0]?.text??"원하는 조건을 알려주세요.",items:[],limitations:[],clarification:{questions}},trace:{memoryMs:state.prepared.memoryMs,intentMs:performance.now()-state.prepared.startedAt-state.prepared.memoryMs,retrievalMs:0,rankMs:0,responseMs:0,totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {shoppingPlan:plan,researchResult,evidence:[]};
   })
   .addNode("deep",async state=>{
     if(!deps.hermes)throw Error("Hermes provider unavailable");
     let fetched:Awaited<ReturnType<typeof retrieveTurn>>|null=null;
     const refersToPurchase=/(전에|이전에|지난번|구매했던|산 것)/.test(state.request.userMessage);
     const recent=refersToPurchase?await deps.hermes.history(state.request.actorUserId):[];
     const noProductKind=!state.shoppingPlan.category&&/^(전에|이전에|지난번|그|구매|산 것)/.test(state.shoppingPlan.query);
     const samePurchasedKind=recent[0]&&state.shoppingPlan.query.replace(/\s/g,"").length>=2&&
       recent[0].productName.replace(/\s/g,"").includes(state.shoppingPlan.query.replace(/\s/g,""));
     const effectivePlan=recent[0]&&(noProductKind||samePurchasedKind)?{...state.shoppingPlan,
       ...(noProductKind?{query:recent[0].productName}:{}),category:recent[0].category,
       ...(state.shoppingPlan.category!==recent[0].category?{attributePreferences:[]}:{}),
     }:state.shoppingPlan;
     let decision:Awaited<ReturnType<typeof runHermesReadLoop>>={calls:[],searched:false,purchases:[],answer:null};
     try{decision=await runHermesReadLoop(deps.hermes.provider,state.request.userMessage,
       effectivePlan,state.prepared.memories,{
         purchases:()=>recent.length?Promise.resolve(recent):deps.hermes!.history(state.request.actorUserId),
         ...(deps.wishlist?{wishlist:()=>deps.wishlist!(state.request.actorUserId)}:{}),
         search:async()=>{
           fetched=await retrieveTurn(state.request,state.prepared,effectivePlan,deps);
           await verify();
           return {products:fetched.result.ranking.ranked.slice(0,3).map(row=>({
             productId:row.candidate.productId,variantId:row.candidate.variantId,
             totalPriceWon:(row.candidate.unitPriceWon??0)+(row.candidate.shippingFeeWon??0),
             reviewCount:row.candidate.wholeReviewCountVerified?row.candidate.wholeReviewCount:null
           }))};
         }
       });}catch{/* Continue through verified RAG if the deep model is unavailable. */}
     // Search remains mandatory for recommendations; the LLM never supplies ranking.
     let result;
     try{result=fetched??await retrieveTurn(state.request,state.prepared,effectivePlan,deps);}
     catch(error){
       if(!(error instanceof RetrievalUnavailableError))throw error;
       await verify();return {shoppingPlan:effectivePlan,...unavailable(state.request,state.prepared,effectivePlan,state.intentRoute,state.activeTask)};
     }
     const cheaper=/(저렴|더 싸|보다 싸|가격.*낮)/.test(state.request.userMessage);
     const moreReviews=/(리뷰.*많|후기.*많|리뷰 수|후기 수)/.test(state.request.userMessage);
     const comparePast=/(전에|이전에|지난번|구매했던|산 것)/.test(state.request.userMessage);
     if(comparePast&&(cheaper||moreReviews)){
       const ownedPurchases=decision.purchases.length?decision.purchases:recent.length?recent:await deps.hermes.history(state.request.actorUserId);
       const past=ownedPurchases[0];
       const earlierCount=past&&moreReviews?await deps.hermes.reviewCount(past.productId):null;
       const selected=result.result.ranking.ranked.filter(row=>{
         const c=row.candidate;
         return !!past&&c.productId!==past.productId&&
           (!cheaper||(c.unitPriceWon!==null&&c.unitPriceWon<past.unitPriceWon))&&
           (!moreReviews||(earlierCount!==null&&c.wholeReviewCountVerified&&
             c.wholeReviewCount!==null&&c.wholeReviewCount>earlierCount));
       });
       result.result.ranking={...result.result.ranking,ranked:selected,referenceOnly:[]};
     }
     await verify();
     return {shoppingPlan:effectivePlan,researchResult:{...result.result,intentKind:state.intentRoute.kind,
       trace:{...result.result.trace,hermesToolCalls:decision.calls.length}},evidence:result.evidence};
   })
   .addNode("retrieve",async state=>{
     let fetched;
     try{fetched=await retrieveTurn(state.request,state.prepared,state.shoppingPlan,deps);}
     catch(error){
       if(!(error instanceof RetrievalUnavailableError))throw error;
       await verify();
       return unavailable(state.request,state.prepared,state.shoppingPlan,state.intentRoute,state.activeTask);
     }
     // A lost advisory session must not let stale RAG data finish this node.
     await verify();
     return {researchResult:{...fetched.result,intentKind:state.intentRoute.kind},evidence:fetched.evidence};
   })
   .addNode("respond",async state=>{
     const started=performance.now();
     const researchResult={
       ...state.researchResult,datasetVersion:deps.datasetVersion,
       explanation:groundedResponder&&(!deps.fastResponses||state.intentRoute.kind==="REVIEW_COMPARE")
         ?await groundedResponder({originalQuestion:state.request.userMessage,
           ranking:state.researchResult.ranking,evidence:state.evidence,plan:state.shoppingPlan,mode:"RECOMMEND"})
         :buildGroundedExplanation(state.researchResult.ranking,state.evidence,state.shoppingPlan)
     };
     if(researchResult.shoppingPlan){
       const selected=researchResult.ranking.ranked.filter(row=>row.candidate.commerceVerified===true&&(researchResult.explanation.failure||researchResult.explanation.items.some(item=>item.productId===row.candidate.productId&&item.variantId===row.candidate.variantId)));
       researchResult.shoppingPlan={...researchResult.shoppingPlan,lastDisplayedProductIds:[...new Set([...selected,...researchResult.ranking.referenceOnly].map(row=>row.candidate.productId))].slice(0,3)};
     }
     researchResult.taskState=nextTask(taskScope(state.request),state.intentRoute.kind==="REVIEW_COMPARE"?"REVIEW_COMPARE":"DISCOVERY",state.activeTask,
       {displayedProductIds:researchResult.shoppingPlan?.lastDisplayedProductIds??[]});
     researchResult.trace={...researchResult.trace,routeMs:state.routeMs,candidatesReadyMs:started-state.prepared.startedAt,responseMs:performance.now()-started,
       totalMs:performance.now()-state.prepared.startedAt};
     await verify();
     return {researchResult};
   })
   .addEdge(START,"prepare")
   .addEdge("prepare","route")
   .addConditionalEdges("route",state=>state.priorExplanation?"explain_previous":state.wishlistRequest?"wishlist":state.intentRoute.search?"plan":"converse",["explain_previous","wishlist","plan","converse"])
   .addEdge("explain_previous",END)
   .addEdge("wishlist",END)
   .addEdge("converse",END)
   .addConditionalEdges("plan",state=>deps.clarifyBeforeSearch&&needsInterview(state.shoppingPlan,state.request.userMessage,state.prepared.memories).length?"clarify":deps.hermes&&(/전에|이전에|구매|주문|후기|리뷰|비교/.test(state.request.userMessage))?"deep":"retrieve",["clarify","deep","retrieve"])
   .addEdge("clarify",END)
   .addConditionalEdges("retrieve",state=>state.researchResult.explanation?.failure?.code==='RETRIEVAL_UNAVAILABLE'?END:'respond',[END,'respond'])
   .addConditionalEdges("deep",state=>state.researchResult.explanation?.failure?.code==="RETRIEVAL_UNAVAILABLE"?END:"respond",[END,"respond"])
   .addEdge("respond",END)
   .compile({checkpointer});
 // One-process deduplication ONLY; production multi-replica requires a DB lock.
 // The map is scoped to one compiled graph instance and never authorizes a user.
 const inFlight=new Map<string,{actorUserId:string;clientActionId:string;userMessage:string;promise:Promise<ResearchResult>}>();
 return {
   async invoke(input:GraphRequest){
     await deps.conversations.assertOwned(input.actorUserId,input.conversationId);
     const pending=inFlight.get(input.conversationId);
     if(pending){
       if(pending.actorUserId===input.actorUserId&&
          pending.clientActionId===input.clientActionId&&pending.userMessage===input.userMessage)
         return pending.promise;
       if(pending.clientActionId===input.clientActionId)
         throw new Error("duplicate action conflict");
       throw new Error("conversation busy");
     }
     const task=(async()=>{
       // A reserved AI-DB session lock spans checkpoint read through final write.
       // Existing isolated tests without turnLock remain single-process only.
       const lease=turnLock?await turnLock.tryAcquire(input.conversationId):null;
       if(turnLock&&!lease)throw new Error("conversation busy");
       const execute=async()=>{

       if(fencing && !(await fencing.latest(input.conversationId))){
         // Never silently reset a pre-v9 multi-turn conversation. Migrating a
         // legacy shared checkpoint requires a separately audited procedure.
         const legacy=await compiled.getState({configurable:{thread_id:input.conversationId}});
         const previous=legacy.values?.researchResult as ResearchResult|undefined;
         if(previous?.explanation&&previous.conversationId===input.conversationId)
           throw Error("legacy Brain checkpoint migration required");
       }
       const claim=fencing?await fencing.claim(input):null;
       if(claim?.kind==="replay")return currentDatasetResult(claim.result,deps.datasetVersion);
       // Fenced executions use a new physical checkpoint thread for EACH
       // generation. A stale Worker can only write its private thread; the
       // canonical pointer is guarded by a PostgreSQL row-locked CAS.
       const threadId=claim?.kind==="run"?claim.attemptId:input.conversationId;
       const config={configurable:{thread_id:threadId}};
       if(!fencing){
         const prior=await compiled.getState(config);
         await verify();
         const request=prior.values?.request as GraphRequest|undefined;
         const completed=prior.values?.researchResult as ResearchResult|undefined;
         if(request?.clientActionId===input.clientActionId){
           if(request.actorUserId!==input.actorUserId||request.userMessage!==input.userMessage)
             throw new Error("duplicate action conflict");
           if(completed?.conversationId===input.conversationId&&
             completed.clientActionId===input.clientActionId&&completed.explanation)return completed;
         }
       }
       const seed=claim?.kind==="run"&&claim.prior?{researchResult:currentDatasetResult(claim.prior,deps.datasetVersion)}:{};
       const run=await compiled.invoke({request:input,...seed},config);
       await verify();
       if(!run.researchResult||run.researchResult.conversationId!==input.conversationId||
           run.researchResult.clientActionId!==input.clientActionId||!run.researchResult.explanation)
         throw new Error("invalid graph result");
       if(fencing&&claim?.kind==="run"){
         if(deps.datasetVersion)run.researchResult.datasetVersion=deps.datasetVersion;
         await fencing.publish(input,claim,run.researchResult);
         await verify();
       }
       return run.researchResult;
       };
       try{
         return lease?await activeLease.run(lease,execute):await execute();
       }finally{if(lease)await lease.release();}
     })();
     inFlight.set(input.conversationId,{
       actorUserId:input.actorUserId,clientActionId:input.clientActionId,
       userMessage:input.userMessage,promise:task
     });
     try{return await task;}
     finally{inFlight.delete(input.conversationId);}
   },
   async getOwnedState(actorUserId:string,conversationId:string){
     await deps.conversations.assertOwned(actorUserId,conversationId);
     const canonical=fencing?await fencing.latest(conversationId):null;
     if(fencing&&!canonical){
       const legacy=await compiled.getState({configurable:{thread_id:conversationId}});
       const previous=legacy.values?.researchResult as ResearchResult|undefined;
       if(previous?.explanation&&previous.conversationId===conversationId)
         throw Error("legacy Brain checkpoint migration required");
       return {values:{}};
     }
     const snapshot=await compiled.getState({configurable:{
       thread_id:canonical?.threadId??conversationId
     }});
     if(canonical){
       const actual=snapshot.values?.researchResult as ResearchResult|undefined;
       if(!actual?.explanation||actual.messageId!==canonical.result.messageId||
          actual.clientActionId!==canonical.result.clientActionId)
         throw Error("published Brain checkpoint not valid");
     }
     const values=snapshot.values as unknown as Record<string,unknown>;
     return {values:values.researchResult?{...values,researchResult:currentDatasetResult(values.researchResult as ResearchResult,deps.datasetVersion)}:values};
   }
 };
}
