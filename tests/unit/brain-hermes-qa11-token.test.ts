import test from "node:test";
import assert from "node:assert/strict";
import type {BrainSqlDatabase,BrainSqlRunner} from "../../src/brain/persistent-store.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createBrainApi} from "../../src/brain/api.ts";
import type {PreferenceValue} from "../../src/brain/contracts.ts";

const asRows=<T extends Record<string,unknown>>(rows:Record<string,unknown>[]):T[]=>rows as unknown as T[];

type Conversation={id:string;actor:string;closed:boolean};
type Message={id:string;conversation:string;actor:string;role:string;content:string;actionId:string};
type Proposal={id:string;actor:string;conversation:string;message:string;key:string;value:string;expiresAt:number;consumedAt:number|null};
type PreferenceRow={actor:string;key:string;value:string;conversation:string;message:string;updatedAt:Date};

class MemoryBrainDatabase implements BrainSqlDatabase {
 readonly conversations=new Map<string,Conversation>();
 readonly messages=new Map<string,Message>();
 readonly proposals=new Map<string,Proposal>();
 readonly preferences=new Map<string,PreferenceRow>();
 failNextPreferenceWrite=false;
 private transactionTail:Promise<void>=Promise.resolve();
 async transaction<T>(fn:(tx:BrainSqlRunner)=>Promise<T>):Promise<T>{
  const previous=this.transactionTail;
  let release!:()=>void;
  this.transactionTail=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  const proposalSnapshot=new Map([...this.proposals].map(([id,row])=>[id,{...row}]));
  const preferenceSnapshot=new Map([...this.preferences].map(([key,row])=>[key,{...row}]));
  try{return await fn(this);}catch(error){
   this.proposals.clear();for(const [id,row] of proposalSnapshot)this.proposals.set(id,row);
   this.preferences.clear();for(const [key,row] of preferenceSnapshot)this.preferences.set(key,row);
   throw error;
  }finally{release();}
 }
 async query<T extends Record<string,unknown>>(sql:string,args:unknown[]):Promise<T[]>{
  if(sql.startsWith("INSERT INTO shopping_brain.conversations")){
   const [id,actor]=args as [string,string];
   if(!this.conversations.has(id))this.conversations.set(id,{id,actor,closed:false});
   return [];
  }
  if(sql.startsWith("SELECT id FROM shopping_brain.conversations")){
   const [id,actor]=args as [string,string],row=this.conversations.get(id);
   return asRows(row&&row.actor===actor&&!row.closed?[{id}]:[]);
  }
  if(sql.startsWith("INSERT INTO shopping_brain.messages")){
   const [id,actor,content,actionId,conversationId]=args as [string,string,string,string,string];
   const row=this.conversations.get(conversationId);
   if(row&&row.actor===actor&&!row.closed){
    this.messages.set(id,{id,conversation:conversationId,actor,role:"user",content,actionId});
    return asRows([{id}]);
   }
   return [];
  }
  if(sql.startsWith("INSERT INTO shopping_brain.preference_proposals")){
   const [id,conversationId,actor,key,value,messageId]=args as [string,string,string,string,string,string];
   const conversation=this.conversations.get(conversationId),message=this.messages.get(messageId);
   if(conversation&&conversation.actor===actor&&!conversation.closed&&message&&message.actor===actor&&message.conversation===conversationId&&message.role==="user"){
    this.proposals.set(id,{id,actor,conversation:conversationId,message:messageId,key,value,expiresAt:Date.now()+600_000,consumedAt:null});
    return asRows([{id}]);
   }
   return [];
  }
  if(sql.includes("FROM shopping_brain.preference_proposals p JOIN shopping_brain.conversations c")){
   const [id,actor]=args as [string,string],proposal=this.proposals.get(id),conversation=proposal&&this.conversations.get(proposal.conversation);
   if(proposal&&proposal.actor===actor&&conversation?.actor===actor&&!conversation.closed)
    return asRows([{actor_user_id:proposal.actor,conversation_id:proposal.conversation,source_message_id:proposal.message,
     preference_key:proposal.key,preference_value:proposal.value,consumed_at:proposal.consumedAt===null?null:new Date(proposal.consumedAt)}]);
   return [];
  }
  if(sql.startsWith("UPDATE shopping_brain.preference_proposals SET consumed_at=clock_timestamp()")){
   const [id,actor]=args as [string,string],proposal=this.proposals.get(id);
   if(proposal?.actor===actor&&proposal.consumedAt===null&&proposal.expiresAt>Date.now()){
    proposal.consumedAt=Date.now();return asRows([{id}]);
   }
   return [];
  }
  if(sql.startsWith("INSERT INTO shopping_brain.user_preferences")){
   if(this.failNextPreferenceWrite){this.failNextPreferenceWrite=false;throw new Error("simulated preference write failure");}
   const [actor,key,value,conversation,message]=args as [string,string,string,string,string],updatedAt=new Date();
   this.preferences.set(`${actor}:${key}`,{actor,key,value,conversation,message,updatedAt});
   return asRows([{updated_at:updatedAt}]);
  }
  if(sql.startsWith("SELECT actor_user_id,preference_key,preference_value,source_conversation_id,source_message_id,updated_at")){
   const [actor]=args as [string];
   return asRows([...this.preferences.values()].filter(row=>row.actor===actor).map(row=>({actor_user_id:row.actor,
    preference_key:row.key,preference_value:row.value,source_conversation_id:row.conversation,
    source_message_id:row.message,updated_at:row.updatedAt})));
  }
  if(sql.startsWith("DELETE FROM shopping_brain.user_preferences")){
   const [actor,key]=args as [string,string],deleted=this.preferences.delete(`${actor}:${key}`);
   return asRows(deleted?[{preference_key:key}]:[]);
  }
  throw new Error(`unexpected SQL in token regression: ${sql}`);
 }
}

