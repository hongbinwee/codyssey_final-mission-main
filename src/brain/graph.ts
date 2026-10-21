import {guardBrainMessage} from './routing.ts';
import type {HermesToolPort} from "./hermes-tools.ts";
import {decideHermesAction,performHermesRead,readAgentRoute,summarizeAgentObservations,type AgentAction,type AgentObservation} from "./hermes-agent-step.ts";
import {wishlistIntent,wishlistReply,type WishlistIntent} from "./wishlist-task.ts";
import {ownedTask,nextTask,retainTask,taskForWishlistSelection,resetTaskRequested,type AgentTaskState,type TaskScope} from "./task-state.ts";
import {explainPreviousRecommendation} from "./recommendation-followup.ts";
import {captureDisplayedReviewTargets} from "./review-targets.ts";
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
import {validatedShoppingHandoffs} from "./shopping-handoff.ts";
import {reviewSummaryIntent,summarizeNamedProductReviews,type ReviewSummaryOutcome} from "./review-summary.ts";

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
 reviewSummaryRequest:Annotation<NonNullable<ReturnType<typeof reviewSummaryIntent>>|null>(),
 activeTask:Annotation<AgentTaskState|null>(),
 agentRead:Annotation<boolean>(),agentAction:Annotation<AgentAction|null>(),
 agentObservations:Annotation<AgentObservation[]>(),agentStart:Annotation<number>(),
 agentSearched:Annotation<boolean>(),agentStop:Annotation<string|null>(),agentQuestion:Annotation<string|null>(),
 agentDecisionMs:Annotation<number>(),agentToolMs:Annotation<number>(),agentDecisionCount:Annotation<number>()
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
 const agentPorts=(state:{request:GraphRequest;shoppingPlan?:ShoppingPlan;prepared:PreparedTurn}):HermesToolPort=>({
  purchases:()=>deps.hermes!.history(state.request.actorUserId),
  ...(deps.hermes!.toolPorts?.(state.request.actorUserId)??{}),
  ...(deps.wishlist?{wishlist:()=>deps.wishlist!(state.request.actorUserId)}:{}),
  search:async()=>{throw Error("search is executed by the fenced graph node");},
 });
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
     return {prepared,agentRead:false,agentAction:null,agentObservations:[],agentStart:0,
       agentSearched:false,agentStop:null,agentQuestion:null,
       agentDecisionMs:0,agentToolMs:0,agentDecisionCount:0};
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
     const guard=guardBrainMessage(state.request.userMessage);
     const reviewRequest=deps.reviewSummary&&guard?.kind!=="UNCERTAIN"&&guard?.kind!=="CS_REQUEST"?
       reviewSummaryIntent(state.request.userMessage):null;
     if(reviewRequest||deps.reviewSummary&&activeTask?.kind==="REVIEW_SUMMARY"&&
       activeTask.phase==="AWAITING_INPUT"&&guard===undefined&&
       state.request.userMessage.trim().length>=2&&!/추천|비교|구매|주문|취소|환불/.test(state.request.userMessage)){
       const target=reviewRequest??{target:state.request.userMessage.trim().slice(0,120),ordinal:null,negativeOnly:false};
       await verify();return {reviewSummaryRequest:target,activeTask,priorExplanation:null,wishlistRequest:null,
         intentRoute:{kind:"REVIEW_SUMMARY" as const,search:false},routeMs:performance.now()-started};
     }
     const priorExplanation=explainPreviousRecommendation(state.request.userMessage,state.researchResult,deps.datasetVersion);
     if(priorExplanation){await verify();return {priorExplanation,activeTask,intentRoute:{kind:"SHOPPING_FOLLOWUP" as const,search:false},
       routeMs:performance.now()-started};}
     const wishlistRequest=deps.wishlist?wishlistIntent(state.request.userMessage,taskForWishlistSelection(activeTask)):null;
     if(wishlistRequest){await verify();return {wishlistRequest,activeTask,priorExplanation:null,
       intentRoute:{kind:"SHOPPING_FOLLOWUP" as const,search:false},routeMs:performance.now()-started};}
     if(deps.hermes&&readAgentRoute(state.request.userMessage)&&guard?.kind!=="UNCERTAIN"){
       const available=deps.hermes.toolPorts?.(state.request.actorUserId);
       if(available&&(available.cart||available.orders)){
         await verify();return {agentRead:true,activeTask,priorExplanation:null,wishlistRequest:null,
           intentRoute:{kind:"CS_REQUEST" as const,search:false},routeMs:performance.now()-started};
       }
     }
     const answer=deps.clarifyBeforeSearch&&interviewAnswer(state.request.userMessage,previous);
     const follow=previous&&['다른 상품 보기','다른 제품 보기','조건 바꾸기'].includes(state.request.userMessage.trim());
     const route=guardBrainMessage(state.request.userMessage)??(answer||follow?{kind:"SHOPPING_FOLLOWUP" as const,search:true}:await (deps.route?.(state.request.userMessage,state.researchResult?.shoppingPlan)??{kind:"SHOPPING_SEARCH" as const,search:true}));
     // A bounded follow-up answer continues the same suspended task; a clear new
     // intent (including greetings and writes) is never captured by this path.
     if(activeTask?.phase==="AWAITING_INPUT"&&activeTask.pendingQuestion==="agent_followup"&&
       route.kind==="UNCERTAIN"&&guard?.kind!=="UNCERTAIN"&&deps.hermes){
       const read=activeTask.kind==="ORDER"||activeTask.kind==="CART"||activeTask.kind==="WISHLIST";
       const available=deps.hermes.toolPorts?.(state.request.actorUserId);
       if(!read||available?.cart||available?.orders||deps.wishlist){
         await verify();return {activeTask,agentRead:read,priorExplanation:null,wishlistRequest:null,
           intentRoute:{kind:"SHOPPING_FOLLOWUP" as const,search:!read},
           routeMs:performance.now()-started};
       }
     }
     await verify();return {intentRoute:route,activeTask,priorExplanation:null,wishlistRequest:null,routeMs:performance.now()-started};
   })
   .addNode("review_summary",async state=>{
     if(!deps.reviewSummary||!state.reviewSummaryRequest)throw Error("review summary source unavailable");
     const start=performance.now(),prev=state.researchResult;
     const hasPrevious=prev?.datasetVersion===deps.datasetVersion&&prev?.conversationId===state.request.conversationId;
     // Only products actually presented by the server in this actor's conversation.
     // A model-produced ordinal or arbitrary product ID is never accepted as authority.
     const ids=hasPrevious?prev?.shoppingPlan?.lastDisplayedProductIds??state.activeTask?.displayedProductIds??[]:
       state.activeTask?.displayedProductIds??[];
     const selected=state.activeTask?.selectedProductId;
     let outcome:ReviewSummaryOutcome;
     try{
       outcome=await summarizeNamedProductReviews({request:state.reviewSummaryRequest,
         previousDisplayedIds:ids,previousSelectedId:selected,
         source:deps.reviewSummary,provider:deps.reviewSummaryProvider});
     }catch{
       outcome={kind:"NOT_FOUND",text:"리뷰를 불러오는 중 문제가 생겼어요. 잠시 후 다시 확인해 주세요."};
     }
     const item=outcome.kind==="SUMMARY"?outcome:null;
     const asking=outcome.kind==="CLARIFY";
     const result:ResearchResult={
       conversationId:state.request.conversationId,messageId:state.prepared.messageId,
       clientActionId:state.request.clientActionId,intentKind:"REVIEW_SUMMARY",datasetVersion:deps.datasetVersion,
       ...(hasPrevious&&prev?.shoppingPlan?{shoppingPlan:prev.shoppingPlan}:{}),
       ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
       ...(item?{reviewSummary:{productId:item.productId,name:item.productName,
         sampled:item.sampled,totalMatching:item.totalMatching,citations:item.citations}}:{}),
       taskState:nextTask(taskScope(state.request),"REVIEW_SUMMARY",state.activeTask,{
         phase:asking?"AWAITING_INPUT":item?"ACTIVE":"UNAVAILABLE",
         pendingQuestion:asking?"agent_followup":undefined,
         displayedProductIds:item?[item.productId]:[],selectedProductId:item?.productId}),
       explanation:{kind:asking?"CLARIFICATION":item?"REVIEW_SUMMARY":"CONVERSATION",
         text:outcome.text,items:[],limitations:[]},
       trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:performance.now()-start,
         rankMs:0,responseMs:0,totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {researchResult:result,evidence:[]};
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
       ...(reply?{agentUi:reply.view,shoppingHandoffs:validatedShoppingHandoffs({wishlist:reply.view})}:{}),datasetVersion:deps.datasetVersion,
       taskState:nextTask(taskScope(state.request),"WISHLIST",state.activeTask,{
         phase:reply?"ACTIVE":"UNAVAILABLE",displayedProductIds:reply?.view.items.map(item=>item.productId)??[],
         selectedProductId:reply?.view.selectedProductId}),
       explanation:{kind:"CONVERSATION",items:[],limitations:[],text:reply?.text??"지금은 찜 목록을 불러올 수 없어요. 잠시 후 다시 확인해 주세요."},
       trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,
         responseMs:performance.now()-started,totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {researchResult,evidence:[]};
   })
   .addNode("agent_decide",async state=>{
     if(!deps.hermes)throw Error("Hermes provider unavailable");
     // LLM reads only bounded, server-produced observations. Never a model-owned user ID.
     const startAt=state.agentStart>0?state.agentStart:Date.now();
     const decisionStarted=performance.now();
     const decision=await decideHermesAction({
       provider:deps.hermes.provider,message:state.request.userMessage,
       plan:state.intentRoute.search?state.shoppingPlan:undefined,
       memories:state.prepared.memories,task:state.activeTask,
       observations:state.agentObservations??[],tools:agentPorts(state),
       offerSearch:state.intentRoute.search,startedAt:startAt,
     });
     const metrics={agentDecisionMs:(state.agentDecisionMs??0)+performance.now()-decisionStarted,
       agentDecisionCount:(state.agentDecisionCount??0)+1};
     await verify();
     return decision.kind==="CALL"?{...metrics,agentStart:startAt,agentAction:decision.action,agentStop:null,agentQuestion:null}:
       {...metrics,agentStart:startAt,agentAction:null,agentStop:decision.reason,agentQuestion:decision.question??null};
   })
   .addNode("agent_execute",async state=>{
     const action=state.agentAction;
     if(!action)throw Error("missing agent action");
     const observations=state.agentObservations??[];
     const toolStarted=performance.now();
     if(action.name==="search_products"){
       if(!state.intentRoute.search||!state.shoppingPlan)throw Error("unplanned search denied");
       let plan=state.shoppingPlan;
       const history=observations.find(o=>o.tool==="get_purchase_history"&&o.ok);
       const purchases=(history?.data as {purchases?:import("./purchase-history.ts").PurchaseSnapshot[]})?.purchases??[];
       const prior=purchases[0];
       const unspecified=!plan.category&&/^(전에|이전에|지난번|그|구매|산 것)/.test(plan.query);
       const matched=prior&&plan.query.replace(/\s/g,"").length>=2&&
         prior.productName.replace(/\s/g,"").includes(plan.query.replace(/\s/g,""));
       if(prior&&(unspecified||matched))plan={...plan,...(unspecified?{query:prior.productName}:{}),
         category:prior.category,...(plan.category!==prior.category?{attributePreferences:[]}:{})};
       try{
         const fetched=await retrieveTurn(state.request,state.prepared,plan,deps);
         // Past-purchase comparisons must use the actor's observed history, never imagined purchases.
         if(/전에|이전에|지난번|구매했던|산 것/.test(state.request.userMessage)&&
           /저렴|더 싸|보다 싸|가격.*낮|리뷰.*많|후기.*많|리뷰 수|후기 수/.test(state.request.userMessage)){
           const cheaper=/저렴|더 싸|보다 싸|가격.*낮/.test(state.request.userMessage);
           const review=/리뷰.*많|후기.*많|리뷰 수|후기 수/.test(state.request.userMessage);
           const previousCount=prior&&review?await deps.hermes!.reviewCount(prior.productId):null;
           const selected=fetched.result.ranking.ranked.filter(row=>{
             const c=row.candidate;
             return !!prior&&c.productId!==prior.productId&&
               (!cheaper||(c.unitPriceWon!==null&&c.unitPriceWon<prior.unitPriceWon))&&
               (!review||(previousCount!==null&&c.wholeReviewCountVerified&&
                 c.wholeReviewCount!==null&&c.wholeReviewCount>previousCount));
           });
           fetched.result.ranking={...fetched.result.ranking,ranked:selected,referenceOnly:[]};
         }
         await verify();
         const observation:AgentObservation={tool:"search_products",ok:true,data:{
           validated_candidates:fetched.result.ranking.ranked.slice(0,3).map(x=>({
             productId:x.candidate.productId,variantId:x.candidate.variantId,
             totalPriceWon:(x.candidate.unitPriceWon??0)+(x.candidate.shippingFeeWon??0),
             reviewCount:x.candidate.wholeReviewCountVerified?x.candidate.wholeReviewCount:null
           }))
         }};
         return {shoppingPlan:plan,researchResult:{...fetched.result,intentKind:state.intentRoute.kind},
           evidence:fetched.evidence,agentSearched:true,agentObservations:[...observations,observation],agentAction:null,
           agentToolMs:(state.agentToolMs??0)+performance.now()-toolStarted};
       }catch(error){
         if(!(error instanceof RetrievalUnavailableError))throw error;
         await verify();return {...unavailable(state.request,state.prepared,plan,state.intentRoute,state.activeTask),
           agentSearched:false,agentStop:"RETRIEVAL_UNAVAILABLE",agentAction:null,
           agentObservations:[...observations,{tool:"search_products",ok:false,data:{unavailable:true}}],
           agentToolMs:(state.agentToolMs??0)+performance.now()-toolStarted};
       }
     }
     const observation=await performHermesRead(action,agentPorts(state));
     await verify();return {agentObservations:[...observations,observation],agentAction:null,
       agentToolMs:(state.agentToolMs??0)+performance.now()-toolStarted};
   })
   .addNode("agent_recover",async state=>{
     // Degraded-mode recovery only: an explicit product-discovery request was
     // left without validated candidates by the model. Never invoked for CS reads.
     if(!deps.hermes||!state.intentRoute.search||!state.shoppingPlan)throw Error("recovery requires planned shopping search");
     let plan=state.shoppingPlan;
     const observed=state.agentObservations??[];
     const actorPurchases=(observed.find(o=>o.tool==="get_purchase_history"&&o.ok)?.data as
       {purchases?:import("./purchase-history.ts").PurchaseSnapshot[]}|undefined)?.purchases;
     const refersToPast=/(전에|이전에|지난번|구매했던|산 것)/.test(state.request.userMessage);
     const recent=refersToPast?(actorPurchases??await deps.hermes.history(state.request.actorUserId)):[];
     const prior=recent[0];
     const noProductKind=!plan.category&&/^(전에|이전에|지난번|그|구매|산 것)/.test(plan.query);
     const matching=prior&&plan.query.replace(/\s/g,"").length>=2&&
       prior.productName.replace(/\s/g,"").includes(plan.query.replace(/\s/g,""));
     if(prior&&(noProductKind||matching))plan={...plan,
       ...(noProductKind?{query:prior.productName}:{}),category:prior.category,
       ...(plan.category!==prior.category?{attributePreferences:[]}:{})};
     let fetched:Awaited<ReturnType<typeof retrieveTurn>>;
     try{fetched=await retrieveTurn(state.request,state.prepared,plan,deps);}
     catch(error){
       if(!(error instanceof RetrievalUnavailableError))throw error;
       await verify();
       return {shoppingPlan:plan,...unavailable(state.request,state.prepared,plan,state.intentRoute,state.activeTask)};
     }
     const cheaper=/(저렴|더 싸|보다 싸|가격.*낮)/.test(state.request.userMessage);
     const reviews=/(리뷰.*많|후기.*많|리뷰 수|후기 수)/.test(state.request.userMessage);
     if(refersToPast&&(cheaper||reviews)){
       const earlierCount=prior&&reviews?await deps.hermes.reviewCount(prior.productId):null;
       fetched.result.ranking={...fetched.result.ranking,
         ranked:fetched.result.ranking.ranked.filter(row=>{
           const c=row.candidate;
           return !!prior&&c.productId!==prior.productId&&
             (!cheaper||(c.unitPriceWon!==null&&c.unitPriceWon<prior.unitPriceWon))&&
             (!reviews||(earlierCount!==null&&c.wholeReviewCountVerified&&
               c.wholeReviewCount!==null&&c.wholeReviewCount>earlierCount));
         }),referenceOnly:[]};
     }
     await verify();return {shoppingPlan:plan,researchResult:{...fetched.result,intentKind:state.intentRoute.kind,
       trace:{...fetched.result.trace,hermesRecovered:1,hermesToolCalls:observed.length}},
       evidence:fetched.evidence,agentSearched:true};
   })
   .addNode("agent_finish",async state=>{
     const start=performance.now();
     const observations=state.agentObservations??[];
     const lastOrder=observations.some(o=>o.tool==="get_orders"||o.tool==="get_order"||o.tool==="get_shipping_status");
     const lastCart=observations.some(o=>o.tool==="get_cart");
     const lastWish=observations.some(o=>o.tool==="get_wishlist");
     const taskKind=lastOrder?"ORDER":lastCart?"CART":lastWish?"WISHLIST":
       state.intentRoute.kind==="REVIEW_COMPARE"?"REVIEW_COMPARE":"DISCOVERY";
     const ids=lastWish?(observations.find(o=>o.tool==="get_wishlist"&&o.ok)?.data as
       {saved_products?:Array<{productId:string}>})?.saved_products?.map(x=>x.productId)??[]:[];
     const text=state.agentStop==="RETRIEVAL_UNAVAILABLE"?
       "상품 검색 연결에 문제가 생겼어요. 확인되지 않은 상품은 추천하지 않을게요.":
       summarizeAgentObservations(observations,state.agentQuestion??undefined);
     const result:ResearchResult={
       conversationId:state.request.conversationId,messageId:state.prepared.messageId,
       clientActionId:state.request.clientActionId,intentKind:state.intentRoute.kind,
       ...(state.intentRoute.search&&state.shoppingPlan?{shoppingPlan:state.shoppingPlan}:state.researchResult?.shoppingPlan?{shoppingPlan:state.researchResult.shoppingPlan}:{}),
       ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},datasetVersion:deps.datasetVersion,
       shoppingHandoffs:validatedShoppingHandoffs({observations}),
       taskState:nextTask(taskScope(state.request),taskKind,state.activeTask,{
         phase:state.agentStop==="RETRIEVAL_UNAVAILABLE"?"UNAVAILABLE":state.agentQuestion?"AWAITING_INPUT":"ACTIVE",
         pendingQuestion:state.agentQuestion?"agent_followup":undefined,displayedProductIds:ids,
       }),
       explanation:{kind:"CONVERSATION",items:[],limitations:[],text},
       trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,
         hermesToolCalls:observations.length,hermesDecisions:state.agentDecisionCount??0,
         hermesDecisionMs:Math.round(state.agentDecisionMs??0),hermesToolMs:Math.round(state.agentToolMs??0),
         hermesFailedTools:observations.filter(o=>!o.ok).length,
         responseMs:performance.now()-start,
         totalMs:performance.now()-state.prepared.startedAt}
     };
     await verify();return {researchResult:result,evidence:[]};
   })
   .addNode("converse",async state=>{
     const previous=resetTaskRequested(state.request.userMessage)?undefined:state.researchResult?.shoppingPlan;
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
       shoppingHandoffs:validatedShoppingHandoffs({
         showOrdersForCancellation:state.intentRoute.kind==="CS_REQUEST"&&
           /취소|환불|반품|교환/.test(state.request.userMessage)&&
           !!deps.hermes?.toolPorts?.(state.request.actorUserId).orders,
       }),
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
       // Explicit user order must cite the inspected aspect; avoid a generic model
       // explanation that can imply a whole-review ranking or unrelated claims.
       explanation:state.researchResult.reviewSortInfo||state.shoppingPlan.priceSortOrder?
         buildGroundedExplanation(state.researchResult.ranking,state.evidence,state.shoppingPlan):
         groundedResponder&&(!deps.fastResponses||state.intentRoute.kind==="REVIEW_COMPARE")
          ?await groundedResponder({originalQuestion:state.request.userMessage,
            ranking:state.researchResult.ranking,evidence:state.evidence,plan:state.shoppingPlan,mode:"RECOMMEND"})
          :buildGroundedExplanation(state.researchResult.ranking,state.evidence,state.shoppingPlan)
     };
     if(researchResult.reviewSortInfo){
       const info=researchResult.reviewSortInfo,aspect=info.aspect;
       const notice=info.status==="VERIFIED_SAMPLE_ORDER"?
         `확인한 일부 리뷰에서 ‘${aspect}’에 대한 긍정 표현이 있는 원본 리뷰 건수로 비교했어요. 전체 리뷰를 확인한 순위는 아니에요.`:
         `‘${aspect}’ 긍정 리뷰 순서를 검증하기에 확인된 근거가 부족해요. 순위를 정하지 않고 참고용 상품만 보여드릴게요.`;
       researchResult.explanation={...researchResult.explanation,text:notice+"\\n\\n"+researchResult.explanation.text};
     }
     if(researchResult.shoppingPlan){

       const displayed=captureDisplayedReviewTargets(researchResult.ranking,researchResult.explanation);
        researchResult.shoppingPlan={...researchResult.shoppingPlan,lastDisplayedProductIds:displayed.map(row=>row.productId),lastDisplayedProducts:displayed};
     }
     researchResult.shoppingHandoffs=validatedShoppingHandoffs({ranking:researchResult.ranking,
       displayedProductIds:researchResult.shoppingPlan?.lastDisplayedProductIds??[]});
     researchResult.taskState=nextTask(taskScope(state.request),state.intentRoute.kind==="REVIEW_COMPARE"?"REVIEW_COMPARE":"DISCOVERY",state.activeTask,
       {displayedProductIds:researchResult.shoppingPlan?.lastDisplayedProductIds??[]});
     researchResult.trace={...researchResult.trace,hermesToolCalls:(state.agentObservations??[]).length,
       hermesDecisions:state.agentDecisionCount??0,hermesDecisionMs:Math.round(state.agentDecisionMs??0),
       hermesToolMs:Math.round(state.agentToolMs??0),hermesFailedTools:(state.agentObservations??[]).filter(o=>!o.ok).length,
       routeMs:state.routeMs,candidatesReadyMs:started-state.prepared.startedAt,responseMs:performance.now()-started,
       totalMs:performance.now()-state.prepared.startedAt};
     await verify();
     return {researchResult};
   })
   .addEdge(START,"prepare")
   .addEdge("prepare","route")
   .addConditionalEdges("route",state=>state.reviewSummaryRequest?"review_summary":state.priorExplanation?"explain_previous":state.wishlistRequest?"wishlist":state.agentRead?"agent_decide":state.intentRoute.search?"plan":"converse",["review_summary","explain_previous","wishlist","agent_decide","plan","converse"])
   .addEdge("review_summary",END)
   .addEdge("explain_previous",END)
   .addEdge("wishlist",END)
   .addEdge("converse",END)
   .addEdge("agent_finish",END)
   .addConditionalEdges("agent_recover",state=>state.researchResult.explanation?.failure?.code==="RETRIEVAL_UNAVAILABLE"?END:"respond",[END,"respond"])
   .addConditionalEdges("plan",state=>deps.clarifyBeforeSearch&&needsInterview(state.shoppingPlan,state.request.userMessage,state.prepared.memories).length?"clarify":deps.hermes?"agent_decide":"retrieve",["clarify","agent_decide","retrieve"])
   .addConditionalEdges("agent_decide",state=>state.agentAction?"agent_execute":
     state.agentSearched?"respond":state.intentRoute.search&&!state.agentQuestion&&
       (state.agentStop==="MODEL_UNAVAILABLE"||state.agentStop==="DONE")&&
       (state.agentObservations??[]).every(o=>o.tool==="get_purchase_history")?"agent_recover":"agent_finish",
     ["agent_execute","respond","agent_recover","agent_finish"])
   .addConditionalEdges("agent_execute",state=>state.agentStop==="RETRIEVAL_UNAVAILABLE"?"agent_finish":"agent_decide",
     ["agent_finish","agent_decide"])
   .addEdge("clarify",END)
   .addConditionalEdges("retrieve",state=>state.researchResult.explanation?.failure?.code==='RETRIEVAL_UNAVAILABLE'?END:'respond',[END,'respond'])
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
