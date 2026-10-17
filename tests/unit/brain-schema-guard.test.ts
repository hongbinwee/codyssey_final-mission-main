import test from "node:test";
import assert from "node:assert/strict";
import {requireBrainV9Schema} from "../../src/brain/schema-guard.ts";
const names={db_name:"brain_ci",conversations:"shopping_brain.conversations",
 messages:"shopping_brain.messages",preferences:"shopping_brain.user_preferences",
 fence:"shopping_brain.turn_fence",receipts:"shopping_brain.turn_receipts",rateWindows:"shopping_brain.rate_limit_windows",attempts:"shopping_brain.turn_attempts"};
const fields=[
 ["turn_attempts","attempt_id","uuid"],["turn_attempts","conversation_id","uuid"],
 ["turn_attempts","generation","bigint"],["turn_attempts","status","text"],
 ["rate_limit_windows","scope","text"],["rate_limit_windows","subject_digest","text"],
 ["rate_limit_windows","window_start","timestamp with time zone"],["rate_limit_windows","hits","integer"],
 ["turn_fence","generation","bigint"],["turn_fence","active_attempt_id","uuid"],
 ["turn_fence","published_action_id","text"],["turn_receipts","input_digest","text"],
 ["turn_receipts","generation","bigint"],["turn_receipts","attempt_id","uuid"],
 ["turn_receipts","status","text"],["turn_receipts","checkpoint_thread_id","uuid"],
 ["turn_receipts","completed_result","jsonb"]
].map(([table_name,column_name,data_type])=>({table_name,column_name,data_type}));
const probe=(meta=names,columns=fields)=>({
 async unsafe(sql:string){
  if(sql.includes("information_schema.columns"))return columns;
  return [meta];
 }
});
test("M10 starts only with complete v9 AI schema and matching DB identity",async()=>{
 await requireBrainV9Schema(probe() as never,"brain_ci");
 await assert.rejects(()=>requireBrainV9Schema(probe({...names,attempts:null as string|null} as typeof names) as never,"brain_ci"),/migration required/);
 await assert.rejects(()=>requireBrainV9Schema(probe({...names,receipts:null as string|null} as typeof names) as never,"brain_ci"),/migration required/);
 await assert.rejects(()=>requireBrainV9Schema(probe() as never,"commerce"),/migration required/);
 await assert.rejects(()=>requireBrainV9Schema(probe({...names,rateWindows:null as string|null} as typeof names) as never,"brain_ci"),/migration required/);
 await assert.rejects(()=>requireBrainV9Schema(probe(names,fields.filter(x=>x.column_name!=="generation")) as never,"brain_ci"),/schema incompatible/);
 await assert.rejects(()=>requireBrainV9Schema(probe(names,fields.map(x=>x.column_name==="completed_result"?{...x,data_type:"text"}:x)) as never,"brain_ci"),/schema incompatible/);
});
