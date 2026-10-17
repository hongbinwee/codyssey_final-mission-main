import {createHash} from "node:crypto";

/** Metadata-only audit; never exports prompt text, gold answers or user context. */
export interface GoldCase {
 id:string;message:string;group:string;split?:string;annotationStatus?:string;
 previous?:unknown;dataClass?:string;
}
const norm=(s:string)=>s.normalize("NFKC").trim().toLowerCase()
 .replace(/\s+/g,"").replace(/[.,!?。！？，]/g,"");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export function auditIntentDataset(cases:readonly GoldCase[]){
 if(!cases.length)throw Error("empty evaluation dataset");
 const ids=new Set<string>(),exact=new Map<string,Set<string>>();
 let invalid=0;
 const splits=new Map<string,number>(),annotations=new Map<string,number>();
 for(const c of cases){
  if(!c||typeof c.id!=="string"||!c.id.trim()||ids.has(c.id)||
     typeof c.message!=="string"||!c.message.trim()||
     typeof c.group!=="string"||!c.group.trim()||
     c.dataClass!=="EVALUATION_ONLY"){
    invalid++;
    continue;
  }
  ids.add(c.id);
  const split=c.split??"unassigned";
  splits.set(split,(splits.get(split)??0)+1);
  const state=c.annotationStatus??"unreviewed";
  annotations.set(state,(annotations.get(state)??0)+1);
  const key=hash(JSON.stringify([norm(c.message),c.previous??null]));
  const entry=exact.get(key)??new Set<string>();
  entry.add(split);exact.set(key,entry);
 }
 const crossSplitDuplicateGroups=[...exact.values()].filter(v=>v.size>1).length;
 const summary={
  cases:cases.length,uniqueIds:ids.size,invalidCases:invalid,
  splits:Object.fromEntries([...splits].sort(([a],[b])=>a.localeCompare(b))),
  annotationStatuses:Object.fromEntries([...annotations].sort(([a],[b])=>a.localeCompare(b))),
  crossSplitDuplicateGroups,
  independentlyApproved:annotations.get("independently_adjudicated")===cases.length,
  safeForBlindHoldout:invalid===0&&crossSplitDuplicateGroups===0&&
    annotations.get("independently_adjudicated")===cases.length
 };
 return summary;
}

/**
 * Heuristic only: character-bigram Dice similarity proposes human review pairs.
 * This is NOT semantic equivalence, a model embedding, nor independent labeling.
 * Never output the question/gold content from holdout cases.
 */
export function suggestCrossSplitNearDuplicates(cases:readonly GoldCase[],threshold=.64){
 if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw Error("invalid similarity threshold");
 const gram=(value:string)=>{
  const text=norm(value);
  const result=new Set<string>();
  for(let i=0;i<text.length-1;i++)result.add(text.slice(i,i+2));
  return result;
 };
 const pairs:{developmentId:string;holdoutId:string;similarity:number}[]=[];
 const dev=cases.filter(c=>c.split==="development"&&typeof c.message==="string");
 const held=cases.filter(c=>c.split==="candidate_holdout"&&typeof c.message==="string");
 for(const left of dev){
  const x=gram(left.message);
  if(!x.size)continue;
  for(const right of held){
   // Different previous-plan states may represent different intended actions;
   // do not call a superficial surface-text match a confirmed leak.
   const y=gram(right.message);
   if(!y.size)continue;
   let intersection=0;
   for(const g of x)if(y.has(g))intersection++;
   const dice=2*intersection/(x.size+y.size);
   if(dice>=threshold)pairs.push({
    developmentId:left.id,holdoutId:right.id,similarity:Math.round(dice*1000)/1000
   });
  }
 }
 pairs.sort((a,b)=>b.similarity-a.similarity||
   a.developmentId.localeCompare(b.developmentId)||
   a.holdoutId.localeCompare(b.holdoutId));
 return {method:"character_bigram_dice_heuristic" as const,
  threshold,reviewRequiredPairs:pairs.length,candidates:pairs.slice(0,30),
  truncated:pairs.length>30,independentSemanticAuditComplete:false as const};
}
