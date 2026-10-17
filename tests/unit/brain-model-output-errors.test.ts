import test from "node:test";
import assert from "node:assert/strict";
import {createBrainApi} from "../../src/brain/api.ts";
import {parseShoppingIntent,BrainModelOutputError} from "../../src/brain/intent.ts";
import {providerIntentModel} from "../../src/brain/provider-intent.ts";

const id="11111111-1111-4111-8111-111111111111";
const base={
 conversations:{async create(){return {id,actorUserId:"owner"};},
  async assertOwned(){},async proposePreference(){return id;},
  async confirmPreference(){throw Error("unused");}},
 preferences:{async list(){return [];},async delete(){return false;}}
};
const request=(api:ReturnType<typeof createBrainApi>)=>api("POST",
 "/api/brain/conversations/"+id+"/turn","owner",
 {client_action_id:"action1",user_message:"50만원 모니터"});
test("M14 malformed JSON or invalid preferences from LLM must not become user HTTP 400",async()=>{
 for(const raw of ["{not json",JSON.stringify({query:"monitor",maxTotalWon:null,
    requiredConditions:[],currentPreferences:{price_priority:"UNAPPROVED"}})]){
  assert.throws(()=>parseShoppingIntent(raw),BrainModelOutputError);
  const api=createBrainApi({...base,graph:{
   async invoke(){parseShoppingIntent(raw);throw Error("unreachable");},
   async getOwnedState(){return {values:{}};}
  }});
  const result=await request(api);
  assert.equal(result.status,502);
  assert.equal(result.body.ok,false);
  if(!result.body.ok)assert.equal(result.body.error.code,"MODEL_OUTPUT_INVALID");
  assert.doesNotMatch(JSON.stringify(result),/UNAPPROVED|not json|stack/i);
 }
});
test("M14 provider tool-calling or empty output during planning is a typed model error",async()=>{
 const port=providerIntentModel({chat:async()=>({content:"",tool_calls:[{id:"tool",name:"CHECKOUT",arguments:"{}"}]})} as never);
 await assert.rejects(()=>port.complete("system","user"),BrainModelOutputError);
});
test("M14 genuine invalid client action retains 400 while upstream error remains 502",async()=>{
 const api=createBrainApi({...base,graph:{
   async invoke(){throw new BrainModelOutputError("invalid intent JSON token");},
   async getOwnedState(){return {values:{}};}
 }});
 const bad=await api("POST","/api/brain/conversations/"+id+"/turn","owner",{user_message:"Hi"});
 assert.equal(bad.status,400);
 const upstream=await request(api);
 assert.equal(upstream.status,502);
});