const messageActionId="token-regression-message";
const uuid=(n:number)=>`${String(n).padStart(8,"0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

async function setup(){
 const db=new MemoryBrainDatabase(),conversations=new PersistentConversations(db),preferences=new PersistentPreferences(db);
 const owned=await conversations.create("actor-a");
 const messageId=await conversations.appendUserMessage("actor-a",owned.id,messageActionId,"기준을 기억해 주세요");
 const graph={invoke:async()=>{throw new Error("unused");},getOwnedState:async()=>({values:{}})};
 const api=createBrainApi({conversations,preferences,graph});
 const proposal=async(actor="actor-a",value:PreferenceValue="balanced")=>conversations.proposePreference({actorUserId:actor,
  conversationId:owned.id,sourceMessageId:messageId,key:"price_priority",value});
 return {db,api,proposal};
}
const confirm=(api:ReturnType<typeof createBrainApi>,actor:string,proposalId:string)=>
 api("POST","/api/brain/preferences/confirm",actor,{proposal_id:proposalId});

test("QA11 token: own consumed and expired confirmations require confirmation again",async()=>{
 const {db,api,proposal}=await setup(),consumedId=await proposal(),expiredId=await proposal("actor-a","value");
 assert.equal((await confirm(api,"actor-a",consumedId)).status,200);
 const consumed=await confirm(api,"actor-a",consumedId);
 assert.deepEqual(consumed,{status:409,body:{ok:false,error:{code:"CONFIRMATION_REQUIRED",message:"선호 확인이 만료되었거나 완료되었습니다"}}});
 const expired=db.proposals.get(expiredId)!;expired.expiresAt=Date.now()-1;
 const response=await confirm(api,"actor-a",expiredId);
 assert.deepEqual(response,{status:409,body:{ok:false,error:{code:"CONFIRMATION_REQUIRED",message:"선호 확인이 만료되었거나 완료되었습니다"}}});
 assert.equal(db.preferences.get("actor-a:price_priority")?.value,"balanced");
 assert.equal(expired.consumedAt,null);
});

test("QA11 token: another actor and an unknown token have identical non-disclosing 404 responses",async()=>{
 const {db,api,proposal}=await setup(),ownedId=await proposal(),missingId=uuid(23);
 const foreign=await confirm(api,"actor-b",ownedId),missing=await confirm(api,"actor-a",missingId);
 assert.equal(foreign.status,404);
 assert.equal((foreign.body as {ok:false;error:{code:string}}).error.code,"NOT_FOUND");
 assert.deepEqual(foreign,missing);
 assert.equal(db.proposals.get(ownedId)?.consumedAt,null);
 assert.equal(db.preferences.size,0);
});

test("QA11 token: simultaneous confirmation consumes once and preserves atomic preference write",async()=>{
 const {db,api,proposal}=await setup(),id=await proposal("actor-a","performance");
 const results=await Promise.all([confirm(api,"actor-a",id),confirm(api,"actor-a",id)]);
 assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
 assert.equal(db.proposals.get(id)?.consumedAt!==null,true);
 assert.equal(db.preferences.get("actor-a:price_priority")?.value,"performance");
});

test("QA11 token: a failed preference write rolls back token consumption",async()=>{
 const {db,api,proposal}=await setup(),id=await proposal();db.failNextPreferenceWrite=true;
 assert.equal((await confirm(api,"actor-a",id)).status,503);
 assert.equal(db.proposals.get(id)?.consumedAt,null);
 assert.equal(db.preferences.size,0);
 assert.equal((await confirm(api,"actor-a",id)).status,200);
 assert.equal(db.proposals.get(id)?.consumedAt!==null,true);
});

test("closed or foreign fenced conversation remains a non-disclosing 404",async()=>{
 const api=createBrainApi({
  conversations:{create:async(actorUserId:string)=>({id:uuid(31),actorUserId}),assertOwned:async()=>{},
   proposePreference:async()=>uuid(32),confirmPreference:async()=>{throw new Error("unused");}},
  preferences:{list:async()=>[],delete:async()=>false},
  graph:{invoke:async()=>{throw new Error("conversation is not owned or closed");},getOwnedState:async()=>({values:{}})}
 } as never);
 const response=await api("POST",`/api/brain/conversations/${uuid(31)}/turn`,"actor-a",
  {user_message:"상품 추천해줘",client_action_id:"closed-or-foreign"});
 assert.equal(response.status,404);
 assert.deepEqual(response,{status:404,body:{ok:false,error:{code:"NOT_FOUND",message:"대화를 찾을 수 없습니다"}}});
});

