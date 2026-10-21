/** Bounded, actor-scoped Agent context. The model sees data, never authorization. */
import type {Preference} from "./contracts.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import type {AgentTaskState} from "./task-state.ts";
import type {AgentObservation} from "./hermes-agent-step.ts";
import {resolveDisplayedReviewTargets,type DisplayedReviewTarget} from "./review-targets.ts";
import {agentPromptObservations} from "./hermes-observation-prompt.ts";

export type RecentAgentTurn={userMessage:string;assistantSummary:string};
const clip=(value:string,max:number)=>value.replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max);

/** Consistent user/task/tool context for every decision in one conversation turn. */
export function buildAgentDecisionContext(input:{
 message:string;plan?:ShoppingPlan;task:AgentTaskState|null;memories:Preference[];
 observations:AgentObservation[];recentTurns?:readonly RecentAgentTurn[];
 displayedProducts?:readonly DisplayedReviewTarget[];
}){
 const plan=input.plan;
 const verifiedDisplayed=resolveDisplayedReviewTargets(input.displayedProducts,undefined,true)??[];
 return {
  user_message:input.message.slice(0,1200),
  ...(plan?{current_shopping_plan:{
   query:plan.query,maxTotalWon:plan.maxTotalWon,
   ...(plan.minTotalWon!==undefined?{minTotalWon:plan.minTotalWon}:{}),
   budgetStatus:plan.interview?.budgetStatus??(plan.maxTotalWon!==null?"SET":"UNKNOWN"),
   category:plan.category??null,requiredConditions:plan.requiredConditions.slice(0,12),
   currentPreferences:plan.currentPreferences,
   attributePreferences:(plan.attributePreferences??[]).slice(0,12),
   purpose:plan.interview?.purpose??null,
   priceSortOrder:plan.priceSortOrder??null,reviewSortAspect:plan.reviewSortAspect??null,
   excludedProductIds:(plan.excludedProductIds??[]).slice(0,20)
  }}:{}),
  previous_task:input.task?{
   kind:input.task.kind,phase:input.task.phase,pendingQuestion:input.task.pendingQuestion,
   displayedProductIds:input.task.displayedProductIds.slice(0,8),
   selectedProductId:input.task.selectedProductId??null
  }:null,
  previous_displayed_products:verifiedDisplayed.map(p=>({
   displayIndex:p.displayIndex,productId:p.productId,variantId:p.variantId,name:clip(p.name,160)
  })),
  recent_turns:(input.recentTurns??[]).slice(-4).filter(t=>t.userMessage.trim()).map(t=>({
   user:clip(t.userMessage,280),assistant:clip(t.assistantSummary,320)
  })),
  confirmed_preferences:input.memories.slice(0,3).map(m=>({key:m.key,value:m.value})),
  observed_tools:agentPromptObservations(input.observations),
  remaining_calls:5-input.observations.length
 };
}
