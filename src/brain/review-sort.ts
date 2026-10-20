/** QA09: explicitly requested attribute-positive *sample review* order.
 * Never use review totals, mean star rating, arbitrary RAG text or cart affinity as a proxy.
 */
import type {EvidenceRecord,RankingResult,RankedCandidate} from "./contracts.ts";

export function requestedPositiveReviewSort(message:string):string|null{
 const text=message.trim().replace(/\s+/g," ");
 if(!/(?:리뷰|후기)/.test(text)||!/(?:많은\s*순|많이\s*(?:언급|나온)\s*순|많은\s*(?:순서|순으로)|많이\s*나오는\s*순)/.test(text))return null;
 // The sort subject must be attached to the review clause. If ambiguous, do not silently infer a sort.
 const m=/(?:^|\s|에서\s*)([가-힣]{2,20}?)(?:하다는|하다고|했다는|한\s*편이라는|하단|하다는\s*긍정적인)\s*(?:긍정적인\s*)?(?:리뷰|후기)(?:가|이|를|를\s*가장)?\s*(?:많은|많이)/.exec(text)||
  /(?:^|\s|에서\s*)([가-힣]{2,20}?)(?:함|한\s*점|한\s*편)?\s*긍정(?:적인)?\s*(?:리뷰|후기)(?:가|이)?\s*많은/.exec(text);
 if(!m)return null;
 const aspect=m[1].trim().replace(/^(?:더|제일|가장|정말|아주)\s*/,"");
 return aspect.length>=2&&aspect.length<=20?aspect:null;
}

export function positiveForAspect(text:string,aspect:string):boolean{
 if(!text||text.length>600)return false;
 const normalized=text.normalize("NFKC");
 const chunks=normalized.split(/[.!\n。]/);
 for(const clause of chunks){
  if(!clause.includes(aspect))continue;
  // Interrogation, attribution, quotation and negation all invalidate positive evidence.
  if(/[?？]/.test(clause)||/(?:후기|리뷰|누가|남들|사람들|친구|타인|광고).{0,16}(?:말|하대|했대|그렇다)/.test(clause)||
   /(?:라고|이라는|라는|다고)\s*(?:하던데|들었|봤|적혀|써있|했다|해서|하지만)/.test(clause)||
   /["“”'‘’]/.test(clause))continue;
  const at=clause.indexOf(aspect);
  const around=clause.slice(Math.max(0,at-10),Math.min(clause.length,at+45));
  if(/(?:안\s*|못\s*|덜\s*|별로\s*|전혀\s*|그다지\s*|생각보다\s*안\s*)$/.test(clause.slice(Math.max(0,at-15),at))||
     /(?:하지\s*않|하지\s*못|하지\s*않아|하지\s*않았|하지\s*않음|하지\s*않는|하진\s*않|하지\s*않더|하지\s*못해|지\s*않|지\s*못|아니|않아|별로|부족|없어|실망|아쉽|불만|과장|그렇지\s*않)/.test(around))continue;
  // Presence alone is insufficient: require an affirmative adjectival ending or explicit approval.
  const suffix=clause.slice(at+aspect.length,at+aspect.length+24);
  if(/^(?:해요|해서|했고|하고|한\s*편|합니다|함이\s*(?:좋|느껴|만족)|하네요|해|하다(?=$|\s|[,;])|하더라|했어요|한데|한\s*것|하게|하게\s*느껴|한\s*느낌)/.test(suffix)||
     /^(?:함|한|함이).{0,12}(?:좋|만족|추천)/.test(suffix))return true;
 }
 return false;
}

export interface PositiveReviewSortResult{
 status:"VERIFIED_SAMPLE_ORDER"|"INSUFFICIENT";
 ranking:RankingResult;
 counts:ReadonlyMap<string,number>;
 /** IDs are the original Commerce review IDs, never RAG chunk IDs. */
 sampledReviewIds:number;
}
/** Only Commerce-verified, correctly scoped, deduplicated review evidence counts.
 * Lack of evidence is not evidence of a negative review or a full-catalog ranking.
 */
export function sortByVerifiedPositiveReviews(
 ranking:RankingResult,evidence:readonly EvidenceRecord[],aspect:string
):PositiveReviewSortResult{
 const counts=new Map<string,number>();
 const byProduct=new Map<string,RankedCandidate[]>();
 for(const row of ranking.ranked){
  const list=byProduct.get(row.candidate.productId)??[];
  list.push(row);byProduct.set(row.candidate.productId,list);
 }
 const unique=new Set<string>();
 const selected:RankedCandidate[]=[];
 const unverifiable=ranking.ranked.filter(row=>row.candidate.commerceVerified!==true);
 for(const [productId,rows] of byProduct){
  let bestRow:RankedCandidate|null=null,bestCount=-1;
  // An option-specific review cannot raise the score for another option.
  // Product-wide reviews (variantId=null) can be considered with either option,
  // but only one selected variant per product is ultimately ranked.
  for(const row of rows){
   const p=row.candidate;
   if(p.commerceVerified!==true)continue;
   const scoped=evidence.filter(e=>e.kind==="REVIEW"&&e.verified===true&&
    e.productId===productId&&(e.variantId===null||e.variantId===p.variantId)&&
    e.datasetVersion===p.datasetVersion&&typeof e.sourceId==="string"&&e.sourceId.length>0&&
    typeof e.sourceRef==="string"&&e.sourceRef.length>0&&typeof e.text==="string"&&
    (e.sourceKind==="REAL"||e.sourceKind==="SYNTHETIC"&&p.isSimulated===true&&p.qaRankingEligible===true));
   const reviews=new Map<string,EvidenceRecord[]>();
   for(const e of scoped){const group=reviews.get(e.sourceId!)??[];group.push(e);reviews.set(e.sourceId!,group);}
   let count=0;
   for(const [reviewId,group] of reviews){
    unique.add(productId+":"+reviewId);
    const positives=group.filter(e=>positiveForAspect(e.text!,aspect));
    const negative=group.some(e=>/(?:하지\s*않|지\s*않|안\s*|별로|아쉽|불만|실망|부족)/.test(e.text!));
    if(positives.length&&(!negative||group.every(e=>positiveForAspect(e.text!,aspect))))count++;
   }
   if(count>bestCount){bestRow=row;bestCount=count;}
  }
  if(bestRow){selected.push(bestRow);counts.set(productId,bestCount);}
 }
 const referenceOnly=[...ranking.referenceOnly,...unverifiable.map(row=>({
  candidate:row.candidate,reasons:["commerce_identity_unverified"]
 }))];
 const positiveProducts=[...counts.values()].filter(n=>n>0).length;
 if(positiveProducts<2){
  return {status:"INSUFFICIENT",counts,sampledReviewIds:unique.size,
   ranking:{...ranking,ranked:[],referenceOnly:[
    ...selected.map(row=>({candidate:row.candidate,reasons:["review_sort_evidence_insufficient"]})),
    ...referenceOnly
   ]}};
 }
 // Stable existing relevance ordering breaks equal observed-count ties only.
 const sorted=selected.sort((a,b)=>(counts.get(b.candidate.productId)??0)-(counts.get(a.candidate.productId)??0));
 return {status:"VERIFIED_SAMPLE_ORDER",ranking:{...ranking,ranked:sorted,referenceOnly},counts,sampledReviewIds:unique.size};
}
