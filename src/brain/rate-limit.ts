export type BrainRateKind="turn"|"mutation";
export interface BrainRateResult {ok:true;retryAfterSeconds:0}

/**
 * Compatibility shim for callers of the former distributed limiter.
 * Authentication and CSRF are enforced by the API boundary; this performs
 * validation only and never reads or writes a quota database.
 */
export function createDistributedBrainRateLimit(_legacyDb?:unknown){
 return {async take(actorId:string,kind:BrainRateKind):Promise<BrainRateResult>{
   if(typeof actorId!=="string"||!actorId.trim()||actorId.length>256||
      (kind!=="turn"&&kind!=="mutation"))throw Error("invalid Brain rate identity");
   return {ok:true,retryAfterSeconds:0};
 }};
}
