/** Agent-owned intent proposal; the server remains owner of the canonical ShoppingPlan. */
import {parseShoppingIntent} from "./intent.ts";
import type {ShoppingIntent} from "./read-flow.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";

export const agentSearchSchema={
 type:"object",
 properties:{
  intent:{type:"object",additionalProperties:false,
   properties:{
    query:{type:"string",minLength:1,maxLength:200},
    maxTotalWon:{type:["integer","null"],minimum:0},
    requiredConditions:{type:"array",items:{type:"string",maxLength:80},maxItems:12},
    currentPreferences:{type:"object",additionalProperties:false,properties:{
     price_priority:{type:"string",enum:["value","balanced","performance"]},
     eye_comfort:{type:"string",enum:["important","normal"]},
     noise_sensitivity:{type:"string",enum:["important","normal"]}}},
    category:{type:"string",maxLength:80},
    attributePreferences:{type:"array",items:{type:"string"},maxItems:12},
    attributeSources:{type:"object",additionalProperties:{type:"string"}},
    queryMode:{type:"string",enum:["KEEP","SET"]},
    budgetMode:{type:"string",enum:["KEEP","SET","CLEAR"]},
    requirementsMode:{type:"string",enum:["KEEP","ADD","REPLACE","CLEAR"]},
    preferencesMode:{type:"string",enum:["MERGE","CLEAR"]}
   },required:["query","maxTotalWon","requiredConditions","currentPreferences","queryMode","budgetMode"]
  }
 },required:["intent"],additionalProperties:false
};
const gender=(s:string)=>/(남성|남자|맨즈)/.test(s)?"M":/(여성|여자|우먼)/.test(s)?"F":null;
/** Reject unauthorized removals and invented new hard constraints; existing plan is authoritative. */
export function parseAgentSearchIntent(raw:unknown,message:string,previous?:ShoppingPlan):ShoppingIntent|null{
 try{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const x=raw as Record<string,unknown>;
  if(Object.keys(x).length!==1||!("intent" in x)||!x.intent||typeof x.intent!=="object"||Array.isArray(x.intent))return null;
  const intent=parseShoppingIntent(JSON.stringify(x.intent));
  if(!intent.queryMode||!intent.budgetMode)return null;
  if(!previous&&intent.queryMode!=="SET")return null;
  const changed=intent.queryMode==="SET"&&(!previous||intent.query!==previous.query);
  // A model-proposed numeric ceiling must be explicitly present in this user's message
  // (or be the unchanged prior ceiling), never guessed from catalogue prices.
  if(intent.budgetMode==="SET"&&intent.context.maxTotalWon!==null&&
     intent.context.maxTotalWon!==previous?.maxTotalWon){
   const amounts=[...message.matchAll(/(\d+(?:,\d{3})*)\s*(만\s*원|원)/g)]
     .map(m=>Number(m[1].replaceAll(",",""))*(m[2].replace(/\s/g,"")==="만원"?10000:1));
   if(!amounts.includes(intent.context.maxTotalWon))return null;
  }
  if(previous&&!changed){
   if(intent.budgetMode==="CLEAR"&&previous.maxTotalWon!==null&&
      !/(예산|가격|금액).{0,15}(?:상관없|제한없|없애|취소|초기화|해제)/.test(message))return null;
   if(["CLEAR","REPLACE"].includes(intent.requirementsMode??"")&&
       previous.requiredConditions.some(c=>!intent.context.requiredConditions.includes(c))&&
       !/(?:조건|필수).{0,20}(?:해제|취소|빼|없애|상관없|제외)|(?:남성|남자|여성|여자).{0,10}(?:아닌|말고|제외)/.test(message))return null;
  }
  const stated=(s:string)=>message.includes(s)||(gender(s)!==null&&gender(message)===gender(s));
  const prior=new Set(changed?[]:previous?.requiredConditions??[]);
  if(intent.context.requiredConditions.some(s=>!stated(s)&&!prior.has(s)))return null;
  if(intent.context.attributePreferences?.length){
   const sources=intent.attributeSources??{};
   intent.context.attributePreferences=intent.context.attributePreferences.filter(k=>
    typeof sources[k]==="string"&&sources[k].length>=2&&message.includes(sources[k]));
  }
  if(intent.queryMode==="KEEP"&&previous&&intent.query!==previous.query)intent.query=previous.query;
  return intent;
 }catch{return null;}
}
