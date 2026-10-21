import {interviewAnswer} from './interview.ts';
import type {RecentAgentTurn} from "./agent-context.ts";
import type {Provider} from "../llm.ts";
import type {HermesToolPort} from "./hermes-tools.ts";
import type {PurchaseSnapshot} from "./purchase-history.ts";
import type {ConversationResponder} from "./conversation-response.ts";
import type {BrainTrace,EvidenceRecord,MemoryRepository,Preference,RankingResult,RetrieverPort} from "./contracts.ts";
import type {PersistentConversations} from "./persistent-store.ts";
import {rankProducts} from "./personalization.ts";
import {curateRecommendations,type CommerceActivity} from "./recommendation-strategies.ts";
import type {PlanExtraction,ShoppingPlan} from "./shopping-plan.ts";
import {resolveShoppingPlan} from "./shopping-plan.ts";
import {parseKrwTenThousandBand} from "./price-band.ts";
import {isReviewSortCancelled,requestedPositiveReviewSort,sortByVerifiedPositiveReviews} from "./review-sort.ts";
import {requestedPriceSort,isPriceSortOnly,isSortCancellationOnly,isPriceSortCancelled,sortByVerifiedTotal} from "./price-sort.ts";
import type {GroundedExplanation} from "./grounded-response.ts";
import type {WishlistItem,WishlistView} from "./wishlist-task.ts";
import type {ShoppingHandoff} from "./shopping-handoff.ts";
import type {VerifiedReviewSummarySource} from "./review-summary.ts";
import type {AgentTaskState} from "./task-state.ts";
import type {BrainRoute,BrainIntentKind} from "./routing.ts";

export type ShoppingIntent=PlanExtraction & {attributeSources?:Record<string,string>};
export interface IntentPort {
 extract(userMessage:string,knownPreferences:Preference[],previous?:ShoppingPlan):Promise<ShoppingIntent>
}
export interface ResearchResult {
 datasetVersion?:string;
 conversationId:string;messageId:string;clientActionId?:string;ranking:RankingResult;
 shoppingPlan?:ShoppingPlan;
 agentUi?:WishlistView;
 shoppingHandoffs?:ShoppingHandoff[];
 reviewSortInfo?:{aspect:string;status:"VERIFIED_SAMPLE_ORDER"|"INSUFFICIENT";sampledReviewIds:number;positiveCounts:Record<string,number>};
 reviewSummary?:{productId:string;name:string;sampled:number;totalMatching:number;citations:{sourceId:string;quote:string;sourceKind:"REAL"|"SYNTHETIC";sourceVariantId:string|null}[]};
 taskState?:AgentTaskState;
 explanation?:GroundedExplanation;
 intentKind?:BrainIntentKind;
 trace:{memoryMs:number;intentMs:number;retrievalMs:number;rankMs:number;totalMs:number;[key:string]:number}
}
export interface ResearchDeps {
 agentPlanning?:boolean;
 clarifyBeforeSearch?:boolean;
 recentTurns?:(actorUserId:string,conversationId:string)=>Promise<RecentAgentTurn[]>;
 reviewSummary?:VerifiedReviewSummarySource;
 reviewSummaryProvider?:Pick<Provider,"chat">;
 hermes?:{provider:Pick<Provider,"chat">;history:(actorUserId:string)=>Promise<PurchaseSnapshot[]>;reviewCount:(productId:string)=>Promise<number|null>;
  toolPorts?:(actorUserId:string)=>Partial<Pick<HermesToolPort,"cart"|"product"|"reviews"|"orders"|"order"|"shipping">>};
 datasetVersion?:string;
 conversations:Pick<PersistentConversations,"assertOwned"|"appendUserMessage">;
 memory:MemoryRepository;retriever:RetrieverPort;intent:IntentPort;
 route?:(message:string,previous?:ShoppingPlan)=>BrainRoute|Promise<BrainRoute>;
 converse?:ConversationResponder;
 activity?:(actorUserId:string)=>Promise<CommerceActivity>;
 wishlist?:(actorUserId:string)=>Promise<WishlistItem[]>;
 fastResponses?:boolean;
}
export interface PreparedTurn {
 messageId:string;memories:Preference[];startedAt:number;memoryMs:number;
 recentTurns?:RecentAgentTurn[];historyMs?:number
}
export interface RetrievedTurn {
 result:ResearchResult;evidence:EvidenceRecord[]
}
type Request=BrainTrace & {userMessage:string;clientActionId:string};
export class RetrievalUnavailableError extends Error {constructor(){super('retrieval unavailable');this.name='RetrievalUnavailableError';}}

