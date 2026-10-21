import test from "node:test";
import assert from "node:assert/strict";
import {createBrainApi} from "../../src/brain/api.ts";
import {PersistentConversations} from "../../src/brain/persistent-store.ts";

function fakeDatabase(){
 const rows=new Map<string,string>(),statements:string[]=[];
 const db={
  async query(sql:string,args:unknown[]){
   statements.push(sql);
   if(sql.startsWith("INSERT INTO shopping_brain.conversations")){
    const [id,actor]=args as [string,string];
    if(!rows.has(id))rows.set(id,actor);
    return [];
   }
   if(sql.startsWith("SELECT id FROM shopping_brain.conversations")){
    const [id,actor]=args as [string,string];
    return rows.get(id)===actor?[{id}]:[];
   }
   throw new Error("unexpected query");
  },
  async transaction(){throw new Error("unexpected transaction");}
 };
 return {db,rows,statements};
}

function apiFor(conversations:PersistentConversations){
 return createBrainApi({
  conversations,
  preferences:{async list(){return [];},async delete(){return false;}},
  graph:{async invoke(){throw new Error("unused");},async getOwnedState(){return {values:{}};}}
 });
}

function idFrom(result:Awaited<ReturnType<ReturnType<typeof createBrainApi>>>){
 assert.equal(result.status,201);
 assert.equal(result.body.ok,true);
 if(!result.body.ok)throw new Error("expected conversation creation success");
 return (result.body.data as {id:string;actorUserId:string}).id;
}

test("repeated creation action after a lost response returns the same actor-scoped v8 ID",async()=>{
 const {db,rows,statements}=fakeDatabase();
 const api=apiFor(new PersistentConversations(db as never));
 const action="create-action-01";
 await api("POST","/api/brain/conversations","actor-a",{client_action_id:action}); // Simulate a committed insert whose response was lost.
 const firstId=rows.keys().next().value;
 assert.ok(firstId);
 const retry=await api("POST","/api/brain/conversations","actor-a",{client_action_id:action});
 const retryId=idFrom(retry);
 const otherActor=await api("POST","/api/brain/conversations","actor-b",{client_action_id:action});
 const otherActorId=idFrom(otherActor);
 assert.equal(retryId,firstId);
 assert.notEqual(otherActorId,firstId);
 assert.match(firstId,/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 assert.equal(rows.size,2);
 const inserts=statements.filter(sql=>sql.startsWith("INSERT INTO shopping_brain.conversations"));
 assert.equal(inserts.length,3);
 assert.ok(inserts.every(sql=>/VALUES\(\$1,\$2\) ON CONFLICT DO NOTHING/i.test(sql)));
});

test("canonical actor and action encoding separates concatenation-collision pairs",async()=>{
 const {db}=fakeDatabase();
 const conversations=new PersistentConversations(db as never);
 const first=await conversations.create("ab","c");
 const firstRetry=await conversations.create("ab","c");
 const second=await conversations.create("a","bc");
 const secondRetry=await conversations.create("a","bc");
 assert.equal(first.id,firstRetry.id);
 assert.equal(second.id,secondRetry.id);
 assert.notEqual(first.id,second.id);
});

test("legacy empty-body creation remains random and creates a new conversation each time",async()=>{
 const {db,rows}=fakeDatabase();
 const api=apiFor(new PersistentConversations(db as never));
 const first=idFrom(await api("POST","/api/brain/conversations","actor-a",{}));
 const second=idFrom(await api("POST","/api/brain/conversations","actor-a",{}));
 assert.notEqual(first,second);
 assert.match(first,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 assert.equal(rows.size,2);
});

test("creation accepts only an optional bounded action ID and never trusts body actor or ID fields",async()=>{
 const {db,rows}=fakeDatabase();
 const api=apiFor(new PersistentConversations(db as never));
 const valid=await api("POST","/api/brain/conversations","session-actor",{client_action_id:"x".repeat(128)});
 assert.equal(valid.status,201);
 const invalidBodies=[
  {client_action_id:"x".repeat(129)},
  {client_action_id:"  "},
  {client_action_id:"x",actorUserId:"attacker"},
  {client_action_id:"x",actor_user_id:"attacker"},
  {id:"11111111-1111-4111-8111-111111111111"},
  [],
  null
 ];
 for(const body of invalidBodies){
  const response=await api("POST","/api/brain/conversations","session-actor",body);
  assert.equal(response.status,400);
 }
 assert.equal(rows.size,1);
 assert.deepEqual([...rows.values()], ["session-actor"]);
});

test("store rejects invalid optional action IDs before writing",async()=>{
 const {db,rows}=fakeDatabase();
 const conversations=new PersistentConversations(db as never);
 await assert.rejects(()=>conversations.create("actor-a"," "),/invalid/);
 await assert.rejects(()=>conversations.create("actor-a","x".repeat(129)),/invalid/);
 assert.equal(rows.size,0);
});
