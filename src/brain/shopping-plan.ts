import type {InterviewState} from './interview.ts';
import type {DisplayedReviewTarget} from './review-targets.ts';
import type {PreferenceKey,PreferenceValue,ShoppingContext} from "./contracts.ts";

/** Task-local context, separate from confirmed cross-session user memories. */
export interface ShoppingPlan extends ShoppingContext { query:string; revision:number;interview?:InterviewState; excludedProductIds?:string[];lastDisplayedProductIds?:string[];lastDisplayedProducts?:DisplayedReviewTarget[];reviewSortAspect?:string;priceSortOrder?:"ASC"|"DESC" }
export interface PlanOperations {
  queryMode?:"KEEP"|"SET";
  budgetMode?:"KEEP"|"SET"|"CLEAR";
  requirementsMode?:"KEEP"|"ADD"|"REPLACE"|"CLEAR";
  preferencesMode?:"MERGE"|"CLEAR";
}
export interface PlanExtraction extends PlanOperations {
  query:string;
  context:ShoppingContext;
}
const validBudget=(n:number|null)=>n===null||(Number.isSafeInteger(n)&&n>=0);
const keys=new Set<PreferenceKey>(["price_priority","eye_comfort","noise_sensitivity"]);
const values:Record<PreferenceKey,readonly PreferenceValue[]>={
  price_priority:["value","balanced","performance"],eye_comfort:["important","normal"],noise_sensitivity:["important","normal"]
};
function validateContext(extracted:PlanExtraction):void{
  const c=extracted.context;
  if(!c||!validBudget(c.maxTotalWon)||(c.minTotalWon!==undefined&&(!Number.isSafeInteger(c.minTotalWon)||c.minTotalWon<0||c.maxTotalWon!==null&&c.minTotalWon>c.maxTotalWon))||!Array.isArray(c.requiredConditions)||
     c.requiredConditions.length>12||c.requiredConditions.some(x=>typeof x!=="string"||!x.trim()||x.length>80)||
     !c.currentPreferences||typeof c.currentPreferences!=="object"||Array.isArray(c.currentPreferences))
     throw new Error("invalid shopping plan context");
  if(typeof extracted.query!=="string"||!extracted.query.trim()||extracted.query.length>200)
     throw new Error("invalid shopping plan query");
  for(const [k,v] of Object.entries(c.currentPreferences)){
    if(!keys.has(k as PreferenceKey)||!values[k as PreferenceKey].includes(v as PreferenceValue))
      throw new Error("invalid shopping plan preference");
  }
  if(c.category!==undefined&&!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(c.category))throw Error("invalid shopping category");
  if(c.attributePreferences!==undefined&&(!c.category||!Array.isArray(c.attributePreferences)||c.attributePreferences.length>12||
    c.attributePreferences.some(k=>typeof k!=="string"||!/^(?!cost$)[a-z][a-z0-9_]{0,79}$/.test(k))))throw Error("invalid shopping attributes");
}
/**
 * Only explicit mode CLEAR clears a saved constraint. Older single-turn
 * extractors without operation modes default to KEEP, preserving compatibility.
 * A new product/category task must use queryMode SET + budgetMode CLEAR when needed.
 */
export function resolveShoppingPlan(previous:ShoppingPlan|null|undefined,extracted:PlanExtraction):ShoppingPlan {
  validateContext(extracted);
  const now=extracted.context;
  if(!previous){
    if(extracted.budgetMode==="SET"&&now.maxTotalWon===null)throw new Error("SET budget missing");
    return {query:extracted.query.trim(),maxTotalWon:extracted.budgetMode==="CLEAR"?null:now.maxTotalWon,
      requiredConditions:extracted.requirementsMode==="CLEAR"?[]:[...new Set(now.requiredConditions)],
      ...(now.minTotalWon!==undefined?{minTotalWon:now.minTotalWon}:{}),
      currentPreferences:extracted.preferencesMode==="CLEAR"?{}:{...now.currentPreferences},revision:1,
      ...(now.category?{category:now.category,attributePreferences:extracted.preferencesMode==="CLEAR"?[]:[...new Set(now.attributePreferences??[])]}:{})};
  }
  if(extracted.queryMode==="SET"&&extracted.budgetMode===undefined)
    throw new Error("new task must explicitly decide budget retention");
  const categoryChanged=!!now.category&&!!previous.category&&now.category!==previous.category;
  const newTask=extracted.queryMode==="SET"||categoryChanged;
  const query=extracted.queryMode==="KEEP"||(!extracted.queryMode&&previous.query===extracted.query)
    ? previous.query : extracted.query.trim();
  const budget=extracted.budgetMode==="CLEAR"?null
    :extracted.budgetMode==="SET"||(!extracted.budgetMode&&now.maxTotalWon!==null)
      ? now.maxTotalWon
      : previous.maxTotalWon;
  if(!validBudget(budget)||(extracted.budgetMode==="SET"&&budget===null))
    throw new Error("invalid resolved budget");
  const mode=extracted.requirementsMode??(now.requiredConditions.length?"ADD":"KEEP");
  // A category switch must NEVER leak previous-category hard requirements.
  // Mode ADD on a new task applies only to the new task's requirements.
  const requirements=mode==="CLEAR"?[]
    :mode==="REPLACE"?now.requiredConditions
    :mode==="ADD"?(newTask?now.requiredConditions:[...previous.requiredConditions,...now.requiredConditions])
    :newTask?[]:previous.requiredConditions;
  const prefs=extracted.preferencesMode==="CLEAR"||newTask?{}:{...previous.currentPreferences};
  if(extracted.preferencesMode!=="CLEAR")Object.assign(prefs,now.currentPreferences);
  const category=now.category??(newTask?undefined:previous.category);
  const attributes=extracted.preferencesMode==="CLEAR"?[]:now.attributePreferences??(newTask?[]:previous.attributePreferences??[]);
  const minTotalWon=extracted.budgetMode==="CLEAR"?undefined
    :extracted.budgetMode==="SET"?now.minTotalWon
    :newTask?now.minTotalWon:now.minTotalWon??previous.minTotalWon;
  return {query,maxTotalWon:budget,...(minTotalWon!==undefined?{minTotalWon}:{}),
    ...(!newTask?{interview:previous.interview,excludedProductIds:previous.excludedProductIds,lastDisplayedProductIds:previous.lastDisplayedProductIds,lastDisplayedProducts:previous.lastDisplayedProducts}:{}),requiredConditions:[...new Set(requirements)].slice(0,12),
    currentPreferences:prefs,revision:previous.revision+1,
    ...(category?{category,attributePreferences:[...new Set(attributes)]}:{})};
}
