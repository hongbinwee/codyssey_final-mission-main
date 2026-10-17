import {createHash} from "node:crypto";
import type {BrainSqlDatabase} from "./persistent-store.ts";

/**
 * Per-minute, shared Postgres budget. Both global and per-actor charges are
 * committed atomically: a rejected request consumes NEITHER budget.
 * Never store raw actor identities or request contents.
 */
const quotas={
 turn:{user:12,global:100},
 mutation:{user:30,global:300}
} as const;
export type BrainRateKind=keyof typeof quotas;
export interface BrainRateResult {ok:boolean;retryAfterSeconds:number}
const hash=(v:string)=>createHash("sha256").update("brain-rate-v1:"+v).digest("hex");
export function createDistributedBrainRateLimit(db:BrainSqlDatabase){
 return {async take(actorId:string,kind:BrainRateKind):Promise<BrainRateResult>{
   if(!actorId||actorId.length>256||!(kind in quotas))throw Error("invalid Brain rate identity");
   const limits=quotas[kind];
   return db.transaction(async tx=>{
     const [clock]=await tx.query<{window_start:Date|string;retry_after:number}>(
       "SELECT date_trunc('minute',now()) AS window_start, greatest(1,ceil(extract(epoch FROM (date_trunc('minute',now())+interval '1 minute'-now()))))::int AS retry_after",[]);
     if(!clock)throw Error("Brain rate DB clock unavailable");
     // Lock global row before actor row in every worker to avoid deadlocks.
     for(const [scope,subject,maxHits] of [
        ["brain_"+kind+"_global",hash("global"),limits.global],
        ["brain_"+kind+"_user",hash(actorId),limits.user]
      ] as const){
       const rows=await tx.query<{hits:number}>(
         `INSERT INTO shopping_brain.rate_limit_windows
           (scope,subject_digest,window_start,hits) VALUES ($1,$2,$3,1)
          ON CONFLICT(scope,subject_digest,window_start)
          DO UPDATE SET hits=shopping_brain.rate_limit_windows.hits+1
          WHERE shopping_brain.rate_limit_windows.hits<$4
          RETURNING hits`,
          [scope,subject,clock.window_start,maxHits]);
       if(rows.length!==1){
         // Roll back global/user increments in the same transaction.
         throw new RateLimitExceeded(clock.retry_after);
       }
     }
     return {ok:true,retryAfterSeconds:0};
   }).catch(e=>{
     if(e instanceof RateLimitExceeded)return {ok:false,retryAfterSeconds:e.retryAfterSeconds};
     // Fail closed if the database is unreachable, never fall back to a
     // process-local bucket in a multi-instance deployment.
     throw e;
   });
 }};
}
class RateLimitExceeded extends Error{
 readonly retryAfterSeconds:number;
 constructor(retryAfterSeconds:number){super("Brain request limit reached");this.retryAfterSeconds=retryAfterSeconds;}
}
