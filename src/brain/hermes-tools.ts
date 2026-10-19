/** Hermes-style bounded read-only Tool Calling. All commerce mutations remain UI-only. */
import type {Provider,ChatMsg} from "../llm.ts";
import type {PurchaseSnapshot} from "./purchase-history.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import type {Preference} from "./contracts.ts";
import {SHOPPING_POLICY} from "./policy.ts";
import {selectShoppingSkill} from "./skills.ts";

export const HERMES_TOOL_LIMIT=3;
export type HermesToolName="get_purchase_history"|"search_products";
export interface HermesToolPort {
 purchases:()=>Promise<PurchaseSnapshot[]>;
 search:()=>Promise<{products:Array<{productId:string;variantId:string;totalPriceWon:number;reviewCount:number|null}>}>;
}
export type HermesLoopResult={calls:HermesToolName[];searched:boolean;purchases:PurchaseSnapshot[];answer:string|null};
const defs=[{
 type:"function",function:{name:"get_purchase_history",description:"Read the signed-in user's own historical simulated purchases to compare price and product type.",
 parameters:{type:"object",properties:{},additionalProperties:false}
}},{
 type:"function",function:{name:"search_products",description:"Search and validate products using the server-owned current Shopping Plan. Never change budget or conditions.",
 parameters:{type:"object",properties:{},additionalProperties:false}
}}];

/** Bounded tool-choice loop; the final recommendation still comes from verified server ranking. */
export async function runHermesReadLoop(
 provider:Pick<Provider,"chat">,message:string,plan:ShoppingPlan,memories:Preference[],tools:HermesToolPort,
):Promise<HermesLoopResult>{
 const skill=selectShoppingSkill(plan.query);
 const system=SHOPPING_POLICY+"\n[Hermes read tools]\nYou may use only the two provided read tools. "+
  "Use purchase history when the user refers to previous purchases. Use product search when comparing or recommending. "+
  "Do not claim you placed an order. After tool results, finish without additional tools if the available evidence is sufficient. "+
  "Product recommendations, rankings, numbers and citations are generated only by the server, not by your message. "+
  "No arbitrary JSON arguments; tools use the authenticated server actor and saved Shopping Plan.\n"+
  "[Skill]\n"+skill.guidance;
 const context=JSON.stringify({latest_user_message:message,previous_shopping_plan:plan,
  confirmed_preferences:memories.map(m=>({key:m.key,value:m.value})).slice(0,3)});
 const messages:ChatMsg[]=[{role:"system",content:system},{role:"user",content:context}];
 const calls:HermesToolName[]=[];
 let purchases:PurchaseSnapshot[]=[],searched=false,answer:string|null=null;
 const used=new Set<HermesToolName>();
 for(let turn=0;turn<=HERMES_TOOL_LIMIT;turn++){
  const resp=await provider.chat(messages,defs,{signal:AbortSignal.timeout(20000)});
  const selected=resp.tool_calls??[];
  if(!selected.length){answer=resp.content;break;}
  if(turn===HERMES_TOOL_LIMIT)break;
  // One read at a time; preventing parallel or repeated dispatch bounds latency.
  const call=selected[0],name=call.name as HermesToolName;
  if(!["get_purchase_history","search_products"].includes(name)||used.has(name)||
     !/^\s*\{\s*\}\s*$/.test(call.arguments))break;
  used.add(name);calls.push(name);
  messages.push({role:"assistant",content:resp.content,tool_calls:resp.tool_calls,
   responses_output:resp.responses_output,anthropic_content:resp.anthropic_content});
  let output:unknown;
  if(name==="get_purchase_history"){
   purchases=await tools.purchases();
   output={purchases:purchases.slice(0,20)};
  }else{
   const result=await tools.search();
   searched=true;
   output={validated_candidates:result.products.slice(0,3)};
  }
  messages.push({role:"tool",tool_call_id:call.id,name,content:JSON.stringify(output)});
  // If the model emitted multiple calls, stop instead of sending an incomplete tool batch.
  if(selected.length>1)break;
 }
 return {calls,searched,purchases,answer};
}
