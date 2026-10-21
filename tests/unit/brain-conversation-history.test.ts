import test from "node:test";
import assert from "node:assert/strict";
import {createBrainApi} from "../../src/brain/api.ts";
import {PersistentConversations} from "../../src/brain/persistent-store.ts";
import {readBrainHistory} from "../../src/brain/runtime.ts";

const conversationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const anotherConversationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const messageId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function apiFixture(){
 const calls:string[]=[];
 const api=createBrainApi({
  conversations:{
   async create(actorUserId:string){return {id:conversationId,actorUserId};},
   async assertOwned(actorUserId:string,id:string){
    calls.push(`owned:${actorUserId}:${id}`);
    if(actorUserId!=="actor-a"||id!==conversationId)throw new Error("conversation is not owned");
   },
   async proposePreference(){return messageId;},
   async confirmPreference(){throw new Error("unused");}
  },
  preferences:{async list(){return [];},async delete(){return false;}},
  graph:{async invoke(){throw new Error("unused");},async getOwnedState(){return {values:{}};}},
  listConversations:async(actorUserId:string)=>{
   calls.push(`list:${actorUserId}`);
   return [{id:conversationId,createdAt:"2026-10-19T00:00:00.000Z",title:"모니터 추천"}];
  },
  conversationHistory:async(actorUserId:string,id:string)=>{
   calls.push(`history:${actorUserId}:${id}`);
   return {conversationId:id,entries:[{clientActionId:"action-1",text:"모니터 추천",reply:{message_id:messageId}}]};
  }
 } as never);
 return {api,calls};
}

test("conversation listing returns only the authenticated actor's safe list contract",async()=>{
 const {api,calls}=apiFixture();
 const response=await api("GET","/api/brain/conversations","actor-a",{actorUserId:"attacker"});
 assert.equal(response.status,200);
 assert.deepEqual(response.body,{ok:true,data:{conversations:[{
  id:conversationId,createdAt:"2026-10-19T00:00:00.000Z",title:"모니터 추천"
 }]}});
 assert.deepEqual(calls,["list:actor-a"]);
});

test("selected conversation history checks ownership and returns completed client action ids",async()=>{
 const {api,calls}=apiFixture();
 const response=await api("GET",`/api/brain/conversations/${conversationId}/history`,"actor-a",{actorUserId:"attacker"});
 assert.equal(response.status,200);
 assert.deepEqual(response.body,{ok:true,data:{conversationId,entries:[{
  clientActionId:"action-1",text:"모니터 추천",reply:{message_id:messageId}
 }]}});
 assert.deepEqual(calls,[`owned:actor-a:${conversationId}`,`history:actor-a:${conversationId}`]);
});

test("non-owned and missing conversation histories have the same non-disclosing 404",async()=>{
 const {api,calls}=apiFixture();
 const nonOwned=await api("GET",`/api/brain/conversations/${conversationId}/history`,"actor-b",{});
 const missing=await api("GET",`/api/brain/conversations/${anotherConversationId}/history`,"actor-a",{});
 assert.equal(nonOwned.status,404);
 assert.deepEqual(nonOwned.body,missing.body);
 assert.deepEqual(calls,[`owned:actor-b:${conversationId}`,`owned:actor-a:${anotherConversationId}`]);
});

test("conversation list query is actor-scoped, read-only, and produces bounded safe titles",async()=>{
 const longTitle="한".repeat(100);
 let captured:{sql:string;args:unknown[]}|undefined;
 const db={async query(sql:string,args:unknown[]){
  captured={sql,args};
  return [
   {id:conversationId,created_at:"2026-10-19T00:00:00.000Z",first_user_message:"  모니터\u0000\n추천   "},
   {id:anotherConversationId,created_at:new Date("2026-10-18T00:00:00.000Z"),first_user_message:longTitle},
   {id:messageId,created_at:"2026-10-17T00:00:00.000Z",first_user_message:null}
  ];
 },async transaction(){throw new Error("unexpected transaction");}};
 const actor="actor-a'; SELECT * FROM shopping_brain.user_preferences; --";
 const conversations=await new PersistentConversations(db as never).list(actor);
 assert.deepEqual(captured?.args,[actor]);
 assert.match(captured?.sql??"",/c\.actor_user_id=\$1 AND c\.closed_at IS NULL/);
 assert.match(captured?.sql??"",/m\.role='user'/);
 assert.match(captured?.sql??"",/ORDER BY c\.created_at DESC,c\.id DESC/);
 assert.doesNotMatch(captured?.sql??"",/INSERT|UPDATE|DELETE/i);
 assert.deepEqual(conversations,[
  {id:conversationId,createdAt:"2026-10-19T00:00:00.000Z",title:"모니터 추천"},
  {id:anotherConversationId,createdAt:"2026-10-18T00:00:00.000Z",title:"한".repeat(79)+"…"},
  {id:messageId,createdAt:"2026-10-17T00:00:00.000Z",title:null}
 ]);
});

test("selected history reads only an owned conversation and preserves receipt action identity",async()=>{
 const calls:{sql:string;args?:unknown[]}[]=[];
 const receipt={conversationId,messageId,clientActionId:"action-1",
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
  shoppingPlan:{query:"모니터",maxTotalWon:500000,requiredConditions:["USB-C"],revision:2},
  explanation:{text:"조건에 맞는 후보가 있어요.",kind:"GROUNDED"},trace:{totalMs:12},internalContext:"PRIVATE"};
 const db={async unsafe(sql:string,args?:unknown[]){
  calls.push({sql,args});
  if(sql.includes("SELECT id FROM shopping_brain.conversations"))
   return args?.[0]===conversationId&&args?.[1]==="actor-a"?[{id:conversationId}]:[];
  return [{message_id:messageId,client_action_id:"action-1",content:"모니터 추천",completed_result:JSON.stringify(receipt)}];
 }};
 const history=await readBrainHistory(db as never,"actor-a",conversationId);
 assert.deepEqual(history,{conversationId,entries:[{
  clientActionId:"action-1",text:"모니터 추천",reply:{conversation_id:conversationId,message_id:messageId,read_only:true,
   ranking:receipt.ranking,shopping_plan:receipt.shoppingPlan,intent_kind:undefined,
   explanation:receipt.explanation,trace:receipt.trace}
 }]});
 assert.deepEqual(calls[0].args,[conversationId,"actor-a"]);
 assert.deepEqual(calls[1].args,[conversationId,"actor-a"]);
 assert.doesNotMatch(JSON.stringify(history),/PRIVATE/);
});

test("selected history refuses another actor before reading its transcript",async()=>{
 let queries=0;
 const db={async unsafe(){queries++;return [];}};
 await assert.rejects(()=>readBrainHistory(db as never,"actor-b",conversationId),/conversation is not owned/);
 assert.equal(queries,1);
});
