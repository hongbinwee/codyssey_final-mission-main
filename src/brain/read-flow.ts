import type {BrainTrace,EvidenceRecord,MemoryRepository,Preference,RankingResult,RetrieverPort} from "./contracts.ts";
import type {PersistentConversations} from "./persistent-store.ts";
import {rankProducts} from "./personalization.ts";
import type {PlanExtraction,ShoppingPlan} from "./shopping-plan.ts";
import {resolveShoppingPlan} from "./shopping-plan.ts";
import type {GroundedExplanation} from "./grounded-response.ts";

export type ShoppingIntent=PlanExtraction;
export interface IntentPort {
 extract(userMessage:string,knownPreferences:Preference[],previous?:ShoppingPlan):Promise<ShoppingIntent>
}
export interface ResearchResult {
 conversationId:string;messageId:string;clientActionId?:string;ranking:RankingResult;
 shoppingPlan?:ShoppingPlan;
 explanation?:GroundedExplanation;
 trace:{memoryMs:number;intentMs:number;retrievalMs:number;rankMs:number;totalMs:number}
}
export interface ResearchDeps {
 conversations:Pick<PersistentConversations,"assertOwned"|"appendUserMessage">;
 memory:MemoryRepository;retriever:RetrieverPort;intent:IntentPort;
}
export interface PreparedTurn {
 messageId:string;memories:Preference[];startedAt:number;memoryMs:number
}
export interface RetrievedTurn {
 result:ResearchResult;evidence:EvidenceRecord[]
}
type Request=BrainTrace & {userMessage:string;clientActionId:string};
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
 const intent=await deps.intent.extract(req.userMessage,prepared.memories,previous??undefined);
 const plan=resolveShoppingPlan(previous,intent);
 if(!plan.query||plan.query.length>200)throw new Error("invalid shopping plan");
 return plan;
}
export async function retrieveTurn(req:Request,prepared:PreparedTurn,plan:ShoppingPlan,deps:ResearchDeps):Promise<RetrievedTurn>{
 const retrievalStart=performance.now();
 const fetched=await deps.retriever.search({query:plan.query,maxTotalWon:plan.maxTotalWon,
   requiredConditions:plan.requiredConditions});
 if(!fetched||!Array.isArray(fetched.candidates)||!Array.isArray(fetched.evidence)||
    fetched.candidates.length>100||fetched.evidence.length>2500)throw new Error("invalid retrieval result");
 const retrievalMs=performance.now()-retrievalStart;
 const rankedAt=performance.now();
 const ranking=rankProducts(fetched.candidates,fetched.evidence,plan,prepared.memories);
 const rankMs=performance.now()-rankedAt;
 return {
   result:{conversationId:req.conversationId,messageId:prepared.messageId,clientActionId:req.clientActionId,ranking,
     shoppingPlan:plan,trace:{memoryMs:prepared.memoryMs,
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
