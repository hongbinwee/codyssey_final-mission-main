import test from "node:test";
import assert from "node:assert/strict";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
test("turn lock validates UUID and releases reserved session when busy",async()=>{
 let releaseCalls=0,queried=0;
 const pool={async reserve(){return {
   async unsafe(query:string,args:unknown[]){
     queried++;assert.match(query,/pg_try_advisory_lock/);
     assert.match(String(args[0]),/^-?\d+$/);
     return [{acquired:false}];
   },
   async release(){releaseCalls++;}
 }}};
 const lock=postgresTurnLock(pool,{async unsafe(){return [{held:true}];}});
 assert.equal(await lock.tryAcquire("11111111-1111-4111-8111-111111111111"),null);
 assert.equal(releaseCalls,1);
 assert.equal(queried,1);
 await assert.rejects(()=>lock.tryAcquire("not-a-uuid"),/invalid conversation/);
});
test("turn lock unlocks using identical 64-bit key and finally releases session",async()=>{
 const calls:{query:string;key:string}[]=[];let released=0;
 const pool={async reserve(){return {
   async unsafe(query:string,args:unknown[]){
     calls.push({query,key:String(args[0])});
     if(query.includes("pg_try_advisory_lock"))return [{acquired:true,pid:12345}];
     if(query.includes("FROM pg_locks"))return [{pid:12345,held:true}];
     return [{acquired:true}];
   },async release(){released++;}
 }}};
 const observer={async unsafe(query:string,args:unknown[]){
   calls.push({query,key:String(args[1])});
   return [{held:true}];
 }};
 const lease=await postgresTurnLock(pool,observer).tryAcquire("22222222-2222-4222-8222-222222222222");
 assert.ok(lease);
 await lease.assertHeld();
 await lease.release();
 await lease.release();
 assert.equal(calls.length,4);
 assert.match(calls[0].query,/pg_try_advisory_lock/);
 assert.match(calls[1].query,/FROM pg_locks/);
 assert.match(calls[2].query,/FROM pg_locks/);
 assert.match(calls[3].query,/pg_advisory_unlock/);
 assert.equal(calls[0].key,calls[3].key);
 assert.equal(released,1);
});
