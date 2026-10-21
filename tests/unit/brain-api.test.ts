import test from "node:test";
import assert from "node:assert/strict";
import {createBrainApi,brainPath} from "../../src/brain/api.ts";

const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mid="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const proof="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function factory(){
 const logs:string[]=[];
 const api=createBrainApi({
  conversations:{
   async create(actorUserId:string){logs.push("create:"+actorUserId);return {id,actorUserId};},
   async assertOwned(actorUserId:string){if(actorUserId!=="user-a")throw Error("not owned");},
   async proposePreference(input){logs.push("propose:"+input.actorUserId);if(input.actorUserId!=="user-a")throw Error("source message not verified or not owned");return proof;},
   async confirmPreference(actorUserId:string,proposalId:string){logs.push("confirm:"+actorUserId);if(actorUserId!=="user-a"||proposalId!==proof)throw Error("confirmation expired, used or not owned");
    return {userId:actorUserId,key:"price_priority" as const,value:"value" as const,sourceConversationId:id,sourceMessageId:mid,updatedAt:"2026-10-16T00:00:00Z"};}
  },
  preferences:{async list(actorUserId:string){logs.push("list:"+actorUserId);return [];},
   async delete(actorUserId:string){logs.push("delete:"+actorUserId);return true;}},
  graph:{async invoke(r){logs.push("invoke:"+r.actorUserId);if(r.actorUserId!=="user-a")throw Error("not owned");return {conversationId:r.conversationId,messageId:mid,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},trace:{totalMs:10}};},
   async getOwnedState(actorUserId:string){logs.push("state:"+actorUserId);if(actorUserId!=="user-a")throw Error("not owned");return {values:{researchResult:{messageId:mid,secret:"NEVER RETURN"}}};}}
 });
 return {api,logs};
}
test("brain endpoints are isolated under /api/brain",()=>{
 assert.equal(brainPath("/api/brain/conversations"),true);
 assert.equal(brainPath("/api/agent/turn"),false);
});
test("untrusted actor does not access any Brain method",async()=>{
 const {api,logs}=factory();
 const r=await api("POST","/api/brain/conversations","",{});
 assert.equal(r.status,401);
 assert.deepEqual(logs,[]);
});

test("Deep remains unavailable and never invokes graph or memory",async()=>{
 const {api,logs}=factory();
 const response=await api("POST","/api/brain/conversations/"+id+"/turn","user-a",
   {user_message:"꼼꼼하게 비교",client_action_id:"deep",execution_mode:"DEEP"});
 assert.equal(response.status,501);assert.deepEqual(logs,[]);
});
test("conversation creation and read-only turn use server actor",async()=>{
 const {api,logs}=factory();
 const c=await api("POST","/api/brain/conversations","user-a",{});
 assert.equal(c.status,201);
 const t=await api("POST","/api/brain/conversations/"+id+"/turn","user-a",
  {user_message:"모니터 추천",client_action_id:"action1",actorUserId:"admin"});
 assert.equal(t.status,200);
 assert.equal((t.body as {ok:true;data:{read_only:boolean}}).data.read_only,true);
 assert.deepEqual(logs,["create:user-a","invoke:user-a"]);
});
test("invalid mutation requests never reach graph or memory",async()=>{
 const {api,logs}=factory();
 const r=await api("POST","/api/brain/conversations/"+id+"/turn","user-a",{user_message:"Hi"});
 assert.equal(r.status,400);
 const p=await api("POST","/api/brain/preferences/proposals","user-a",{conversation_id:id,key:"price_priority",value:"value"});
 assert.equal(p.status,400);
 assert.deepEqual(logs,[]);
});
test("preference proposal and one-shot approval are explicit and actor-scoped",async()=>{
 const {api,logs}=factory();
 const p=await api("POST","/api/brain/preferences/proposals","user-a",{conversation_id:id,source_message_id:mid,key:"price_priority",value:"value"});
 assert.equal(p.status,201);
 const c=await api("POST","/api/brain/preferences/confirm","user-a",{proposal_id:proof});
 assert.equal(c.status,200);
 assert.deepEqual(logs,["propose:user-a","confirm:user-a"]);
});
test("another actor cannot infer state or approval details",async()=>{
 const {api}=factory();
 const state=await api("GET","/api/brain/conversations/"+id+"/state","user-b",{});
 assert.equal(state.status,404);
 const confirm=await api("POST","/api/brain/preferences/confirm","user-b",{proposal_id:proof});
 assert.equal(confirm.status,404); // Cross-user confirmation must not be enumerable.
});
test("state endpoint returns metadata only, never raw checkpoint",async()=>{
 const {api}=factory();
 const res=await api("GET","/api/brain/conversations/"+id+"/state","user-a",{});
 assert.equal(res.status,200);
 assert.doesNotMatch(JSON.stringify(res.body),/NEVER RETURN/);
});

test('turn progress uses the same response envelope without exposing raw graph context',async()=>{
 const previews:unknown[]=[];
 const result={conversationId:id,messageId:mid,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},trace:{totalMs:5},secret:'never expose'};
 const api=createBrainApi({conversations:{} as never,preferences:{} as never,graph:{
  async invoke(_input,observer){observer?.onPreview?.(result);return result;},async getOwnedState(){return {values:{}};},
 }});
 const response=await api('POST','/api/brain/conversations/'+id+'/turn','user-a',{user_message:'상품 추천',client_action_id:'stream'},
  {onPreview:reply=>previews.push(reply)});
 assert.equal(previews.length,1);assert.doesNotMatch(JSON.stringify(previews),/never expose|secret/);
 assert.equal(response.status,200);
 const data=(previews[0] as {body:{ok:true;data:{conversation_id:string;read_only:boolean}}}).body.data;
 assert.equal(data.conversation_id,id);assert.equal(data.read_only,true);
});
