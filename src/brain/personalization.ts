import type {Aspect,BrainTrace,EvidenceRecord,MemoryRepository,Preference,PreferenceKey,PreferenceValue,ProductCandidate,RankedCandidate,RankingResult,ShoppingContext} from "./contracts.ts";
import {assertPreference} from "./memory.ts";
const defaults:Record<PreferenceKey,PreferenceValue>={price_priority:"balanced",eye_comfort:"normal",noise_sensitivity:"normal"};
type Dimension="cost"|Aspect;
const weights:Record<"value"|"balanced"|"performance",Record<Dimension,number>>={
 value:{cost:.54,performance:.30,eye_comfort:.10,noise:.06},
 balanced:{cost:.27,performance:.37,eye_comfort:.20,noise:.16},
 performance:{cost:.10,performance:.63,eye_comfort:.19,noise:.08},
};
const facets:Aspect[]=["performance","eye_comfort","noise"];
const money=(n:number|null)=>n!==null&&Number.isSafeInteger(n)&&n>=0;
export function effectivePreferences(memories:Preference[],current:ShoppingContext["currentPreferences"]):Record<PreferenceKey,PreferenceValue>{
 const p={...defaults};
 for(const m of [...memories].sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt))){assertPreference(m.key,m.value);p[m.key]=m.value;}
 for(const [k,v] of Object.entries(current))if(v!==undefined){assertPreference(k as PreferenceKey,v as PreferenceValue);p[k as PreferenceKey]=v as PreferenceValue;}
 return p;
}
function weightsFor(p:Record<PreferenceKey,PreferenceValue>){
 const w={...weights[p.price_priority as keyof typeof weights]};
 if(p.eye_comfort==="important")w.eye_comfort+=.35;
 if(p.noise_sensitivity==="important")w.noise+=.35;
 return w;
}
/** Same recommendation-eligibility thresholds as Commerce G2, separately versioned pending review. */
export function eligibility(p:ProductCandidate):string[]{
 const r:string[]=[];
 if(p.ratingScale!==5||p.rating===null||!Number.isFinite(p.rating)||p.rating<1||p.rating>5)r.push("rating_unverified");
 else if(p.rating<=3.5)r.push("rating_below_G2");
 if(!p.wholeReviewCountVerified||p.wholeReviewCount===null||!Number.isInteger(p.wholeReviewCount)||p.wholeReviewCount<0)r.push("whole_review_count_unverified");
 else if(p.wholeReviewCount<10)r.push("whole_review_count_below_G2");
 return r;
}
function evidenceValid(ids:string[],p:ProductCandidate,idx:Map<string,EvidenceRecord>,duplicates:Set<string>){
 return ids.length>0&&ids.every(id=>{
  const e=idx.get(id);
  return !!e&&!duplicates.has(id)&&e.productId===p.productId&&(e.variantId===null||e.variantId===p.variantId)&&(e.kind!=="REVIEW"||e.sourceKind==="REAL");
 });
}
/** Fixed global denominator; missing evidence cannot improve a candidate's score. */
export function rankProducts(candidates:ProductCandidate[],evidence:EvidenceRecord[],ctx:ShoppingContext,memories:Preference[]):RankingResult{
 if(ctx.maxTotalWon!==null&&(!Number.isSafeInteger(ctx.maxTotalWon)||ctx.maxTotalWon<0))throw new Error("invalid budget");
 const pref=effectivePreferences(memories,ctx.currentPreferences),w=weightsFor(pref),denom=Object.values(w).reduce((x,y)=>x+y,0);
 const idx=new Map<string,EvidenceRecord>(),duplicates=new Set<string>();
 for(const e of evidence){if(idx.has(e.id))duplicates.add(e.id);idx.set(e.id,e);}
 const ranked:RankedCandidate[]=[],referenceOnly:RankingResult["referenceOnly"]=[],rejected:RankingResult["rejected"]=[];
 // Shared reference cost axis for no-budget user requests; costs are confirmed Commerce values.
 const totals=candidates.filter(p=>eligibility(p).length===0&&money(p.unitPriceWon)&&money(p.shippingFeeWon))
  .map(p=>p.unitPriceWon!+p.shippingFeeWon!);
 const minCost=totals.length?Math.min(...totals):0,maxCost=totals.length?Math.max(...totals):0;
 for(const p of candidates){
  const reasons:string[]=[];
  if(!p.productId||!p.variantId)reasons.push("missing_commerce_identity");
  if(!money(p.unitPriceWon)||!money(p.shippingFeeWon))reasons.push("price_or_shipping_unverified");
  const total=money(p.unitPriceWon)&&money(p.shippingFeeWon)?p.unitPriceWon!+p.shippingFeeWon!:null;
  if(ctx.maxTotalWon!==null&&total!==null&&total>ctx.maxTotalWon)reasons.push("over_total_budget");
  for(const condition of ctx.requiredConditions)if(!evidenceValid(p.conditions[condition]??[],p,idx,duplicates))reasons.push("unverified_required_condition:"+condition);
  for(const facet of facets){const f=p.facets[facet];if(f&&(!Number.isFinite(f.score)||f.score<0||f.score>1||!evidenceValid(f.evidenceIds,p,idx,duplicates)))reasons.push("invalid_or_cross_product_facet:"+facet);}
  if(reasons.length){rejected.push({candidate:p,reasons});continue;}
  const gate=eligibility(p);
  if(gate.length){referenceOnly.push({candidate:p,reasons:gate});continue;}
  const signals:{name:Dimension;weight:number;score:number}[]=[];
  if(total!==null){
   const costScore=ctx.maxTotalWon!==null?(ctx.maxTotalWon>0?Math.max(0,1-total/ctx.maxTotalWon):0)
     :(maxCost>minCost?Math.max(0,Math.min(1,(maxCost-total)/(maxCost-minCost))):1);
   signals.push({name:"cost",weight:w.cost,score:costScore});
  }
  for(const facet of facets){const f=p.facets[facet];if(f)signals.push({name:facet,weight:w[facet],score:f.score});}
  const coverage=signals.reduce((a,b)=>a+b.weight,0)/denom;
  const critical=facets.filter(f=>w[f]/denom>=.25&&!p.facets[f]);
  if(coverage<.65||critical.length){referenceOnly.push({candidate:p,reasons:[...(coverage<.65?["insufficient_evidence_coverage"]:[]),...critical.map(a=>"missing_critical_aspect:"+a)]});continue;}
  const score=signals.reduce((a,b)=>a+b.weight*b.score,0)/denom;
  ranked.push({candidate:p,score,evidenceCoverage:coverage,missingAspects:facets.filter(f=>!p.facets[f]),effectivePreferences:{...pref}});
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
