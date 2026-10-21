/** Deterministic evaluation rubric, separate from model/planner implementation. */
export interface ExpectedShoppingPlan {
 query:string;maxTotalWon:number|null;requiredConditions:string[];
 currentPreferences:Record<string,string>
}
function canonicalObject(v:Record<string,string>){
 return JSON.stringify(Object.keys(v).sort().map(k=>[k,v[k]]));
}
/** Hard requirements are a set of constraints, not ordered recommendations. */
function sameConditions(actual:string[],expected:string[]){
 if(!Array.isArray(actual)||!Array.isArray(expected)||new Set(actual).size!==actual.length||
    new Set(expected).size!==expected.length)return false;
 return actual.length===expected.length&&
   [...actual].sort().every((x,i)=>x===[...expected].sort()[i]);
}
export function gradeShoppingPlan(actual:ExpectedShoppingPlan,expected:ExpectedShoppingPlan):Record<keyof ExpectedShoppingPlan,boolean>{
 return {
   query:actual.query===expected.query,
   maxTotalWon:actual.maxTotalWon===expected.maxTotalWon,
   requiredConditions:sameConditions(actual.requiredConditions,expected.requiredConditions),
   currentPreferences:canonicalObject(actual.currentPreferences)===canonicalObject(expected.currentPreferences)
 };
}
export function fullPlanPass(fields:Record<string,boolean>):boolean{
 return Object.keys(fields).length===4&&Object.values(fields).every(x=>x===true);
}
