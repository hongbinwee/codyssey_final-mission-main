import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {FencedTurns} from '../../src/brain/fenced-turns.ts';
import type {BrainSqlDatabase,BrainSqlRunner} from '../../src/brain/persistent-store.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';
const action={actorUserId:'actor',conversationId:'conversation',clientActionId:'same-action',userMessage:'이 제품 후기 정리해줘'};
const result:ResearchResult={conversationId:'conversation',messageId:'message',clientActionId:'same-action',
 ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},intentKind:'REVIEW_SUMMARY',
 explanation:{kind:'REVIEW_SUMMARY',text:'상품 후기',items:[],limitations:[]},
 trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:0}};
function fixture(){
 let receipt:{input_digest:string;status:string;completed_result?:ResearchResult;checkpoint_thread_id?:string}|undefined;
 const tx:BrainSqlRunner={async query<T extends Record<string,unknown>>(sql:string,args:unknown[]):Promise<T[]>{
  let rows:Record<string,unknown>[]=[];
  if(sql.startsWith('SELECT id FROM'))rows=[{id:'conversation'}];
  else if(sql.startsWith('SELECT generation,published_action_id'))rows=[{generation:1,published_action_id:null}];
  else if(sql.startsWith('SELECT input_digest'))rows=receipt?[receipt]:[];
  else if(sql.startsWith('INSERT INTO shopping_brain.turn_receipts'))receipt={input_digest:String(args[2]),status:'PENDING'};
  return rows as T[];
 }};
 const db:BrainSqlDatabase={...tx,transaction:async fn=>fn(tx)};
 return {fences:new FencedTurns(db),get receipt(){return receipt;},complete(){receipt={...receipt!,status:'COMPLETED',completed_result:result,checkpoint_thread_id:'attempt'};}};
}
test('QA10 fenced receipts bind the normalized product page without changing old no-context fingerprints',async()=>{
 const legacy=fixture();await legacy.fences.claim(action);
 assert.equal(legacy.receipt!.input_digest,createHash('sha256').update(JSON.stringify(Object.values(action))).digest('hex'));
 legacy.complete();assert.equal((await legacy.fences.claim(action)).kind,'replay');
 const f=fixture();const contextual={...action,pageContext:{screen:'product',product_id:'p-one'}};
 await f.fences.claim(contextual);f.complete();
 assert.equal((await f.fences.claim(contextual)).kind,'replay');
 await assert.rejects(()=>f.fences.claim({...action,pageContext:{screen:'product',product_id:'p-two'}}),/duplicate action conflict/);
});
test('QA10 summary-only receipts replay without requiring or inventing a shopping plan',async()=>{
 const f=fixture();await f.fences.claim(action);f.complete();
 const replay=await f.fences.claim(action);assert.equal(replay.kind,'replay');
 if(replay.kind==='replay'){assert.equal(replay.result.shoppingPlan,undefined);assert.equal(replay.result.explanation!.kind,'REVIEW_SUMMARY');}
});
