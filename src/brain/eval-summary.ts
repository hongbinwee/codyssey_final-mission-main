/** Pure model-evaluation reporting. No live API access and no sample text. */
export interface IntentEvalRow {
 group:string;split?:string;passed:boolean;fields:Record<string,boolean>;
 latencyMs:number;error?:string
}
export function summarizeIntentQuality(rows:readonly IntentEvalRow[]){
 if(!rows.length)throw Error("empty intent evaluation");
 const grouped=(key:(r:IntentEvalRow)=>string)=>{
  const names=[...new Set(rows.map(key))].sort();
  return Object.fromEntries(names.map(name=>{
   const group=rows.filter(r=>key(r)===name),success=group.filter(r=>r.passed).length;
   return [name,{cases:group.length,passed:success,exactPlanAccuracy:success/group.length}];
  }));
 };
 const fields=["query","maxTotalWon","requiredConditions","currentPreferences"];
 const fieldAccuracy=Object.fromEntries(fields.map(field=>[
  field,rows.filter(r=>r.fields[field]===true).length/rows.length
 ]));
 const histogram:Record<string,number>={};
 for(const r of rows){
  if(r.error){
   // No raw provider exception, credential or user transcript in shared reports.
   const key=/timeout/i.test(r.error)?"TIMEOUT":
     /429|rate.limit/i.test(r.error)?"RATE_LIMIT":
     /invalid|JSON|schema/i.test(r.error)?"INVALID_OUTPUT":"OTHER_ERROR";
   histogram[key]=(histogram[key]??0)+1;
  }
 }
 const sorted=rows.map(r=>r.latencyMs).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b);
 const pct=(p:number)=>sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;
 return {
  groups:grouped(r=>r.group),
  splits:grouped(r=>r.split??"unassigned"),
  fieldAccuracy,errorsByType:histogram,
  latencyMs:{p50:pct(.5),p95:pct(.95)},
  latencySamples:sorted.length,
  providerCallCostUsd:null as null,
  providerCallCostStatus:"NOT_MEASURED" as const
 };
}
