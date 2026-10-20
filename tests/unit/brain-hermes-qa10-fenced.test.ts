import test from "node:test";
import assert from "node:assert/strict";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";
import type {BrainSqlDatabase,BrainSqlRunner} from "../../src/brain/persistent-store.ts";
import type {ResearchResult} from "../../src/brain/read-flow.ts";

type Row=Record<string,unknown>;
function memoryDb():BrainSqlDatabase & {seed(id:string,actor:string):void}{
 const owners=new Map<string,string>();
 const fences=new Map<string,{generation:bigint;published_action_id:string|null;active_attempt_id:string|null}>();
 const receipts=new Map<string,{input_digest:string;status:string;completed_result:unknown;checkpoint_thread_id:string|null;generation:string;attempt_id:string}>();
 const attempts=new Map<string,{conversation_id:string;generation:string;status:string}>();
 const key=(conversationId:string,actionId:string)=>conversationId+"|"+actionId;
 const query=async <T extends Row>(statement:string,args:unknown[]):Promise<T[]>=>{
  const sql=statement.replace(/\s+/g," ").trim().toLowerCase();
  const rows:Row[]=[];
  if(sql.startsWith("select id from shopping_brain.conversations")){
   if(owners.get(String(args[0]))===String(args[1]))rows.push({id:args[0]});
  }else if(sql.startsWith("insert into shopping_brain.turn_fence")){
   if(!fences.has(String(args[0])))fences.set(String(args[0]),{generation:0n,published_action_id:null,active_attempt_id:null});
  }else if(sql.startsWith("select generation,published_action_id from shopping_brain.turn_fence")){
   const row=fences.get(String(args[0]));if(row)rows.push({generation:row.generation.toString(),published_action_id:row.published_action_id});
  }else if(sql.startsWith("select generation,active_attempt_id from shopping_brain.turn_fence")){
   const row=fences.get(String(args[0]));if(row)rows.push({generation:row.generation.toString(),active_attempt_id:row.active_attempt_id});
  }else if(sql.startsWith("select input_digest,status,completed_result,checkpoint_thread_id from shopping_brain.turn_receipts")){
   const row=receipts.get(key(String(args[0]),String(args[1])));
   if(row)rows.push({input_digest:row.input_digest,status:row.status,completed_result:row.completed_result,checkpoint_thread_id:row.checkpoint_thread_id});
  }else if(sql.startsWith("select completed_result,checkpoint_thread_id from shopping_brain.turn_receipts")){
   const row=receipts.get(key(String(args[0]),String(args[1])));
   if(row?.status==="COMPLETED")rows.push({completed_result:row.completed_result,checkpoint_thread_id:row.checkpoint_thread_id});
  }else if(sql.startsWith("update shopping_brain.turn_fence set generation=")){
   const row=fences.get(String(args[0]));if(row){row.generation=BigInt(String(args[1]));row.active_attempt_id=String(args[2]);}
  }else if(sql.startsWith("insert into shopping_brain.turn_receipts(")){
   receipts.set(key(String(args[0]),String(args[1])),{input_digest:String(args[2]),status:"PENDING",completed_result:null,
    checkpoint_thread_id:null,generation:String(args[3]),attempt_id:String(args[4])});
  }else if(sql.startsWith("insert into shopping_brain.turn_attempts(")){
   attempts.set(String(args[0]),{conversation_id:String(args[1]),generation:String(args[3]),status:"PENDING"});
  }else if(sql.startsWith("update shopping_brain.turn_receipts set status='completed'")){
   const row=receipts.get(key(String(args[0]),String(args[1])));
   if(row&&row.input_digest===args[2]&&row.attempt_id===args[3]&&row.generation===String(args[5])&&row.status==="PENDING"){
    row.status="COMPLETED";row.checkpoint_thread_id=String(args[3]);row.completed_result=JSON.parse(String(args[4]));
    rows.push({client_action_id:args[1]});
   }
  }else if(sql.startsWith("update shopping_brain.turn_attempts set status='completed'")){
   const row=attempts.get(String(args[0]));
   if(row&&row.conversation_id===args[1]&&row.generation===String(args[2])&&row.status==="PENDING"){
    row.status="COMPLETED";rows.push({attempt_id:args[0]});
   }
  }else if(sql.startsWith("update shopping_brain.turn_fence set published_action_id=")){
   const row=fences.get(String(args[0]));if(row)row.published_action_id=String(args[1]);
  }else if(sql.startsWith("select r.completed_result,r.checkpoint_thread_id from shopping_brain.turn_fence f")){
   const fence=fences.get(String(args[0]));
   const row=fence?.published_action_id?receipts.get(key(String(args[0]),fence.published_action_id)):undefined;
   if(row?.status==="COMPLETED"&&row.checkpoint_thread_id)
    rows.push({completed_result:row.completed_result,checkpoint_thread_id:row.checkpoint_thread_id});
  }else throw Error("unexpected FencedTurns SQL: "+sql);
  return rows as T[];
 };
 const runner:BrainSqlRunner={query};
 return {query,transaction:async<T>(fn:(tx:BrainSqlRunner)=>Promise<T>)=>fn(runner),
  seed:(id,actor)=>owners.set(id,actor)};
}
const action=(conversationId:string,clientActionId:string,actorUserId="owner")=>({
 actorUserId,conversationId,clientActionId,userMessage:"리뷰 확인"
});
function result(a:ReturnType<typeof action>,intentKind:string,kind:string,withPlan=false):ResearchResult{
 return {conversationId:a.conversationId,messageId:crypto.randomUUID(),clientActionId:a.clientActionId,intentKind:intentKind as never,
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
  ...(withPlan?{shoppingPlan:{query:"세럼",maxTotalWon:null,requiredConditions:[],currentPreferences:{},revision:1}}:{}),
  ...(kind==="REVIEW_SUMMARY"?{reviewSummary:{productId:"p1",name:"세럼",sampled:1,totalMatching:4,
   citations:[{sourceId:"review-1",quote:"피부가 편안해요.",sourceKind:"REAL",sourceVariantId:"option-1"}]}}:{}),
  explanation:{kind:kind as never,text:"확인된 리뷰",items:[],limitations:[]},
  trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:1}};
}

