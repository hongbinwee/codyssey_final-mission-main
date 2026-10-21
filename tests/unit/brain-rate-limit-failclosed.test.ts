import test from "node:test";
import assert from "node:assert/strict";
import {createDistributedBrainRateLimit} from "../../src/brain/rate-limit.ts";

test("legacy rate adapter accepts repeated valid turns and mutations without a quota database",async()=>{
 let databaseAccesses=0;
 const unavailableDb=new Proxy({}, {get(){databaseAccesses++;throw Error("quota database must not be used");}});
 const limiter=createDistributedBrainRateLimit(unavailableDb as never);
 const requests=[
  ...Array.from({length:13},()=>limiter.take("actor","turn")),
  ...Array.from({length:31},()=>limiter.take("actor","mutation")),
 ];
 const results=await Promise.all(requests);
 assert.ok(results.every(result=>result.ok&&result.retryAfterSeconds===0));
 assert.equal(databaseAccesses,0);
});

test("legacy rate adapter still rejects invalid actor and operation without database access",async()=>{
 let databaseAccesses=0;
 const unavailableDb=new Proxy({}, {get(){databaseAccesses++;throw Error("quota database must not be used");}});
 const limiter=createDistributedBrainRateLimit(unavailableDb as never);
 await assert.rejects(()=>limiter.take("","turn"),/invalid Brain rate identity/);
 await assert.rejects(()=>limiter.take("actor","unknown" as never),/invalid Brain rate identity/);
 assert.equal(databaseAccesses,0);
});
