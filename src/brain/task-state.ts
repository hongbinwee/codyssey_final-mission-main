/**
 * H2: server-issued task identity/state. A task is context, never authority to
 * fetch another actor's records or perform a Commerce mutation.
 */
export type AgentTaskKind="WISHLIST"|"CART"|"DISCOVERY"|"REVIEW_COMPARE"|"REVIEW_SUMMARY"|"ORDER";
export type AgentTaskPhase="ACTIVE"|"AWAITING_INPUT"|"UNAVAILABLE";
export type PendingTaskQuestion="budget"|"purpose"|"product_type"|"agent_followup";
export interface TaskScope {actorUserId:string;conversationId:string;datasetVersion?:string}
export interface AgentTaskState extends TaskScope {
 schemaVersion:1;kind:AgentTaskKind;phase:AgentTaskPhase;revision:number;
 displayedProductIds:string[];selectedProductId?:string;
 pendingQuestion?:PendingTaskQuestion;
}
const kinds=new Set<AgentTaskKind>(["WISHLIST","CART","DISCOVERY","REVIEW_COMPARE","REVIEW_SUMMARY","ORDER"]);
const phases=new Set<AgentTaskPhase>(["ACTIVE","AWAITING_INPUT","UNAVAILABLE"]);
const questions=new Set<PendingTaskQuestion>(["budget","purpose","product_type","agent_followup"]);
const identifier=(x:unknown):x is string=>typeof x==="string"&&x.length>0&&x.length<=256&&!/[\u0000-\u001f]/.test(x);
/** Only a previously published, matching conversation's task can be reused. */
export function ownedTask(raw:unknown,scope:TaskScope):AgentTaskState|null{
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||!identifier(scope.actorUserId)||!identifier(scope.conversationId))return null;
 const t=raw as Partial<AgentTaskState>;
 if(t.schemaVersion!==1||t.actorUserId!==scope.actorUserId||t.conversationId!==scope.conversationId||
   t.datasetVersion!==scope.datasetVersion||!kinds.has(t.kind as AgentTaskKind)||
   !phases.has(t.phase as AgentTaskPhase)||typeof t.revision!=="number"||!Number.isSafeInteger(t.revision)||t.revision<=0||
   !Array.isArray(t.displayedProductIds)||t.displayedProductIds.length>20||
   t.displayedProductIds.some(x=>!identifier(x))||new Set(t.displayedProductIds).size!==t.displayedProductIds.length||
   t.selectedProductId!==undefined&&(!identifier(t.selectedProductId)||!t.displayedProductIds.includes(t.selectedProductId))||
   t.pendingQuestion!==undefined&&!questions.has(t.pendingQuestion))return null;
 if(t.phase==="AWAITING_INPUT"&&!t.pendingQuestion)return null;
 if(t.phase!=="AWAITING_INPUT"&&t.pendingQuestion!==undefined)return null;
 return {...t,displayedProductIds:[...t.displayedProductIds]} as AgentTaskState;
}
export function nextTask(
 scope:TaskScope,kind:AgentTaskKind,previous:AgentTaskState|null,options:{
  phase?:AgentTaskPhase;displayedProductIds?:readonly string[];
  selectedProductId?:string;pendingQuestion?:PendingTaskQuestion;
 }={}
):AgentTaskState{
 if(!identifier(scope.actorUserId)||!identifier(scope.conversationId)||!kinds.has(kind))throw Error("invalid task scope");
 const validPrevious=ownedTask(previous,scope);
 const ids=[...new Set((options.displayedProductIds??[]).filter(identifier))].slice(0,20);
 const phase=options.phase??"ACTIVE";
 const pendingQuestion=phase==="AWAITING_INPUT"&&options.pendingQuestion&&questions.has(options.pendingQuestion)?options.pendingQuestion:undefined;
 if(phase==="AWAITING_INPUT"&&!pendingQuestion)throw Error("missing task question");
 return {schemaVersion:1,...scope,kind,phase,revision:(validPrevious?.revision??0)+1,displayedProductIds:ids,
  ...(options.selectedProductId&&ids.includes(options.selectedProductId)?{selectedProductId:options.selectedProductId}:{}),
  ...(pendingQuestion?{pendingQuestion}:{})};
}
/** Preserve a current task through social interruptions, not through a different shopping task. */
export function retainTask(raw:unknown,scope:TaskScope):AgentTaskState|undefined{
 return ownedTask(raw,scope)??undefined;
}
export function taskForWishlistSelection(task:AgentTaskState|null):{kind:"WISHLIST";items:{productId:string}[]}|undefined{
 return task?.kind==="WISHLIST"&&task.phase==="ACTIVE"?
  {kind:"WISHLIST",items:task.displayedProductIds.map(productId=>({productId}))}:undefined;
}

/** Explicitly resets only the current shopping task, never account memory or orders. */
export function resetTaskRequested(message:string):boolean{
 const text=message.trim().replace(/[.!?~]+$/,"").trim();
 return /^(?:처음부터(?:\s*다시)?\s*시작(?:해\s*줘|할게|하자)?|(?:쇼핑|검색|추천)(?:을|은)?\s*(?:처음부터|새로)\s*시작(?:해\s*줘|하자)?|새\s*(?:쇼핑|검색)\s*시작(?:해\s*줘|하자)?)$/.test(text);
}
