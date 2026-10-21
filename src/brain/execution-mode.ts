/** Future handoff contract only. Deep execution is not implemented or advertised. */
export type ExecutionMode="FAST"|"DEEP";
export interface EvidenceSnapshotOwner{
 actorUserId:string;conversationId:string;requestId:string;planRevision:number;
 evidenceSnapshotId:string;fenceGeneration:number;
}
export interface DeepHandoff extends EvidenceSnapshotOwner{
 datasetVersion:string;productVariantIds:readonly {productId:string;variantId:string}[];
 evidenceIds:readonly string[];
}
export function executionMode(value:unknown):ExecutionMode{
 if(value===undefined||value==="FAST")return "FAST";
 if(value==="DEEP")return "DEEP";
 throw Error("invalid execution mode");
}
/** Consistency predicate only; server-side ownership and DB fencing remain mandatory. */
export function snapshotMatches(current:EvidenceSnapshotOwner,result:EvidenceSnapshotOwner):boolean{
 return !!current.actorUserId&&!!current.conversationId&&!!current.requestId&&!!current.evidenceSnapshotId&&
  Number.isSafeInteger(current.planRevision)&&current.planRevision>0&&
  Number.isSafeInteger(current.fenceGeneration)&&current.fenceGeneration>0&&
  (Object.keys(current) as (keyof EvidenceSnapshotOwner)[]).every(key=>current[key]===result[key]);
}
