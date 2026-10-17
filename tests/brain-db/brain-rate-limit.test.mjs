import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {createDistributedBrainRateLimit} from "../../src/brain/rate-limit.ts";

test("M15 PostgreSQL rate budget is atomic across independent workers and does not spend on rejects",async()=>{
 const url=process.env.BRAIN_DATABASE_URL;
 if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const a=postgres(url,{max:6}),b=postgres(url,{max:6});
 try{
  const first=createDistributedBrainRateLimit(brainDatabaseFromPostgres(a));
  const second=createDistributedBrainRateLimit(brainDatabaseFromPostgres(b));
  const id="M15-rate-"+crypto.randomUUID();
  const requests=Array.from({length:15},(_,i)=>(i%2?first:second).take(id,"turn"));
  const outcomes=await Promise.all(requests);
  assert.equal(outcomes.filter(x=>x.ok).length,12,"two processes must share one per-user bucket");
  assert.equal(outcomes.filter(x=>!x.ok).length,3);
  assert.ok(outcomes.filter(x=>!x.ok).every(x=>x.retryAfterSeconds>=1&&x.retryAfterSeconds<=60));
  const globalRows=await a.unsafe("SELECT coalesce(sum(hits),0)::int AS hits FROM shopping_brain.rate_limit_windows WHERE scope='brain_turn_global'");
  const unchanged=await first.take(id,"turn");
  assert.equal(unchanged.ok,false);
  const afterRows=await a.unsafe("SELECT coalesce(sum(hits),0)::int AS hits FROM shopping_brain.rate_limit_windows WHERE scope='brain_turn_global'");
  assert.equal(afterRows[0].hits,globalRows[0].hits,"rejected user must not consume global budget");
  assert.equal((await second.take("other-"+crypto.randomUUID(),"turn")).ok,true);
  assert.equal((await first.take(id,"mutation")).ok,true,"separate user mutation bucket");
  const [sensitive]=await a.unsafe("SELECT count(*)::int AS n FROM shopping_brain.rate_limit_windows WHERE subject_digest LIKE $1",["%"+id+"%"]);
  assert.equal(sensitive.n,0,"never save raw actor identity in quota table");
 }finally{await Promise.allSettled([a.end(),b.end()]);}
});
