import type {RankedCandidate,RankingResult} from "./contracts.ts";

/** Explicitly owned Commerce activity. An item in a cart/wishlist is strong *interest*,
 * not a purchase, quality guarantee, or a hard condition. */
export interface CommerceActivity {
 wishlistProductIds: string[];
 cartProductIds: string[];
 purchasedProductIds?: string[];
}
export type RecommendationRole="PERSONALIZED"|"REVIEW_VERIFIED"|"ALTERNATIVE";
export interface LabeledCandidate extends RankedCandidate {
 recommendationRole?:RecommendationRole;
 personalizationSignals?:Array<"CART"|"WISHLIST"|"PURCHASE">;
}
function signalsFor(id:string,activity:CommerceActivity):NonNullable<LabeledCandidate["personalizationSignals"]>{
 const signals:NonNullable<LabeledCandidate["personalizationSignals"]>=[];
 if(activity.cartProductIds.includes(id))signals.push("CART");
 if(activity.wishlistProductIds.includes(id))signals.push("WISHLIST");
 if(activity.purchasedProductIds?.includes(id))signals.push("PURCHASE");
 return signals;
}
export function meetsV07ReviewBar(row:RankedCandidate):boolean {
 const c=row.candidate;
 return c.ratingScale===5&&typeof c.rating==="number"&&Number.isFinite(c.rating)&&c.rating>3.5&&c.rating<=5&&
  c.wholeReviewCountVerified===true&&c.wholeReviewCount!==null&&Number.isSafeInteger(c.wholeReviewCount)&&c.wholeReviewCount>=10;
}
/** One validated retrieval, two deterministic rankings, one grounded response.
 * All candidates have already passed Commerce/budget/hard-condition/evidence gates.
 * Missing whole-population counts never qualify for the v0.7 slot. */
export function curateRecommendations(ranking:RankingResult,activity:CommerceActivity={wishlistProductIds:[],cartProductIds:[]}):RankingResult{
 const scored=ranking.ranked.map((row,index)=>{
  const signals=signalsFor(row.candidate.productId,activity);
  // Order within B: current-request/verified-evidence score is preserved, but
  // wishlist/cart interest is a major, bounded personalization contribution.
  const affinity=(signals.includes("CART")?.28:0)+(signals.includes("WISHLIST")?.24:0)+
   (signals.includes("PURCHASE")?.14:0);
  return {...row,personalizationSignals:signals,personalizedScore:row.score+affinity,originalIndex:index};
 }).sort((a,b)=>ranking.explicitReviewSort?.status==="APPLIED"?a.originalIndex-b.originalIndex:b.personalizedScore-a.personalizedScore||a.originalIndex-b.originalIndex);
 const unique:typeof scored=[];
 const seen=new Set<string>();
 for(const row of scored)if(!seen.has(row.candidate.productId)){seen.add(row.candidate.productId);unique.push(row);}
 if(ranking.explicitReviewSort?.status==="APPLIED")return {...ranking,ranked:unique.map(row=>{const {personalizedScore,originalIndex,...candidate}=row;return candidate;})};
 const result:LabeledCandidate[]=[];
 const taken=new Set<string>();
 const add=(row:typeof unique[number]|undefined,role:RecommendationRole)=>{
  if(!row||taken.has(row.candidate.productId))return;
  taken.add(row.candidate.productId);
  const {personalizedScore,originalIndex,...candidate}=row;
  result.push({...candidate,recommendationRole:role});
 };
 add(unique[0],"PERSONALIZED");
 const strict=unique.filter(row=>!taken.has(row.candidate.productId)&&meetsV07ReviewBar(row))
  .sort((a,b)=>(b.candidate.rating??0)-(a.candidate.rating??0)||
   (b.candidate.wholeReviewCount??0)-(a.candidate.wholeReviewCount??0)||
   a.originalIndex-b.originalIndex);
 add(strict[0],"REVIEW_VERIFIED");
 // Third choice: genuinely comparable alternative, favor a different price point
 // only when the underlying personalized score remains competitive.
 const firstPrice=result[0]?
  (result[0].candidate.unitPriceWon??0)+(result[0].candidate.shippingFeeWon??0):0;
 const remaining=unique.filter(row=>!taken.has(row.candidate.productId)).sort((a,b)=>{
  const value=(row:typeof unique[number])=>{
   const total=(row.candidate.unitPriceWon??0)+(row.candidate.shippingFeeWon??0);
   const contrast=firstPrice?Math.min(.12,Math.abs(total-firstPrice)/Math.max(firstPrice,total)*.12):0;
   return row.personalizedScore+contrast;
  };
  return value(b)-value(a)||a.originalIndex-b.originalIndex;
 });
 add(remaining[0],"ALTERNATIVE");
 for(const row of unique)if(result.length<3&&!taken.has(row.candidate.productId))add(row,"ALTERNATIVE");
 // Unchosen candidates stay available to the existing API, but only the curated
 // first three may be displayed. Reuse the original recommendation type.
 return {...ranking,ranked:[...result,...unique.filter(x=>!taken.has(x.candidate.productId)).map(x=>{
  const {personalizedScore,originalIndex,...candidate}=x;return candidate;
 })]};
}
