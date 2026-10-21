import type {Preference,PreferenceKey,PreferenceValue} from "./contracts.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import {assertPreference} from "./memory.ts";
import {selectShoppingSkill,type SkillId} from "./skills.ts";
import type {DialogueContext} from "./dialogue-context.ts";

export interface IntentContext {
 trustedSkillId:SkillId;
 trustedSkillInstruction:string;
 untrustedUserContent:string
}
/**
 * Stable system policy is supplied by the caller.
 * Previous plan, memory and current user text are DATA (user-level context).
 * Memory cannot silently turn into an explicit current turn preference.
 */
export function assembleIntentContext(userMessage:string,memories:Preference[],previous?:ShoppingPlan,dialogue?:DialogueContext):IntentContext{
 if(typeof userMessage!=="string"||!userMessage.trim()||userMessage.length>3000)
   throw new Error("invalid user intent text");
 const latestSkill=selectShoppingSkill(userMessage);
 // A clearly named new category beats a stale previous category; generic follow-ups reuse the previous skill.
 const selected=latestSkill.id!=="general"?latestSkill:selectShoppingSkill(previous?.query??userMessage);
 const latest=new Map<PreferenceKey,{value:PreferenceValue;updatedAt:string}>();
 for(const m of [...memories].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt))){
   assertPreference(m.key,m.value);
   latest.set(m.key,{value:m.value,updatedAt:m.updatedAt});
 }
 const remembered=[...latest].map(([key,record])=>({key,value:record.value})).slice(0,3);
 const context=previous?{
   query:previous.query,maxTotalWon:previous.maxTotalWon,
   ...(previous.minTotalWon!==undefined?{minTotalWon:previous.minTotalWon}:{}),
   ...(previous.reviewSort?{reviewSort:previous.reviewSort}:{}),
   requiredConditions:previous.requiredConditions,currentPreferences:previous.currentPreferences,
   ...(previous.interview?.purpose?{userStatedPurpose:previous.interview.purpose}:{}),
   ...(previous.category?{category:previous.category,attributePreferences:previous.attributePreferences??[]}:{})
 }:null;
 return {
   trustedSkillId:selected.id,
   trustedSkillInstruction:selected.guidance,
   // One encoded document prevents user-supplied strings from forging
   // delimiter sections (e.g. [/latest_user_message] + fake plan).
   // This remains lower-trust model INPUT, never system instructions.
   untrustedUserContent:JSON.stringify({
     untrusted_previous_shopping_plan:context,
     untrusted_confirmed_long_term_preferences:remembered,
     ...(dialogue?{untrusted_dialogue_context:dialogue}:{}),
     latest_user_message:userMessage
   })
 };
}
