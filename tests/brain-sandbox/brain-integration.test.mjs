import test from "node:test";
import assert from "node:assert/strict";
import { PersistentConversations, PersistentPreferences } from "../../src/brain/persistent-store.ts";
import { researchTurn } from "../../src/brain/read-flow.ts";

class FakeDb {
 conversations=new Map();messages=new Map();proposals=new Map();prefs=new Map();
 async query(q,args){
  if(q.startsWith("INSERT INTO shopping_brain.conversations(")){this.conversations.set(args[0],args[1]);return [];}
  if(q.startsWith("SELECT id FROM shopping_brain.conversations"))return this.conversations.get(args[0])===args[1]?[{id:args[0]}]:[];
  if(q.includes("INSERT INTO shopping_brain.messages(")){
   const [id,user,body,action,conv]=args;
   if(this.conversations.get(conv)!==user)return [];
   if([...this.messages.values()].some(x=>x.conv===conv&&x.action===action))return [];
   this.messages.set(id,{id,user,body,action,conv});return [{id}];
  }
  if(q.includes("SELECT m.id,m.content FROM shopping_brain.messages")){
   const [conv,user,action]=args;
   return [...this.messages.values()].filter(x=>x.conv===conv&&x.user===user&&x.action===action).map(x=>({id:x.id,content:x.body}));
  }
  if(q.includes("INSERT INTO shopping_brain.preference_proposals")){
   const [id,conv,user,key,value,source]=args;const msg=this.messages.get(source);
   if(this.conversations.get(conv)!==user||!msg||msg.user!==user||msg.conv!==conv)return [];
   this.proposals.set(id,{conv,user,key,value,source,consumed:false,expired:false});return [{id}];
  }
  if(q.includes("FROM shopping_brain.preference_proposals p JOIN")){
   const [id,user]=args,p=this.proposals.get(id);
   return p&&p.user===user&&!p.expired&&!p.consumed?[{actor_user_id:user,conversation_id:p.conv,source_message_id:p.source,preference_key:p.key,preference_value:p.value}]:[];
  }
  if(q.startsWith("UPDATE shopping_brain.preference_proposals")){this.proposals.get(args[0]).consumed=true;return [];}
  if(q.includes("INSERT INTO shopping_brain.user_preferences")){
   const [user,key,value,conv,msg]=args;this.prefs.set(user+":"+key,{actor_user_id:user,preference_key:key,preference_value:value,source_conversation_id:conv,source_message_id:msg,updated_at:new Date()});return [{updated_at:new Date()}];
  }
  if(q.startsWith("SELECT actor_user_id")&&q.includes("FROM shopping_brain.user_preferences WHERE")){
   return [...this.prefs.values()].filter(x=>x.actor_user_id===args[0]);
  }
  if(q.includes("DELETE FROM shopping_brain.user_preferences")){
   return this.prefs.delete(args[0]+":"+args[1])?[{preference_key:args[1]}]:[];
  }
  throw new Error("unexpected SQL in mock "+q.slice(0,70));
 }
 async transaction(fn){
  const p=new Map([...this.proposals].map(([k,v])=>[k,{...v}])),r=new Map([...this.prefs].map(([k,v])=>[k,{...v}]));
  try{return await fn(this);}catch(e){this.proposals=p;this.prefs=r;throw e;}
 }
}
test("persistent source/confirmation is actor-scoped, one-use and can be deleted",async()=>{
 const db=new FakeDb(),c=new PersistentConversations(db),m=new PersistentPreferences(db);
 const thread=await c.create("user-a");
 await c.assertOwned("user-a",thread.id);
 await assert.rejects(()=>c.assertOwned("user-b",thread.id),/not owned/);
 const mid=await c.appendUserMessage("user-a",thread.id,"action-1","내 선호를 저장해줘");
 assert.equal(await c.appendUserMessage("user-a",thread.id,"action-1","내 선호를 저장해줘"),mid);
 await assert.rejects(()=>c.appendUserMessage("user-a",thread.id,"action-1","modified"),/conflict/);
 await assert.rejects(()=>c.proposePreference({actorUserId:"user-b",conversationId:thread.id,sourceMessageId:mid,key:"price_priority",value:"value"}),/not owned/);
 const proposal=await c.proposePreference({actorUserId:"user-a",conversationId:thread.id,sourceMessageId:mid,key:"price_priority",value:"value"});
 await assert.rejects(()=>c.confirmPreference("user-b",proposal),/not owned/);
 assert.deepEqual(await m.list("user-b"),[]);
 assert.equal((await c.confirmPreference("user-a",proposal)).value,"value");
 await assert.rejects(()=>c.confirmPreference("user-a",proposal),/used/);
 assert.equal((await m.list("user-a"))[0].sourceMessageId,mid);
 const savedPreference=(await m.list("user-a"))[0];
 await assert.rejects(()=>m.put(savedPreference),/confirmed proposal/);
 assert.equal(await m.delete("user-a","price_priority"),true);
 assert.deepEqual(await m.list("user-a"),[]);
});
test("expired proof and transaction failure cannot write preferences",async()=>{
 const db=new FakeDb(),c=new PersistentConversations(db);
 const thread=await c.create("a"),mid=await c.appendUserMessage("a",thread.id,"k","save");
 const proposal=await c.proposePreference({actorUserId:"a",conversationId:thread.id,sourceMessageId:mid,key:"eye_comfort",value:"important"});
 db.proposals.get(proposal).expired=true;
 await assert.rejects(()=>c.confirmPreference("a",proposal),/expired/);
 db.proposals.get(proposal).expired=false;
 const query=db.query.bind(db);db.query=async(q,args)=>{if(q.includes("INSERT INTO shopping_brain.user_preferences"))throw new Error("DB unavailable");return query(q,args);};
 await assert.rejects(()=>c.confirmPreference("a",proposal),/DB unavailable/);
 assert.equal(db.proposals.get(proposal).consumed,false);
});
test("research flow blocks mismatched memory before invoking retrieval",async()=>{
 let called=false;
 const deps={conversations:{assertOwned:async()=>{},appendUserMessage:async()=>"m"},
   memory:{list:async()=>[{userId:"other-user",key:"price_priority",value:"value",sourceConversationId:"c",sourceMessageId:"m",updatedAt:"2026-10-16"}]},
   intent:{extract:async()=>({query:"monitor",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async()=>{called=true;return {candidates:[],evidence:[]};}}};
 await assert.rejects(()=>researchTurn({actorUserId:"me",conversationId:"c",requestId:"r",clientActionId:"k",userMessage:"monitor"},deps),/cross-tenant/);
 assert.equal(called,false);
});
test("read-only research pipeline returns trace and no Commerce writes",async()=>{
 const deps={conversations:{assertOwned:async()=>{},appendUserMessage:async()=>"server-message"},
   memory:{list:async()=>[]},
   intent:{extract:async()=>({query:"monitor",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{price_priority:"value"}}})},
   retriever:{search:async()=>({candidates:[],evidence:[]})}};
 const out=await researchTurn({actorUserId:"me",conversationId:"c",requestId:"r",clientActionId:"k",userMessage:"monitor"},deps);
 assert.equal(out.messageId,"server-message");assert.equal(out.ranking.evaluatedCount,0);assert.ok(out.trace.totalMs>=0);
});
