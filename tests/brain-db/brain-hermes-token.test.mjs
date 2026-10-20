import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createBrainApi} from "../../src/brain/api.ts";

const url=process.env.BRAIN_DATABASE_URL;
const requireBrainCi=()=>{
 if(!url)throw Error("BRAIN_DATABASE_URL must point to the disposable brain_ci database");
 let target;
 try{target=new URL(url);}catch{throw Error("BRAIN_DATABASE_URL must point to the disposable brain_ci database");}
 const hostname=target.hostname.replace(/^\[|\]$/g,"");
 if(!["127.0.0.1","localhost","::1"].includes(hostname)||!["5432","15463"].includes(target.port)||target.pathname!=="/brain_ci")
  throw Error("token integration test requires loopback port 5432 or 15463 database brain_ci");
 return target;
};
const graph={invoke:async()=>{throw Error("unused token test graph");},getOwnedState:async()=>({values:{}})};
const responseFor=(api,actor,proposalId)=>api("POST","/api/brain/preferences/confirm",actor,{proposal_id:proposalId});
const apiFor=(storage)=>{
 const conversations=new PersistentConversations(storage),preferences=new PersistentPreferences(storage);
 return {api:createBrainApi({conversations,preferences,graph}),conversations,preferences};
};
const failingPreferenceSave=(database)=>({
 query:(sql,args)=>database.query(sql,args),
 transaction:(run)=>database.transaction(tx=>run({query:(sql,args)=>{
  if(/^\s*INSERT INTO shopping_brain\.user_preferences\b/i.test(sql))
   throw Error("injected preference save failure");
  return tx.query(sql,args);
 }}))
});
const safeError=(error,url,target)=>{
 let message=error instanceof Error?(error.stack??error.message):String(error);
 for(const secret of [url,target.password,target.username])
  if(secret)message=message.split(secret).join("[redacted]");
 return message;
};

test("real PostgreSQL token confirmation preserves status, single use, and rollback contracts",async t=>{
 const target=requireBrainCi();
 const sql=postgres(url,{max:4,connect_timeout:5});
 try{
  const [identity]=await sql.unsafe("SELECT current_database() AS name");
  assert.equal(identity.name,"brain_ci","token tests may write only to the disposable brain_ci database");
  const storage=brainDatabaseFromPostgres(sql),{api,conversations,preferences}=apiFor(storage);
  const actorPrefix=`hermes-token-${crypto.randomUUID()}`;
  const seed=async(label)=>{
   const actor=`${actorPrefix}-${label}`;
   const conversation=await conversations.create(actor);
   const sourceMessageId=await conversations.appendUserMessage(actor,conversation.id,crypto.randomUUID(),"가성비 선호를 저장해 주세요");
   const proposalId=await conversations.proposePreference({actorUserId:actor,conversationId:conversation.id,
    sourceMessageId,key:"price_priority",value:"value"});
   return {actor,conversationId:conversation.id,proposalId};
  };

  await t.test("used and expired tokens return 409; foreign and missing tokens share 404",async()=>{
   const used=await seed("used");
   assert.equal((await responseFor(api,used.actor,used.proposalId)).status,200);
   const replay=await responseFor(api,used.actor,used.proposalId);
   assert.equal(replay.status,409);
   assert.equal(replay.body.error.code,"CONFIRMATION_REQUIRED");

   const expired=await seed("expired");
   const changed=await sql.unsafe(`UPDATE shopping_brain.preference_proposals
    SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 RETURNING id`,[expired.proposalId]);
   assert.equal(changed.length,1,"the disposable test proposal must be expired in PostgreSQL");
   const expiredResponse=await responseFor(api,expired.actor,expired.proposalId);
   assert.equal(expiredResponse.status,409);
   assert.equal(expiredResponse.body.error.code,"CONFIRMATION_REQUIRED");

   const hidden=await seed("hidden");
   const foreign=await responseFor(api,`${actorPrefix}-other`,hidden.proposalId);
   const missing=await responseFor(api,hidden.actor,crypto.randomUUID());
   assert.equal(foreign.status,404);
   assert.deepEqual(foreign,missing,"an existing foreign token must be indistinguishable from a missing token");
  });

  await t.test("concurrent API confirmations consume a proposal only once",async()=>{
   const item=await seed("concurrent");
   const outcomes=await Promise.all([
    responseFor(api,item.actor,item.proposalId),responseFor(api,item.actor,item.proposalId)
   ]);
   assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
   assert.equal(outcomes.filter(x=>x.status===200).length,1);
   const stored=await preferences.list(item.actor);
   assert.equal(stored.length,1);
   assert.equal(stored[0].value,"value");
   const [proposal]=await sql.unsafe("SELECT consumed_at FROM shopping_brain.preference_proposals WHERE id=$1",[item.proposalId]);
   assert.ok(proposal.consumed_at);
  });

  await t.test("a preference save failure rolls back token consumption",async()=>{
   const item=await seed("rollback");
   const failing=apiFor(failingPreferenceSave(storage));
   const failed=await responseFor(failing.api,item.actor,item.proposalId);
   assert.equal(failed.status,503);
   assert.equal(failed.body.error.code,"BRAIN_UNAVAILABLE");
   const [proposal]=await sql.unsafe("SELECT consumed_at FROM shopping_brain.preference_proposals WHERE id=$1",[item.proposalId]);
   assert.equal(proposal.consumed_at,null,"transaction rollback must restore the token to unused");
   assert.equal((await preferences.list(item.actor)).length,0,"a failed save must not persist a preference");
   assert.equal((await responseFor(api,item.actor,item.proposalId)).status,200,
    "the rolled-back token must remain confirmable");
  });
 }catch(error){
  throw Error(safeError(error,url,target));
 }finally{
  await sql.end({timeout:5});
 }
});
