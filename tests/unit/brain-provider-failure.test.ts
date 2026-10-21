import test from "node:test";
import assert from "node:assert/strict";
import {createBrainApi} from "../../src/brain/api.ts";

const conversationId="11111111-1111-4111-8111-111111111111";
function apiWithError(message:string){
 return createBrainApi({
  conversations:{
   async create(){return {id:conversationId,actorUserId:"owner"};},
   async assertOwned(){},
   async proposePreference(){return conversationId;},
   async confirmPreference(){throw Error("not used");}
  },
  preferences:{async list(){return [];},async delete(){return false;}},
  graph:{
   async invoke(){throw new Error(message);},
   async getOwnedState(){return {values:{}};}
  }
 });
}
const invoke=(api:ReturnType<typeof apiWithError>)=>api("POST",
 "/api/brain/conversations/"+conversationId+"/turn",
 "owner",{client_action_id:"model-qa",user_message:"모니터 추천"});
test("provider HTTP 429 is surfaced as limited request, never as successful plan",async()=>{
 const response=await invoke(apiWithError("LLM http 429"));
 assert.equal(response.status,429);
 assert.equal(response.body.ok,false);
 if(response.body.ok)return;
 assert.equal(response.body.error.code,"MODEL_RATE_LIMIT");
 assert.doesNotMatch(JSON.stringify(response),/token|api_key|traceback/i);
});
test("provider hard timeout returns retryable 504",async()=>{
 const response=await invoke(apiWithError("LLM timeout"));
 assert.equal(response.status,504);
 assert.equal(response.body.ok,false);
 if(response.body.ok)return;
 assert.equal(response.body.error.code,"MODEL_TIMEOUT");
});
test("arbitrary upstream details must remain non-disclosing 503",async()=>{
 const response=await invoke(apiWithError("postgres://secret-token and user PII"));
 assert.equal(response.status,503);
 assert.doesNotMatch(JSON.stringify(response),/postgres|secret-token|PII/);
});
