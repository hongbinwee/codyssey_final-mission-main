import {interviewAnswer} from './interview.ts';
import type {ConversationResponder} from "./conversation-response.ts";
import type {BrainTrace,EvidenceRecord,MemoryRepository,Preference,RankingResult,RetrieverPort,ReviewSummaryRequest} from "./contracts.ts";
import type {PersistentConversations} from "./persistent-store.ts";
import {rankProducts} from "./personalization.ts";
import {curateRecommendations,type CommerceActivity} from "./recommendation-strategies.ts";
import type {PlanExtraction,ShoppingPlan} from "./shopping-plan.ts";
import {resolveShoppingPlan} from "./shopping-plan.ts";
import {parseKrwTenThousandBand} from "./price-band.ts";
import {parseExplicitReviewSort,reviewSortAspectLabel,normalizeReviewSortAspect} from "./review-sort.ts";
import type {GroundedExplanation} from "./grounded-response.ts";
import type {BrainRoute,BrainIntentKind} from "./routing.ts";

export type ShoppingIntent=PlanExtraction & {attributeSources?:Record<string,string>};
export interface IntentPort {
 extract(userMessage:string,knownPreferences:Preference[],previous?:ShoppingPlan):Promise<ShoppingIntent>
}
export interface ResearchResult {
 datasetVersion?:string;
 conversationId:string;messageId:string;clientActionId?:string;ranking:RankingResult;
 shoppingPlan?:ShoppingPlan;
 explanation?:GroundedExplanation;
 intentKind?:BrainIntentKind;
 trace:{memoryMs:number;intentMs:number;retrievalMs:number;rankMs:number;totalMs:number;[key:string]:number}
}
export interface ResearchDeps {
 reviewSummary?:(input:{request:ReviewSummaryRequest;previous?:ResearchResult})=>Promise<GroundedExplanation>;
 clarifyBeforeSearch?:boolean;
 datasetVersion?:string;
 conversations:Pick<PersistentConversations,"assertOwned"|"appendUserMessage">;
 memory:MemoryRepository;retriever:RetrieverPort;intent:IntentPort;
 route?:(message:string,previous?:ShoppingPlan)=>BrainRoute|Promise<BrainRoute>;
 converse?:ConversationResponder;
 activity?:(actorUserId:string)=>Promise<CommerceActivity>;
 fastResponses?:boolean;
}
export interface PreparedTurn {
 messageId:string;memories:Preference[];startedAt:number;memoryMs:number
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
 return {messageId,memories,startedAt:t0,memoryMs:performance.now()-t0};
}
export async function resolveTurnPlan(req:Request,prepared:PreparedTurn,previous:ShoppingPlan|null|undefined,deps:ResearchDeps):Promise<ShoppingPlan>{
 const trimmed=req.userMessage.trim();
 if(deps.clarifyBeforeSearch){const answered=interviewAnswer(trimmed,previous??undefined);if(answered)return answered;}
 const last=previous?.lastDisplayedProductIds??[];
 const excludeOne=last.find(id=>trimmed===`이 상품 제외: ${id}`);
 const excludeAll=trimmed==="다른 상품 보기"||trimmed==="다른 제품 보기"||trimmed==="추천 상품 전부 제외";
 if(previous&&(excludeOne||excludeAll)){
   const extra=excludeAll?last:[excludeOne!];
   return {...previous,excludedProductIds:[...new Set([...(previous.excludedProductIds??[]),...extra])].slice(0,100),revision:previous.revision+1};
 }
 const intent=await deps.intent.extract(req.userMessage,prepared.memories,previous??undefined);
 let plan=resolveShoppingPlan(previous,intent);
 const explicitBand=parseKrwTenThousandBand(req.userMessage);
 if(explicitBand)plan={...plan,...explicitBand};
 else if(intent.budgetMode==="SET"&&intent.context.minTotalWon===undefined)plan={...plan,minTotalWon:undefined};
 const explicitSort=parseExplicitReviewSort(req.userMessage);
 const clearSort=/(?:정렬|순서)\s*(?:취소|초기화|상관없)|(?:가격|저렴한|낮은\s*가격|높은\s*가격|평점|별점)\s*(?:이\s*)?(?:낮은|높은)?\s*순|리뷰\s*(?:적은|부정.*많은)\s*순/.test(trimmed);
 const sameTask=previous?.query===plan.query&&previous?.category===plan.category;
 // Only this turn's explicit instruction sets the review order. A model or
 // remembered price preference cannot silently replace that ordering.
 const reviewSort=explicitSort??(!clearSort?intent.context.reviewSort??(sameTask?previous?.reviewSort:undefined):undefined);
 plan={...plan,reviewSort:clearSort||!reviewSort?undefined:
   {...reviewSort,aspect:normalizeReviewSortAspect(reviewSort.aspect)??reviewSort.aspect}};
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
   ...(plan.attributePreferences??[]),...(plan.interview?.purpose?[plan.interview.purpose]:[]),
   ...(plan.reviewSort?[`${reviewSortAspectLabel(plan.reviewSort.aspect)} 긍정 리뷰`]:[])])].slice(0,20);
 let fetched:Awaited<ReturnType<RetrieverPort['search']>>;
 try{fetched=await deps.retriever.search({query:[plan.query,plan.interview?.purpose].filter(Boolean).join(" ").slice(0,250),maxTotalWon:plan.maxTotalWon,
   ...(plan.minTotalWon!==undefined?{minTotalWon:plan.minTotalWon}:{}),...(plan.reviewSort?{reviewSort:plan.reviewSort}:{}),
   requiredConditions:plan.requiredConditions,preferences:searchPreferences,requestId:req.requestId,originalQuestion:req.userMessage,
   ...(plan.category?{category:plan.category}:{})});}catch{throw new RetrievalUnavailableError();}
 if(!fetched||!Array.isArray(fetched.candidates)||!Array.isArray(fetched.evidence)||
    fetched.candidates.length>100||fetched.evidence.length>2500)throw new Error("invalid retrieval result");
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
 const activity=deps.activity&&!plan.reviewSort?await deps.activity(req.actorUserId):undefined;
 const ranking=deps.activity&&!plan.reviewSort?curateRecommendations(baseRanking,activity):baseRanking;
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
