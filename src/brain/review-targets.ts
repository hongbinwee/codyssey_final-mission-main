/** The exact displayed recommendation is task-local context, never an LLM-owned ID list. */
import {MAX_DISPLAY_PRODUCTS,type RankingResult} from "./contracts.ts";
import type {GroundedExplanation} from "./grounded-response.ts";
export interface DisplayedReviewTarget {
 displayIndex:number;productId:string;variantId:string;name:string;commerceVerified:boolean;
}
/** Match BrainRanking's visible order, including model fallback and reference cards. */
export function captureDisplayedReviewTargets(ranking:RankingResult,explanation?:GroundedExplanation):DisplayedReviewTarget[]{
 const seen=new Set<string>(),result:DisplayedReviewTarget[]=[];
 const unavailable=explanation?.failure?.code==="RETRIEVAL_UNAVAILABLE";
 const fallback=!!explanation?.failure&&!unavailable;
 const ranked=ranking.ranked.filter(row=>row.candidate.commerceVerified===true&&
   (!explanation||fallback||explanation.items.some(item=>item.productId===row.candidate.productId&&
     (!item.variantId||item.variantId===row.candidate.variantId))));
 const references=unavailable?[]:ranking.referenceOnly;
 for(const row of [...ranked,...references]){
   const candidate=row.candidate;
   if(!candidate.productId||!candidate.variantId||seen.has(candidate.productId))continue;
   seen.add(candidate.productId);
   result.push({displayIndex:result.length+1,productId:candidate.productId,variantId:candidate.variantId,
     name:candidate.productName??"상품",commerceVerified:candidate.commerceVerified===true});
   if(result.length===MAX_DISPLAY_PRODUCTS)break;
 }
 return result;
}
/** No fallback to arbitrary RAG candidates, names, or an unverified historical ID. */
export function resolveDisplayedReviewTargets(
 rows:readonly DisplayedReviewTarget[]|undefined,indexes:readonly number[]|undefined,
 all:boolean
):DisplayedReviewTarget[]|null{
 if(!Array.isArray(rows)||!rows.length||rows.length>MAX_DISPLAY_PRODUCTS)return null;
 const valid=rows.every((row,i)=>row&&row.displayIndex===i+1&&
   typeof row.productId==="string"&&row.productId.length>0&&row.productId.length<=160&&
   typeof row.variantId==="string"&&row.variantId.length>0&&row.variantId.length<=160&&
   typeof row.name==="string"&&row.name.length>0&&row.name.length<=200&&
   row.commerceVerified===true);
 if(!valid||new Set(rows.map(row=>row.productId)).size!==rows.length)return null;
 if(all)return [...rows];
 if(!indexes?.length||indexes.length>MAX_DISPLAY_PRODUCTS||
   new Set(indexes).size!==indexes.length||indexes.some(i=>!Number.isSafeInteger(i)||i<1||i>rows.length))return null;
 return indexes.map(i=>rows[i-1]!);
}
