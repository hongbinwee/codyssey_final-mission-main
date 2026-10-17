import test from "node:test";
import assert from "node:assert/strict";
import {createDistributedBrainRateLimit} from "../../src/brain/rate-limit.ts";
test("M15 unavailable shared quota DB must fail closed rather than allow a request",async()=>{
 const limiter=createDistributedBrainRateLimit({
  async transaction(){throw Error("database unavailable");}
 } as never);
 await assert.rejects(()=>limiter.take("actor","turn"),/database unavailable/);
});
test("M15 reject invalid rate-limit identity without touching database",async()=>{
 let touched=false;
 const limiter=createDistributedBrainRateLimit({async transaction(){touched=true;throw Error("unexpected");}} as never);
 await assert.rejects(()=>limiter.take("","turn"),/invalid Brain rate identity/);
 assert.equal(touched,false);
});
