import test from "node:test";
import assert from "node:assert/strict";
import {summarizeLatency} from "../../src/brain/latency.ts";
import {createBrainApi} from "../../src/brain/api.ts";

test("p50/p95 ordering and input are stable, never replace live metrics with mock",()=>{
 const data=[1,4,12,2,40,6,13,5,3,2,8,12,7,4,19,3,7,5,11,50];
 const s=summarizeLatency(data);
 assert.equal(s.count,20);
 assert.equal(s.p50Ms,6);
 assert.equal(s.p95Ms,40);
 assert.equal(s.maxMs,50);
 assert.throws(()=>summarizeLatency([]));
 assert.throws(()=>summarizeLatency([Number.NaN]));
});
test("authenticated Brain API reports Graph wall time separately from partial research",async()=>{
 const convo="11111111-1111-4111-8111-111111111111";
 const graph={async invoke(req:{
 actorUserId:string;conversationId:string;requestId:string;clientActionId:string;userMessage:string;
 }){
  assert.equal(req.actorUserId,"qa-a");
  await new Promise(resolve=>setTimeout(resolve,14));
  return {conversationId:convo,messageId:convo,
   trace:{memoryMs:2,intentMs:1,retrievalMs:1,rankMs:1,totalMs:5},
   ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0}};
 },async getOwnedState(){return {values:{}}}};
 const api=createBrainApi({conversations:{
   async create(){return {id:convo,actorUserId:"qa-a"};},
   async assertOwned(){},
   async proposePreference(){return convo;},
   async confirmPreference(){throw Error("no confirmation");}
  },preferences:{async list(){return [];},async delete(){return false;}},graph});
 const result=await api("POST","/api/brain/conversations/"+convo+"/turn","qa-a",
   {user_message:"모니터",client_action_id:"qa-1"});
 assert.equal(result.status,200);
 if(!result.body.ok)throw Error("unexpected api failure");
 const d=result.body.data as {trace:{totalMs:number;graphWallMs:number}};
 assert.equal(d.trace.totalMs,5);
 assert.ok(d.trace.graphWallMs>=9,"graph timing includes complete mocked delay");
 assert.ok(d.trace.graphWallMs>=d.trace.totalMs);
});
