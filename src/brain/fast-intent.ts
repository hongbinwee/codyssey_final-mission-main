import type {IntentPort,ShoppingIntent} from "./read-flow.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";

/** Narrow syntax, not a category classifier. Anything uncertain uses the existing planner. */
function simpleIntent(message:string,previous?:ShoppingPlan):ShoppingIntent|null{
 const text=message.trim().replace(/^(?:안녕(?:하세요)?|하이)[,!?.\s]*/,"");
 const budgets=[...text.matchAll(/(\d+(?:,\d{3})*)\s*(만\s*원|원)\s*(이하|까지)/g)];
 if(budgets.length>1||/미만|초과|이상|부터|최소|배송비|제외|말고|아닌|반드시|필수/.test(text))return null;
 const budget=budgets[0]?Number(budgets[0][1].replaceAll(",",""))*(budgets[0][2].replace(/\s/g,"")==="만원"?10000:1):null;
 if(budget!==null&&!Number.isSafeInteger(budget))return null;
 let rest=text.replace(budgets[0]?.[0]??/a^/,"").trim();
 const followup=!!previous&&/^(?:그럼|그러면|예산|더 저렴)/.test(rest);
 const prefs:ShoppingIntent["context"]["currentPreferences"]={};
 if(/가성비|더 저렴|가격 우선/.test(rest))prefs.price_priority="value";
 rest=rest.replace(/^(?:그럼|그러면)\s*/,"").replace(/예산은?|가성비|더 저렴한?\s*(?:걸로)?|가격 우선/g,"")
   .replace(/(?:추천해\s*줘|추천해주세요|추천해|추천|찾아\s*줘|찾아주세요|찾아|검색해\s*줘|검색해|검색)[.!?\s]*$/,"").trim()
   .replace(/^그냥\s+(?=\S)/,"");
 if(followup&&/^(?:으로|로)?$/.test(rest))return {query:previous!.query,queryMode:"KEEP",budgetMode:budget===null?"KEEP":"SET",
   requirementsMode:"KEEP",context:{maxTotalWon:budget,requiredConditions:[],currentPreferences:prefs}};
 // A single noun or a plain two-word product name can be handled without a
 // model. Explicit condition modifiers stay on the planner path so they are
 // not silently swallowed into the query.
 const singleProduct=/^[\p{L}\p{N}-]{2,40}$/u.test(rest);
 const twoWordProduct=/^[\p{L}\p{N}-]{2,24}\s+[\p{L}\p{N}-]{2,24}$/u.test(rest)&&
   !/^(?:무선|블루투스|방수|방진|저소음|저자극|통화용|운동용|개발용|선물용|여행용|친환경|가성비|저렴한?)\s/u.test(rest)&&
   !/^[^\s]+용\s/u.test(rest);
 if((!singleProduct&&!twoWordProduct)||!/추천|찾아|검색/.test(text))return null;
 const same=previous?.query===rest;
 return {query:rest,queryMode:same?"KEEP":"SET",budgetMode:budget===null?(same?"KEEP":"CLEAR"):"SET",requirementsMode:same?"KEEP":"REPLACE",
   context:{maxTotalWon:budget,requiredConditions:[],currentPreferences:prefs}};
}
export function createFastIntentPort(fallback:IntentPort):IntentPort{
 return {async extract(message,memory,previous){
   const fast=simpleIntent(message,previous);if(fast)return fast;
   const intent=await fallback.extract(message,memory,previous);
   // Model defaults are not the user's stated intent. Confirmed memories are applied separately.
   const current={...intent.context.currentPreferences};
   const price=/가성비|저렴|가격.{0,5}(?:중요|우선|선호)/.test(message)?"value":/성능.{0,5}(?:중요|우선|선호)/.test(message)?"performance":/균형/.test(message)?"balanced":undefined;
   if(price)current.price_priority=price;else delete current.price_priority;
   if(!/눈.{0,5}(?:피로|편|보호)|시력/.test(message))delete current.eye_comfort;
   if(!/소음|조용|시끄/.test(message))delete current.noise_sensitivity;
   return {...intent,context:{...intent.context,currentPreferences:current,
     ...(intent.context.attributePreferences?{attributePreferences:intent.context.attributePreferences.filter(key=>{
       const source=intent.attributeSources?.[key];
       return message.toLowerCase().includes(key)||!!source&&source.length>=4&&message.includes(source)&&
         (/중요|우선|선호|맞는|적합|좋겠|원해|원하|편한/.test(source)||
          /(?:안\s*차|않|덜|적게|가벼|시원|잘\s*되는|부드러)/.test(source));

     })}:{})}};
 }};
}
