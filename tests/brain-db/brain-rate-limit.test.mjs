import test from "node:test";
import assert from "node:assert/strict";
import {createDistributedBrainRateLimit} from "../../src/brain/rate-limit.ts";

test("M15 compatibility rate adapter does not enforce global minute budgets or access quota DB",async()=>{
 let databaseAccesses=0;
 const unavailableDb=new Proxy({}, {get(){databaseAccesses++;throw Error("quota database must not be required");}});
 const limiter=createDistributedBrainRateLimit(unavailableDb);
 const requests=[
  ...Array.from({length:101},(_,i)=>limiter.take("turn-actor-"+i,"turn")),
  ...Array.from({length:301},(_,i)=>limiter.take("mutation-actor-"+i,"mutation")),
 ];
 const results=await Promise.all(requests);
 assert.equal(results.length,402);
 assert.ok(results.every(result=>result.ok&&result.retryAfterSeconds===0));
 assert.equal(databaseAccesses,0);
});
