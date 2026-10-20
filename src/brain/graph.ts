import {guardBrainMessage,parseReviewSummaryRequest} from './routing.ts';
import {parseContextReviewRequest,resolveReviewTargets} from './review-reference.ts';
import {interviewAnswer,needsInterview,rememberInterview} from './interview.ts';
import {Annotation,StateGraph,START,END} from "@langchain/langgraph";
import {AsyncLocalStorage} from "node:async_hooks";
import type {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import type {BrainTrace,EvidenceRecord,ProductCandidate,ReviewSummaryRequest} from "./contracts.ts";
import type {PreparedTurn,ResearchDeps,ResearchResult} from "./read-flow.ts";
import {prepareTurn,resolveTurnPlan,retrieveTurn,RetrievalUnavailableError} from "./read-flow.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import {buildGroundedExplanation,type GroundedExplanation,type GroundedResponder} from "./grounded-response.ts";
import type {BrainGraphPort} from "./api.ts";
import type {TurnLock,TurnLease} from "./turn-lock.ts";
import type {FencedTurns} from "./fenced-turns.ts";
import type {BrainRoute} from "./routing.ts";
import {currentDatasetResult} from "./dataset-state.ts";
import type {SafePageContext} from "./page-context.ts";
import type {DisplayedReviewProduct,ReviewAnalysisData,ReviewAnalysisRequest} from "./review-analysis.ts";
import {reviewSortAspectLabel} from "./review-sort.ts";
import {buildReviewAnalysisExplanation} from "./review-analysis-response.ts";

export type GraphRequest=BrainTrace & {clientActionId:string;userMessage:string;pageContext?:SafePageContext};
const unsupportedReviewOrderText="지금은 확인된 긍정 후기 수를 기준으로 비교할 수 있어요. 부정 후기 수나 적은 순으로 정렬하는 기능은 아직 제공하지 않아요. 기존 조건은 유지했어요.";
const reviewSummaryPrompt="어떤 상품의 리뷰를 요약할까요? 상품명을 말씀하시거나, 직전 목록의 번호를 알려주세요.";
const reviewSummaryUnavailable="리뷰 요약을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.";
const reviewAnalysisAspectPrompt="어떤 리뷰 속성을 확인하거나 비교할까요? 예를 들어 보습력이나 사용감을 말씀해 주세요.";
const State=Annotation.Root({
 request:Annotation<GraphRequest>(),
 prepared:Annotation<PreparedTurn>(),
 shoppingPlan:Annotation<ShoppingPlan>(),
 evidence:Annotation<EvidenceRecord[]>(),
 researchResult:Annotation<ResearchResult>()
 ,intentRoute:Annotation<BrainRoute>(),routeMs:Annotation<number>()
});
function pageContextIdentity(context?:SafePageContext):string{
 return JSON.stringify([context?.screen??null,context?.product_id??null,context?.order_id??null]);
}
function emptyRanking():ResearchResult["ranking"]{
 return {ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0};
}
function reviewClarification(focus:"ALL"|"CONS",previous?:ResearchResult):GroundedExplanation{
 const choices=previous?.explanation?.reviewSummary?.choices;
 return {kind:"REVIEW_SUMMARY",text:reviewSummaryPrompt,items:[],limitations:[],reviewSummary:{status:"AMBIGUOUS",focus,evidence:[],
  ...(choices?.length?{choices}:{}),...(previous?.datasetVersion?{datasetVersion:previous.datasetVersion}:{})}};
}
function reviewAnalysisData(request:ReviewAnalysisRequest,status:ReviewAnalysisData["status"],version?:string):ReviewAnalysisData{
 const aspect=request.aspect??"overall";
 return {status,aspect,aspectLabel:reviewSortAspectLabel(aspect),focus:request.focus,compare:request.compare,method:"CONSERVATIVE_RULES",
   ...(version?{datasetVersion:version}:{}),products:[]};
}
function unavailableReviewAnalysis(request:ReviewAnalysisRequest,products:DisplayedReviewProduct[],version?:string):ReviewAnalysisData{
 const data=reviewAnalysisData(request,"UNAVAILABLE",version);
 data.products=products.map(product=>({productId:product.productId,...(product.variantId?{variantId:product.variantId}:{}),
   name:product.name??"상품",displayIndex:product.displayIndex,status:"UNAVAILABLE",totalMatching:0,fetchedCount:0,uniqueCount:0,
   duplicateCount:0,excludedCount:0,counts:{positive:0,negative:0,mixed:0,unrelated:0,uncertain:0},
   countsBySource:{REAL:{positive:0,negative:0,mixed:0,unrelated:0,uncertain:0},SYNTHETIC:{positive:0,negative:0,mixed:0,unrelated:0,uncertain:0}},
   evidence:[],limitations:["Commerce 리뷰 분석을 완료하지 못했습니다."]}));
 return data;
}
function pageProductId(context?:SafePageContext):string|undefined{
 if((context?.screen!=="product"&&context?.screen!=="reviews")||
   typeof context.product_id!=="string"||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.product_id))return;
 return context.product_id;
}
function knownProduct(previous:ResearchResult|undefined,productId:string){
 const summary=previous?.explanation?.reviewSummary;
 if(summary?.product?.id===productId)return summary.product;
 const choice=summary?.choices?.find(row=>row.productId===productId);
 if(choice)return {id:choice.productId,name:choice.name};
 const item=previous?.explanation?.items.find(row=>row.productId===productId);
 if(item)return {id:item.productId,name:item.name,variantId:item.variantId};
}
function reviewDisplayIds(previous:ResearchResult|undefined):string[]{
 const items=previous?.explanation?.items.map(item=>item.productId).filter(Boolean)??[];
 if(items.length)return items;
 const choices=previous?.explanation?.reviewSummary?.choices?.map(choice=>choice.productId).filter(Boolean)??[];
 if(choices.length)return choices;
 return previous?.shoppingPlan?.lastDisplayedProductIds??[];
}
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
 const compiled=new StateGraph(State)
   .addNode("prepare",async state=>{
     const prepared=await prepareTurn(state.request,deps);
     await verify();
     return {prepared};
   })
   .addNode("route",async state=>{
     const started=performance.now();
     const previous=state.researchResult?.shoppingPlan;
     const answer=deps.clarifyBeforeSearch&&interviewAnswer(state.request.userMessage,previous);
     const follow=previous&&['다른 상품 보기','다른 제품 보기','조건 바꾸기'].includes(state.request.userMessage.trim());
     const guarded=guardBrainMessage(state.request.userMessage);
     const contextualReview=parseContextReviewRequest(state.request.userMessage);
     const unsupportedReviewOrder=/(?:리뷰|후기).*(?:적은\s*순|부정.{0,12}많은\s*순)|부정.{0,16}(?:리뷰|후기).{0,8}많은\s*순/.test(state.request.userMessage);
     let route:BrainRoute;
     if(guarded)route=guarded;
     else if(contextualReview){
       const priorAnalysis=state.researchResult?.explanation?.reviewAnalysis;
       const inheritAspect=!!deps.datasetVersion&&state.researchResult?.conversationId===state.request.conversationId&&
         state.researchResult.datasetVersion===deps.datasetVersion&&typeof priorAnalysis?.aspect==="string"&&priorAnalysis.aspect.trim()
         ?priorAnalysis.aspect:undefined;
       const request:ReviewAnalysisRequest={...contextualReview,...(!contextualReview.aspect&&inheritAspect?{aspect:inheritAspect}:{})};
       if(!request.aspect){
         const indexes=request.displayIndexes??[];
         if(request.compare||request.allDisplayed||indexes.length>1)
           route={kind:"UNCERTAIN",search:false,text:reviewAnalysisAspectPrompt};
         else route={kind:"REVIEW_SUMMARY",search:false,reviewSummary:{
           ...(request.useCurrent?{useCurrent:true}:{}),...(indexes.length===1?{displayIndex:indexes[0]}:{}),focus:request.focus,
         }};
       }else route={kind:"REVIEW_ANALYSIS",search:false,reviewAnalysis:request};
     }
     else if(unsupportedReviewOrder)route={kind:"UNCERTAIN",search:false,text:unsupportedReviewOrderText};
     else{
       const summaryCandidate=parseReviewSummaryRequest(state.request.userMessage);
       const routed=(summaryCandidate||!answer&&!follow)
         ?await (deps.route?.(state.request.userMessage,state.researchResult?.shoppingPlan)??
           (summaryCandidate?{kind:"REVIEW_SUMMARY" as const,search:false,reviewSummary:summaryCandidate}:{kind:"SHOPPING_SEARCH" as const,search:true}))
         :undefined;
       route=routed?.kind==="REVIEW_SUMMARY"?{...routed,reviewSummary:routed.reviewSummary??summaryCandidate??{focus:"ALL" as const}}
         :answer||follow?{kind:"SHOPPING_FOLLOWUP",search:true}:routed??{kind:"SHOPPING_SEARCH",search:true};
     }
     await verify();return {intentRoute:route,routeMs:performance.now()-started};
   })
   .addNode("converse",async state=>{
     const previous=state.researchResult?.shoppingPlan;
     const started=performance.now();
     const fixedClarification=state.intentRoute.kind==="UNCERTAIN"&&state.intentRoute.text===reviewAnalysisAspectPrompt;
     const explanation=deps.converse&&!fixedClarification&&state.intentRoute.text!==unsupportedReviewOrderText?await deps.converse({message:state.request.userMessage,route:state.intentRoute,previous}):
       {kind:"CONVERSATION" as const,text:state.intentRoute.text??"어떤 상품을 찾으시는지 알려주세요.",items:[],limitations:[]};
     await verify();
     const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,
       clientActionId:state.request.clientActionId,intentKind:state.intentRoute.kind,
       ...(previous?{shoppingPlan:previous}:{}),
       ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
       explanation,
       datasetVersion:deps.datasetVersion,trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,responseMs:performance.now()-started,
         totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {researchResult,evidence:[]};
   })
   .addNode("review-summary",async state=>{
     const started=performance.now();
     const previous=state.researchResult?.explanation?state.researchResult:undefined;
     const shoppingPlan=previous?.shoppingPlan??state.shoppingPlan;
     const request:ReviewSummaryRequest=state.intentRoute.reviewSummary??{focus:"ALL"};
     const finish=async(explanation:GroundedExplanation)=>{
       const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,
         clientActionId:state.request.clientActionId,intentKind:"REVIEW_SUMMARY",...(shoppingPlan?{shoppingPlan}:{}),
         datasetVersion:deps.datasetVersion,ranking:emptyRanking(),explanation,
         trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,
           responseMs:performance.now()-started,totalMs:performance.now()-state.prepared.startedAt}};
       await verify();return {researchResult,evidence:[],...(shoppingPlan?{shoppingPlan}:{})};
     };
     const visibleIds=new Set([
       ...(previous?.shoppingPlan?.lastDisplayedProductIds??[]),
       ...(previous?.explanation?.items??[]).map(item=>item.productId),
       ...(previous?.explanation?.reviewSummary?.choices??[]).map(choice=>choice.productId),
     ]);
     const callbackRequest:ReviewSummaryRequest={...request};
     delete callbackRequest.pageProductId;
     let targetProductId:string|undefined;
     if(request.productId){
       if(!visibleIds.has(request.productId))return finish(reviewClarification(request.focus,previous));
       targetProductId=request.productId;
     }else if(request.displayIndex!==undefined){
       const ids=reviewDisplayIds(previous);
       if(!Number.isSafeInteger(request.displayIndex)||request.displayIndex<1||request.displayIndex>3||!ids[request.displayIndex-1])
         return finish(reviewClarification(request.focus,previous));
       targetProductId=ids[request.displayIndex-1];
       callbackRequest.productId=targetProductId;
     }else if(request.useCurrent){
       const pageId=pageProductId(state.request.pageContext);
       if(pageId)callbackRequest.pageProductId=pageId;
       else{
         const summaryProduct=previous?.explanation?.reviewSummary?.product;
         const displayed=previous?.shoppingPlan?.lastDisplayedProductIds??[];
         const singleItem=previous?.explanation?.items.length===1?previous.explanation.items[0].productId:undefined;
         targetProductId=summaryProduct?.id??(displayed.length===1?displayed[0]:singleItem);
         if(!targetProductId)return finish(reviewClarification(request.focus,previous));
         callbackRequest.productId=targetProductId;
       }
     }else if(!request.query?.trim()||request.query.length>120){
       return finish(reviewClarification(request.focus,previous));
     }
     try{
       if(!deps.reviewSummary)throw new Error("review summary unavailable");
       let explanation=await deps.reviewSummary({request:callbackRequest,previous});
       if(explanation.kind!=="REVIEW_SUMMARY")throw new Error("invalid review summary result");
       const id=targetProductId??callbackRequest.productId??callbackRequest.pageProductId;
       const product=id?knownProduct(previous,id):undefined;
       if(product&&explanation.reviewSummary&&!explanation.reviewSummary.product)
         explanation={...explanation,reviewSummary:{...explanation.reviewSummary,product}};
       return await finish(explanation);
     }catch{
       return finish({kind:"REVIEW_SUMMARY",text:reviewSummaryUnavailable,items:[],limitations:["리뷰 조회에 실패했어요."]});
     }
   })
   .addNode("review-analysis",async state=>{
     const started=performance.now();
     const previous=state.researchResult?.explanation?state.researchResult:undefined;
     const shoppingPlan=previous?.shoppingPlan??state.shoppingPlan;
     const request=state.intentRoute.reviewAnalysis??{focus:"ALL" as const,compare:false};
     const resolved=resolveReviewTargets(request,previous,deps.datasetVersion);
     const finish=async(data:ReviewAnalysisData)=>{
       const explanation=buildReviewAnalysisExplanation(data);
       const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,
         clientActionId:state.request.clientActionId,intentKind:"REVIEW_ANALYSIS",...(shoppingPlan?{shoppingPlan}:{}),
         datasetVersion:deps.datasetVersion,ranking:emptyRanking(),explanation,
         trace:{memoryMs:state.prepared.memoryMs,routeMs:state.routeMs,intentMs:0,retrievalMs:0,rankMs:0,
           responseMs:performance.now()-started,totalMs:performance.now()-state.prepared.startedAt}};
       await verify();return {researchResult,evidence:[],...(shoppingPlan?{shoppingPlan}:{})};
     };
     if(resolved.needsTarget)return finish(reviewAnalysisData(request,"NEEDS_TARGET",deps.datasetVersion));
     try{
       if(!deps.reviewAnalysis)throw new Error("review analysis unavailable");
       const data=await deps.reviewAnalysis({request,products:resolved.products});
       await verify();
       const validStatus=data?.status==="READY"||data?.status==="PARTIAL"||data?.status==="UNAVAILABLE";
       const matchesTargets=Array.isArray(data?.products)&&data.products.length===resolved.products.length&&
         data.products.every((row,index)=>row.productId===resolved.products[index]?.productId&&
           row.variantId===resolved.products[index]?.variantId&&row.displayIndex===resolved.products[index]?.displayIndex);
       if(!validStatus||!matchesTargets||data.method!=="CONSERVATIVE_RULES"||
         data.focus!==request.focus||data.compare!==request.compare||
         deps.datasetVersion&&data.datasetVersion!==deps.datasetVersion)
         throw new Error("invalid review analysis result");
       return finish(data);
     }catch{
       return finish(unavailableReviewAnalysis(request,resolved.products,deps.datasetVersion));
     }
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
     const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,clientActionId:state.request.clientActionId,intentKind:state.intentRoute.kind,shoppingPlan:plan,datasetVersion:deps.datasetVersion,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},explanation:{kind:"CLARIFICATION",text:questions[0]?.text??"원하는 조건을 알려주세요.",items:[],limitations:[],clarification:{questions}},trace:{memoryMs:state.prepared.memoryMs,intentMs:performance.now()-state.prepared.startedAt-state.prepared.memoryMs,retrievalMs:0,rankMs:0,responseMs:0,totalMs:performance.now()-state.prepared.startedAt}};
     await verify();return {shoppingPlan:plan,researchResult,evidence:[]};
   })
   .addNode("retrieve",async state=>{
     let fetched;
     try{fetched=await retrieveTurn(state.request,state.prepared,state.shoppingPlan,deps);}
     catch(error){
       if(!(error instanceof RetrievalUnavailableError))throw error;
       await verify();
       const researchResult:ResearchResult={conversationId:state.request.conversationId,messageId:state.prepared.messageId,clientActionId:state.request.clientActionId,
         intentKind:state.intentRoute.kind,shoppingPlan:state.shoppingPlan,datasetVersion:deps.datasetVersion,
         ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
         explanation:{kind:'NO_MATCH',text:'상품 정보를 불러오는 연결에 문제가 생겼어요.\n\n말씀하신 조건은 그대로 보관했어요. 잠시 후 다시 찾아볼까요?',items:[],limitations:[],failure:{code:'RETRIEVAL_UNAVAILABLE'}},
         trace:{memoryMs:state.prepared.memoryMs,intentMs:0,retrievalMs:0,rankMs:0,responseMs:0,totalMs:performance.now()-state.prepared.startedAt}};
       return {researchResult,evidence:[]};
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
       const displayed:DisplayedReviewProduct[]=[],seen=new Set<string>();
       const add=(candidate:ProductCandidate,name?:string)=>{
         if(candidate.commerceVerified!==true)return;
         const key=`${candidate.productId}\u0000${candidate.variantId}`;
         if(seen.has(key)||displayed.length>=3)return;
         seen.add(key);displayed.push({productId:candidate.productId,variantId:candidate.variantId,
           ...(name||candidate.productName?{name:name??candidate.productName}:{}),displayIndex:displayed.length+1});
       };
       for(const item of researchResult.explanation.items){
         const match=researchResult.ranking.ranked.find(row=>row.candidate.productId===item.productId&&row.candidate.variantId===item.variantId);
         if(match)add(match.candidate,item.name);
       }
       for(const row of researchResult.ranking.referenceOnly)add(row.candidate,row.candidate.productName);
       researchResult.shoppingPlan={...researchResult.shoppingPlan,
         lastDisplayedProductIds:displayed.map(row=>row.productId),lastDisplayedProducts:displayed};
     }
     researchResult.trace={...researchResult.trace,routeMs:state.routeMs,candidatesReadyMs:started-state.prepared.startedAt,responseMs:performance.now()-started,
       totalMs:performance.now()-state.prepared.startedAt};
     await verify();
     return {researchResult};
   })
   .addEdge(START,"prepare")
   .addEdge("prepare","route")
   .addConditionalEdges("route",state=>state.intentRoute.kind==="REVIEW_ANALYSIS"?"review-analysis":state.intentRoute.kind==="REVIEW_SUMMARY"?"review-summary":state.intentRoute.search?"plan":"converse",["review-analysis","review-summary","plan","converse"])
   .addEdge("review-analysis",END)
   .addEdge("review-summary",END)
   .addEdge("converse",END)
   .addConditionalEdges("plan",state=>deps.clarifyBeforeSearch&&needsInterview(state.shoppingPlan,state.request.userMessage,state.prepared.memories).length?"clarify":"retrieve",["clarify","retrieve"])
   .addEdge("clarify",END)
   .addConditionalEdges("retrieve",state=>state.researchResult.explanation?.failure?.code==='RETRIEVAL_UNAVAILABLE'?END:'respond',[END,'respond'])
   .addEdge("respond",END)
   .compile({checkpointer});
 // One-process deduplication ONLY; production multi-replica requires a DB lock.
 // The map is scoped to one compiled graph instance and never authorizes a user.
 const inFlight=new Map<string,{actorUserId:string;clientActionId:string;userMessage:string;pageContextKey:string;promise:Promise<ResearchResult>}>();
 return {
   async invoke(input:GraphRequest){
     await deps.conversations.assertOwned(input.actorUserId,input.conversationId);
     const pending=inFlight.get(input.conversationId);
     if(pending){
       if(pending.actorUserId===input.actorUserId&&
          pending.clientActionId===input.clientActionId&&pending.userMessage===input.userMessage&&
          pending.pageContextKey===pageContextIdentity(input.pageContext))
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
           if(request.actorUserId!==input.actorUserId||request.userMessage!==input.userMessage||
             pageContextIdentity(request.pageContext)!==pageContextIdentity(input.pageContext))
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
       userMessage:input.userMessage,pageContextKey:pageContextIdentity(input.pageContext),promise:task
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
