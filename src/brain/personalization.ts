import type {Aspect,BrainTrace,EvidenceRecord,MemoryRepository,Preference,PreferenceKey,PreferenceValue,ProductCandidate,RankedCandidate,RankingResult,ShoppingContext} from "./contracts.ts";
import {assertPreference} from "./memory.ts";
const defaults:Record<PreferenceKey,PreferenceValue>={price_priority:"balanced",eye_comfort:"normal",noise_sensitivity:"normal"};
const retrievedRatingFacet="retrieved_review_rating";
type Dimension="cost"|Aspect;
const money=(n:number|null)=>n!==null&&Number.isSafeInteger(n)&&n>=0;
export function effectivePreferences(memories:Preference[],current:ShoppingContext["currentPreferences"]):Record<PreferenceKey,PreferenceValue>{
 const p={...defaults};
 for(const m of [...memories].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt))){assertPreference(m.key,m.value);p[m.key]=m.value;}
 for(const [k,v] of Object.entries(current))if(v!==undefined){assertPreference(k as PreferenceKey,v as PreferenceValue);p[k as PreferenceKey]=v as PreferenceValue;}
 return p;
}
function dimensionsFor(ctx:ShoppingContext,p:Record<PreferenceKey,PreferenceValue>,available:string[]):{facets:Aspect[];weights:Record<string,number>}{
 const requested=[...new Set(ctx.attributePreferences?.length?ctx.attributePreferences:available)];
 if(available.includes(retrievedRatingFacet)&&!requested.includes(retrievedRatingFacet))requested.push(retrievedRatingFacet);
 if((ctx.category!==undefined&&!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(ctx.category))||requested.length>25||
   requested.some(key=>!/^(?!cost$)[a-z][a-z0-9_]{0,79}$/.test(key)))throw Error("invalid category attributes");
 const cost=requested.length?(p.price_priority==="value"?.75:p.price_priority==="performance"?.15:.4):1;
 const result:Record<string,number>={cost};
 for(const key of requested)result[key]=(1-cost)/requested.length;
 // Backward-compatible explicit memories; never require these attributes in another category.
 if(!ctx.category&&p.eye_comfort==="important"&&requested.includes("eye_comfort"))result.eye_comfort+=.35;
 if(!ctx.category&&p.noise_sensitivity==="important"&&requested.includes("noise"))result.noise+=.35;
 return {facets:requested,weights:result};
}
/** Compatibility diagnostics only; these are never hard recommendation gates. */
export function eligibility(p:ProductCandidate):string[]{
 const r:string[]=[];
 if(p.ratingScale!==5||p.rating===null||!Number.isFinite(p.rating)||p.rating<1||p.rating>5)r.push("rating_unverified");
 if(!p.wholeReviewCountVerified||p.wholeReviewCount===null||!Number.isInteger(p.wholeReviewCount)||p.wholeReviewCount<0)r.push("whole_review_count_unverified");
 return r;
}
function evidenceValid(ids:string[],p:ProductCandidate,idx:Map<string,EvidenceRecord>,duplicates:Set<string>,
 options:{condition?:boolean;ratingFacet?:boolean}={}):boolean{
 const simulated=p.sourceKind==="SYNTHETIC"||p.isSimulated===true;
 return ids.length>0&&ids.every(id=>{
  const e=idx.get(id);
  if(!e||duplicates.has(id)||e.productId!==p.productId||
    (simulated?e.variantId!==p.variantId&&!(e.kind==="REVIEW"&&e.variantId===null):e.variantId!==null&&e.variantId!==p.variantId)||
    (options.condition&&e.kind!=="SPEC"))return false;
  if(simulated){
    if(e.verified!==true||e.datasetVersion!==p.datasetVersion||
      (e.kind==="SPEC"?e.sourceKind!=="SYNTHETIC":!["REAL","SYNTHETIC"].includes(e.sourceKind??"")))return false;
    if(e.kind==="REVIEW"&&(!options.ratingFacet||!Number.isFinite(e.rating)||e.rating!<1||e.rating!>5))return false;
  }else if(e.kind==="REVIEW"&&e.sourceKind!=="REAL")return false;
  return true;
 });
}
function approvedSimulatedCandidate(p:ProductCandidate):boolean{
 if(!["REAL","SYNTHETIC"].includes(p.sourceKind??"")||p.isSimulated!==true||p.qaRankingEligible!==true||p.commerceVerified!==true||
   typeof p.datasetVersion!=="string"||!p.datasetVersion)return false;
 // Catalog eligibility and review evidence are independent. Review facets and
 // mandatory specifications are still checked against their exact evidence below.
 return true;
}
function validRetrievedRatingFacet(f:NonNullable<ProductCandidate["facets"][string]>,p:ProductCandidate,
 idx:Map<string,EvidenceRecord>,duplicates:Set<string>):boolean{
 if(!approvedSimulatedCandidate(p)||
   !evidenceValid(f.evidenceIds,p,idx,duplicates,{ratingFacet:true}))return false;
 const rows=f.evidenceIds.map(id=>idx.get(id)!);
 const mean=rows.reduce((sum,row)=>sum+row.rating!/5,0)/rows.length;
 return Math.abs(mean-f.score)<1e-9;
}
/** Fixed global denominator; missing evidence cannot improve a candidate's score. */
export function rankProducts(candidates:ProductCandidate[],evidence:EvidenceRecord[],ctx:ShoppingContext,memories:Preference[]):RankingResult{
 if(ctx.maxTotalWon!==null&&(!Number.isSafeInteger(ctx.maxTotalWon)||ctx.maxTotalWon<0))throw new Error("invalid budget");
 if(ctx.minTotalWon!==undefined&&(!Number.isSafeInteger(ctx.minTotalWon)||ctx.minTotalWon<0||ctx.maxTotalWon!==null&&ctx.minTotalWon>ctx.maxTotalWon))throw new Error("invalid budget range");
 const scoped=ctx.category?memories.filter(p=>p.key==="price_priority"):memories;
 const current=ctx.category?{price_priority:ctx.currentPreferences.price_priority}:ctx.currentPreferences;
 const pref=effectivePreferences(scoped,current),dimensions=dimensionsFor(ctx,pref,[...new Set(candidates.flatMap(p=>Object.keys(p.facets)))].sort()),w=dimensions.weights,
   activeFacets=dimensions.facets,denom=Object.values(w).reduce((x,y)=>x+y,0);
 const idx=new Map<string,EvidenceRecord>(),duplicates=new Set<string>();
 for(const e of evidence){if(idx.has(e.id))duplicates.add(e.id);idx.set(e.id,e);}
 const ranked:RankedCandidate[]=[],referenceOnly:RankingResult["referenceOnly"]=[],rejected:RankingResult["rejected"]=[];
 // Shared reference cost axis for no-budget user requests; costs are confirmed Commerce values.
 const totals=candidates.filter(p=>money(p.unitPriceWon)&&money(p.shippingFeeWon))
  .map(p=>p.unitPriceWon!+p.shippingFeeWon!);
 const minCost=totals.length?Math.min(...totals):0,maxCost=totals.length?Math.max(...totals):0;
 for(const p of candidates){
  const reasons:string[]=[];
  if(!p.productId||!p.variantId)reasons.push("missing_commerce_identity");
  if(p.commerceVerified===false)reasons.push("commerce_identity_unverified");
  if(!money(p.unitPriceWon)||!money(p.shippingFeeWon))reasons.push("price_or_shipping_unverified");
  const total=money(p.unitPriceWon)&&money(p.shippingFeeWon)?p.unitPriceWon!+p.shippingFeeWon!:null;
  if(ctx.maxTotalWon!==null&&total!==null&&total>ctx.maxTotalWon)reasons.push("over_total_budget");
  if(ctx.minTotalWon!==undefined&&total!==null&&total<ctx.minTotalWon)reasons.push("below_total_budget");
  for(const condition of ctx.requiredConditions)if(!evidenceValid(p.conditions[condition]??[],p,idx,duplicates,{condition:true}))reasons.push("unverified_required_condition:"+condition);
  if(reasons.length){rejected.push({candidate:p,reasons});continue;}
  if(p.sourceKind==="SYNTHETIC"||p.isSimulated){
   if(!approvedSimulatedCandidate(p)){
    referenceOnly.push({candidate:p,reasons:["synthetic_or_simulated_reference"]});continue;
   }
  }
  for(const [facet,f] of Object.entries(p.facets)){
   const invalid=!/^[a-z][a-z0-9_]{0,79}$/.test(facet)||!f||!Number.isFinite(f.score)||f.score<0||f.score>1||
    (facet===retrievedRatingFacet?!validRetrievedRatingFacet(f,p,idx,duplicates):!evidenceValid(f.evidenceIds,p,idx,duplicates));
   if(invalid)reasons.push("invalid_or_cross_product_facet:"+facet);
  }
  if(reasons.length){rejected.push({candidate:p,reasons});continue;}
  const signals:{name:Dimension;weight:number;score:number}[]=[];
  if(total!==null){
   const costScore=ctx.maxTotalWon!==null?(ctx.maxTotalWon>0?Math.max(0,1-total/ctx.maxTotalWon):0)
     :(maxCost>minCost?Math.max(0,Math.min(1,(maxCost-total)/(maxCost-minCost))):1);
   signals.push({name:"cost",weight:w.cost,score:costScore});
  }
  for(const facet of activeFacets){const f=p.facets[facet];if(f)signals.push({name:facet,weight:w[facet],score:f.score});}
  // Missing soft signals contribute zero; no rating/review-count threshold excludes a product.
  const rating=p.ratingScale===5&&p.rating!==null&&Number.isFinite(p.rating)&&p.rating>=1&&p.rating<=5?p.rating/5:0;
  const count=p.wholeReviewCountVerified&&p.wholeReviewCount!==null&&Number.isSafeInteger(p.wholeReviewCount)&&p.wholeReviewCount>=0
    ?Math.min(1,Math.log1p(p.wholeReviewCount)/Math.log(1001)):0;
  const coverage=signals.reduce((a,b)=>a+b.weight,0)/denom;
  const score=.9*signals.reduce((a,b)=>a+b.weight*b.score,0)/denom+.07*rating+.03*count;
  ranked.push({candidate:p,score,evidenceCoverage:coverage,missingAspects:activeFacets.filter(f=>!p.facets[f]),effectivePreferences:{...pref},
    limitations:[...eligibility(p),...activeFacets.filter(f=>!p.facets[f]).map(f=>"attribute_unverified:"+f),
      ...(p.facets[retrievedRatingFacet]?["retrieved_synthetic_review_rating_sample_only"]:[])]});
 }
 ranked.sort((a,b)=>b.score-a.score);
 return {ranked,referenceOnly,rejected,evaluatedCount:candidates.length};
}
export async function evaluatePersonalizedCandidates(trace:BrainTrace,ctx:ShoppingContext,candidates:ProductCandidate[],evidence:EvidenceRecord[],memory:MemoryRepository):Promise<RankingResult>{
 if(!trace.actorUserId||!trace.conversationId||!trace.requestId)throw new Error("trusted trace required");
 const m=await memory.list(trace.actorUserId);
 if(m.some(row=>row.userId!==trace.actorUserId))throw new Error("memory tenant mismatch");
 return rankProducts(candidates,evidence,ctx,m);
}