test("fresh REVIEW_SUMMARY without ShoppingPlan publishes and survives replay/latest with review provenance",async()=>{
 const db=memoryDb(),conversationId=crypto.randomUUID();db.seed(conversationId,"owner");
 const fence=new FencedTurns(db),request=action(conversationId,"named");
 const claim=await fence.claim(request);assert.equal(claim.kind,"run");if(claim.kind!=="run")return;
 await fence.publish(request,claim,result(request,"REVIEW_SUMMARY","REVIEW_SUMMARY"));
 const latest=await fence.latest(conversationId);
 assert.equal(latest?.result.shoppingPlan,undefined);
 assert.deepEqual(latest?.result.reviewSummary?.citations,[{sourceId:"review-1",quote:"피부가 편안해요.",sourceKind:"REAL",sourceVariantId:"option-1"}]);
 assert.notEqual(latest?.threadId,conversationId);
 const replay=await fence.claim(request);assert.equal(replay.kind,"replay");
 if(replay.kind==="replay")assert.equal(replay.result.reviewSummary?.productId,"p1");
});

test("review CLARIFICATION without ShoppingPlan publishes and remains canonical",async()=>{
 const db=memoryDb(),conversationId=crypto.randomUUID();db.seed(conversationId,"owner");
 const fence=new FencedTurns(db),request=action(conversationId,"clarify");
 const claim=await fence.claim(request);assert.equal(claim.kind,"run");if(claim.kind!=="run")return;
 await fence.publish(request,claim,result(request,"REVIEW_SUMMARY","CLARIFICATION"));
 const latest=await fence.latest(conversationId);
 assert.equal(latest?.result.intentKind,"REVIEW_SUMMARY");
 assert.equal(latest?.result.explanation?.kind,"CLARIFICATION");
 assert.equal(latest?.result.shoppingPlan,undefined);
});

test("unplanned clarification from another intent is rejected",async()=>{
 const db=memoryDb(),conversationId=crypto.randomUUID();db.seed(conversationId,"owner");
 const fence=new FencedTurns(db),request=action(conversationId,"invalid");
 const claim=await fence.claim(request);assert.equal(claim.kind,"run");if(claim.kind!=="run")return;
 await assert.rejects(()=>fence.publish(request,claim,result(request,"SHOPPING_SEARCH","CLARIFICATION")),/invalid graph result/);
});

test("planless review summary rejects missing product and citation identity fields",async()=>{
 const db=memoryDb(),conversationId=crypto.randomUUID();db.seed(conversationId,"owner");
 const fence=new FencedTurns(db);
 const malformed=[
  (r:ResearchResult)=>{delete r.reviewSummary;},
  (r:ResearchResult)=>{r.reviewSummary!.productId="";},
  (r:ResearchResult)=>{r.reviewSummary!.citations[0].sourceId="";},
  (r:ResearchResult)=>{r.reviewSummary!.citations[0].sourceVariantId=42 as never;},
  (r:ResearchResult)=>{r.reviewSummary!.citations[0].sourceKind="OTHER" as never;},
 ];
 for(let i=0;i<malformed.length;i++){
  const request=action(conversationId,"bad-shape-"+i);
  const claim=await fence.claim(request);assert.equal(claim.kind,"run");if(claim.kind!=="run")continue;
  const invalid=result(request,"REVIEW_SUMMARY","REVIEW_SUMMARY");malformed[i](invalid);
  await assert.rejects(()=>fence.publish(request,claim,invalid),/invalid graph result/);
 }
});

test("foreign owner is rejected and stale generation cannot replace the newer receipt",async()=>{
 const db=memoryDb(),conversationId=crypto.randomUUID();db.seed(conversationId,"owner");
 const fence=new FencedTurns(db),old=action(conversationId,"old"),newer=action(conversationId,"new");
 await assert.rejects(()=>fence.claim({...old,actorUserId:"foreign"}),/not owned or closed/);
 const oldClaim=await fence.claim(old);assert.equal(oldClaim.kind,"run");if(oldClaim.kind!=="run")return;
 await assert.rejects(()=>fence.publish({...old,actorUserId:"foreign"},oldClaim,result(old,"SHOPPING_SEARCH","NO_MATCH",true)),/not owned or closed/);
 const newClaim=await fence.claim(newer);assert.equal(newClaim.kind,"run");if(newClaim.kind!=="run")return;
 await assert.rejects(()=>fence.publish(old,oldClaim,result(old,"SHOPPING_SEARCH","NO_MATCH",true)),/stale turn generation/);
 await fence.publish(newer,newClaim,result(newer,"SHOPPING_SEARCH","NO_MATCH",true));
 assert.equal((await fence.latest(conversationId))?.result.clientActionId,"new");
});