function isConditionOnlySyntheticReference(
 blocked:RankingResult["rejected"][number],
 requiredConditions:string[],
 evidence:EvidenceRecord[],
):boolean {
 const candidate=blocked.candidate;
 if(candidate.commerceVerified!==true||candidate.sourceKind!=="SYNTHETIC"||
    candidate.isSimulated===true||
    typeof candidate.datasetVersion!=="string"||!candidate.datasetVersion||
    requiredConditions.length===0||blocked.reasons.length===0||
    !blocked.reasons.every(reason=>reason.startsWith("unverified_required_condition:")))return false;

 const byId=new Map<string,EvidenceRecord>(),duplicates=new Set<string>();
 for(const row of evidence){if(byId.has(row.id))duplicates.add(row.id);byId.set(row.id,row);}
 for(const condition of requiredConditions){
   const ids=candidate.conditions[condition]??[];
   if(!Array.isArray(ids))return false;
   for(const id of ids){
     const row=byId.get(id);
     if(duplicates.has(id)||!row||row.productId!==candidate.productId||
        (row.variantId!==null&&row.variantId!==candidate.variantId)||
        (row.kind==="REVIEW"&&row.sourceKind!=="REAL"))return false;
   }
 }
 return true;
}

export async function prepareTurn(req:Request,deps:ResearchDeps):Promise<PreparedTurn>{
 const t0=performance.now();
 if(!req.actorUserId||!req.conversationId||!req.requestId||!req.userMessage?.trim()||!req.clientActionId)
   throw new Error("invalid authenticated research request");
 await deps.conversations.assertOwned(req.actorUserId,req.conversationId);
 const messageId=await deps.conversations.appendUserMessage(req.actorUserId,req.conversationId,req.clientActionId,req.userMessage);
 const memories=await deps.memory.list(req.actorUserId);
 if(memories.some(m=>m.userId!==req.actorUserId))throw new Error("cross-tenant memory response");
 const memoryMs=performance.now()-t0;
 const historyStarted=performance.now();
 // Optional, bounded and actor-scoped. A history outage cannot block a live shopping turn.
 let recentTurns:RecentAgentTurn[]=[];
 if(deps.hermes&&deps.recentTurns){
  try{recentTurns=(await deps.recentTurns(req.actorUserId,req.conversationId)).slice(-4);}
  catch{recentTurns=[];}
 }
 return {messageId,memories,startedAt:t0,memoryMs,recentTurns,historyMs:performance.now()-historyStarted};
}
function resolveSortPlan(message:string,plan:ShoppingPlan,previous:ShoppingPlan|null|undefined,newTask=false):ShoppingPlan{
 const price=requestedPriceSort(message),aspect=requestedPositiveReviewSort(message);
 const cancelled=isSortCancellationOnly(message)||isReviewSortCancelled(message)||isPriceSortCancelled(message)||
  /^(?:그냥\s*추천(?:해)?\s*줘|정렬(?:\s*기준)?(?:은|는|을|를)?\s*(?:상관없|취소|해제|초기화|없애))/.test(message.trim())||
  /평점\s*(?:낮은|높은|많은|좋은)?\s*순/.test(message);
 // A newly stated (non-cancelled) criterion replaces the previous criterion.
 return {...plan,priceSortOrder:price??(!aspect&&!cancelled&&!newTask?previous?.priceSortOrder:undefined),
  reviewSortAspect:price?undefined:aspect??(!cancelled&&!newTask?previous?.reviewSortAspect:undefined)};
}
/** Explicit audience is a hard constraint even if intent extraction omits it. */
function statedGender(message:string):"남성용"|"여성용"|null{
  const male=/(?:남성(?:용)?|남자(?:용)?|맨즈)/.test(message);
  const female=/(?:여성(?:용)?|여자(?:용)?|우먼)/.test(message);
  if(male===female||/(?:남성|남자|맨즈|여성|여자|우먼)(?:용)?\s*(?:아닌|제외|말고)/.test(message))return null;
  return male?"남성용":"여성용";
}
function expresslyScopedCategory(message:string,category:string):boolean{
  const names:Record<string,RegExp>={
    beauty:/(?:뷰티|화장품|미용)\s*(?:카테고리|분류|상품|제품|중에서|에서)/,
    fashion:/(?:패션|의류)\s*(?:카테고리|분류|상품|제품|중에서|에서)/,
    food:/(?:식품|음식)\s*(?:카테고리|분류|상품|제품|중에서|에서)/,
    living:/(?:리빙|생활용품)\s*(?:카테고리|분류|상품|제품|중에서|에서)/
  };
  return new RegExp(`(?:^|\\W)${category}(?:$|\\W)`,"i").test(message)||!!names[category]?.test(message);
}
export async function resolveTurnPlan(req:Request,prepared:PreparedTurn,previous:ShoppingPlan|null|undefined,deps:ResearchDeps):Promise<ShoppingPlan>{
 const trimmed=req.userMessage.trim();
 if(deps.clarifyBeforeSearch&&previous?.interview?.pending[0]==='budget'){
   const answered=interviewAnswer(trimmed,previous);
   if(answered)return resolveSortPlan(req.userMessage,answered,previous);
 }
 if(previous&&isSortCancellationOnly(trimmed))return {...previous,revision:previous.revision+1,priceSortOrder:undefined,reviewSortAspect:undefined};
 if(previous&&isPriceSortOnly(trimmed))return resolveSortPlan(trimmed,{...previous,revision:previous.revision+1},previous);
 if(deps.clarifyBeforeSearch&&!requestedPriceSort(trimmed)&&!requestedPositiveReviewSort(trimmed)){const answered=interviewAnswer(trimmed,previous??undefined);if(answered)return resolveSortPlan(req.userMessage,answered,previous,answered.query!==previous?.query);}
 const last=previous?.lastDisplayedProductIds??[];
 const excludeOne=last.find(id=>trimmed===`이 상품 제외: ${id}`);
 const excludeAll=trimmed==="다른 상품 보기"||trimmed==="다른 제품 보기"||trimmed==="추천 상품 전부 제외";
 if(previous&&(excludeOne||excludeAll)){
   const extra=excludeAll?last:[excludeOne!];
   return {...previous,excludedProductIds:[...new Set([...(previous.excludedProductIds??[]),...extra])].slice(0,100),revision:previous.revision+1};
 }
 const intent=await deps.intent.extract(req.userMessage,prepared.memories,previous??undefined);
 let plan=resolveShoppingPlan(previous,intent);
 const gender=statedGender(req.userMessage);
 if(gender&&!plan.requiredConditions.some(condition=>statedGender(condition)===gender))
   plan={...plan,requiredConditions:[...plan.requiredConditions,gender].slice(0,12)};
 const explicitBand=parseKrwTenThousandBand(req.userMessage);
 if(explicitBand)plan={...plan,...explicitBand};
 else if(intent.budgetMode==="SET")plan={...plan,minTotalWon:undefined};
 const changedTask=!!previous&&(intent.queryMode==="SET"||plan.query!==previous.query||
   !!plan.category&&plan.category!==previous.category);
 plan=resolveSortPlan(req.userMessage,plan,previous,changedTask);
 if(!plan.query||plan.query.length>200)throw new Error("invalid shopping plan");
 return plan;
}
export async function retrieveTurn(req:Request,prepared:PreparedTurn,plan:ShoppingPlan,deps:ResearchDeps):Promise<RetrievedTurn>{
 const retrievalStart=performance.now();
 // Confirmed memories only, with this turn's explicit choices taking priority.
 // Do not send ranking defaults as if the user had expressed them.
 const preferences:{[key:string]:string}={};
 for(const memory of [...prepared.memories].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)))
   if(!plan.category||memory.key==='price_priority')preferences[memory.key]=memory.value;
 Object.assign(preferences,plan.category?(plan.currentPreferences.price_priority?{price_priority:plan.currentPreferences.price_priority}:{}):plan.currentPreferences);
 const labels:Record<string,Record<string,string>>={price_priority:{value:'가성비 중심',balanced:'가격과 성능 균형',performance:'성능 중심'},
   eye_comfort:{important:'눈의 편안함 중요'},noise_sensitivity:{important:'소음 적음 선호'}};
 const searchPreferences=[...new Set([...Object.entries(preferences).flatMap(([key,value])=>labels[key]?.[value]?[labels[key][value]]:[]),
   ...(plan.attributePreferences??[]),...(plan.interview?.purpose?[plan.interview.purpose]:[])])].slice(0,20);
 let fetched:Awaited<ReturnType<RetrieverPort['search']>>;
 try{
   const request={query:[plan.query,plan.interview?.purpose].filter(Boolean).join(" ").slice(0,250),maxTotalWon:plan.maxTotalWon,
     ...(plan.minTotalWon!==undefined?{minTotalWon:plan.minTotalWon}:{}),
     requiredConditions:plan.requiredConditions,preferences:searchPreferences,requestId:req.requestId,originalQuestion:req.userMessage,
     ...(plan.category?{category:plan.category}:{}),
     ...(plan.reviewSortAspect?{reviewSortAspect:plan.reviewSortAspect,
       ...(plan.lastDisplayedProductIds?.length?{productIds:[...new Set(plan.lastDisplayedProductIds)].slice(0,20)}:{})}:{})};
   fetched=await deps.retriever.search(request);
   // Inferred categories may return unrelated hits that fail every hard condition.
   // Retry at most once, only when global search is supported and category was not explicit.
   const noEligibleMatches=!fetched.candidates.length||
     plan.requiredConditions.length>0&&
     rankProducts(fetched.candidates,fetched.evidence,plan,prepared.memories).ranked.length===0;
   if(noEligibleMatches&&plan.category&&deps.retriever.supportsGlobalCategorySearch&&
     !expresslyScopedCategory(req.userMessage,plan.category)){
     const global=await deps.retriever.search({...request,category:""});
     // Never replace the first result with more unqualified cross-category hits.
     if(global.candidates.length&&rankProducts(global.candidates,global.evidence,plan,prepared.memories).ranked.length>0)
       fetched=global;
   }
 }catch{throw new RetrievalUnavailableError();}
 if(!fetched||!Array.isArray(fetched.candidates)||!Array.isArray(fetched.evidence)||
    fetched.candidates.length>100||fetched.evidence.length>2500)throw new Error("invalid retrieval result");
 if(deps.hermes&&/(리뷰.?많|후기.?많|리뷰 수|후기 수)/.test(req.userMessage)){
   const ids=[...new Set(fetched.candidates.map(x=>x.productId))].slice(0,10);
   const counts=new Map(await Promise.all(ids.map(async id=>[id,await deps.hermes!.reviewCount(id)] as const)));
   fetched.candidates=fetched.candidates.map(x=>{
     const count=counts.get(x.productId);
     return count!==null&&count!==undefined&&Number.isSafeInteger(count)&&count>=0?
       {...x,wholeReviewCount:count,wholeReviewCountVerified:true}:x;
   });
 }
 const retrievalMs=performance.now()-retrievalStart;
 const rankedAt=performance.now();
 const baseRanking=rankProducts(fetched.candidates,fetched.evidence,plan,prepared.memories);
 const excluded=new Set(plan.excludedProductIds??[]);
 if(excluded.size){
  const removed=baseRanking.ranked.filter(x=>excluded.has(x.candidate.productId));
  baseRanking.ranked=baseRanking.ranked.filter(x=>!excluded.has(x.candidate.productId));
  baseRanking.referenceOnly=baseRanking.referenceOnly.filter(x=>!excluded.has(x.candidate.productId));
  baseRanking.rejected.push(...removed.map(x=>({candidate:x.candidate,reasons:["user_excluded"]})));
 }
 const activity=deps.activity?await deps.activity(req.actorUserId):undefined;
 const reviewSort=plan.reviewSortAspect?
   sortByVerifiedPositiveReviews(baseRanking,fetched.evidence,plan.reviewSortAspect):null;
 // Explicit user order outranks cart/wishlist, recommendation slots and generic personalized cost scores.
 const ranking=plan.priceSortOrder?sortByVerifiedTotal(baseRanking,plan.priceSortOrder):
   reviewSort?reviewSort.ranking:deps.activity?curateRecommendations(baseRanking,activity):baseRanking;
 const conditionOnlyReferences=ranking.rejected.filter(item=>
   isConditionOnlySyntheticReference(item,plan.requiredConditions,fetched.evidence));
 if(conditionOnlyReferences.length){
   const moved=new Set(conditionOnlyReferences);
   ranking.rejected=ranking.rejected.filter(item=>!moved.has(item));
   ranking.referenceOnly.push(...conditionOnlyReferences);
 }
 const rankMs=performance.now()-rankedAt;
 return {
   result:{conversationId:req.conversationId,messageId:prepared.messageId,clientActionId:req.clientActionId,ranking,
     ...(reviewSort?{reviewSortInfo:{aspect:plan.reviewSortAspect!,status:reviewSort.status,
       sampledReviewIds:reviewSort.sampledReviewIds,positiveCounts:Object.fromEntries(reviewSort.counts)}}:{}),
     shoppingPlan:{...plan,lastDisplayedProductIds:[...new Set([...ranking.ranked.map(x=>x.candidate.productId),...ranking.referenceOnly.map(x=>x.candidate.productId)])].slice(0,3)},trace:{...fetched.trace,memoryMs:prepared.memoryMs,
       intentMs:Math.max(0,retrievalStart-prepared.startedAt-prepared.memoryMs),
       retrievalMs,rankMs,totalMs:performance.now()-prepared.startedAt}},
   evidence:fetched.evidence
 };
}
/** Legacy independent research path remains for unit tests and adapter consumers. */
export async function researchTurn(req:Request,deps:ResearchDeps):Promise<ResearchResult>{
 const prepared=await prepareTurn(req,deps);
 const plan=await resolveTurnPlan(req,prepared,null,deps);
 return (await retrieveTurn(req,prepared,plan,deps)).result;
}
