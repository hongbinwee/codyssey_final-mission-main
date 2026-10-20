import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";
import {createBrainApi} from "../../src/brain/api.ts";

const url=process.env.BRAIN_DATABASE_URL;
function requireIsolatedDatabase(){
 if(!url)throw Error("BRAIN_DATABASE_URL must point to the disposable QA database");
 const target=new URL(url);
 const hostname=target.hostname.replace(/^\[|\]$/g,"");
 if(!["127.0.0.1","localhost","::1"].includes(hostname)||!["15463","5432"].includes(target.port)||target.pathname!=="/brain_ci")
  throw Error("P1-1 integration test requires loopback port 15463 or 5432 database brain_ci");
}
const productName="파넬 시카마누 92세럼 50ml 더블기획";
const product=(id)=>({product:{id,name:id==="p1"?productName:productName+" 다른 구성",brand:"파넬",category:"beauty",description:"",
 images:[],specs:{},active:true,version:1,availability:"AVAILABLE"},
 variants:[{variant_id:id==="p1"?"option-1":"option-2",product_id:id,option_values:{용량:"50ml"},effective_specs:{},
  unit_price_won:22000,stock_qty:4,availability:"AVAILABLE",version:1}],shipping_fee_won:3000});
const reports=id=>({reviews:id==="p1"?[
 {id:"review-positive",product_id:"p1",variant_id:"option-1",rating:5,body:"피부가 편안해서 만족했어요.",
  source_kind:"REAL",source_ref:"commerce",written_at:"2026-10-20T00:00:00.000Z"},
 {id:"review-negative",product_id:"p1",variant_id:null,rating:1,body:"건조해져서 아쉬워요.",
  source_kind:"REAL",source_ref:"commerce",written_at:"2026-10-19T00:00:00.000Z"}]:[
 {id:"review-p2",product_id:"p2",variant_id:"option-2",rating:4,body:"사용감이 부드러워요.",
  source_kind:"REAL",source_ref:"commerce",written_at:"2026-10-18T00:00:00.000Z"}],
 total_matching:8,returned_count:2,next_cursor:null,has_more:false,sort:"LATEST"});

test("QA10 fenced graph publishes fresh, negative-only and clarification reviews with durable replay",async()=>{
 requireIsolatedDatabase();
 const db=postgres(url,{max:4}),locks=postgres(url,{max:2});
 let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try{
  await saver.setup();
  const store=brainDatabaseFromPostgres(db),conversations=new PersistentConversations(store);
  const memory=new PersistentPreferences(store),fencing=new FencedTurns(store);
  const owner="qa10-fenced-"+crypto.randomUUID();
  let reviewReads=0,intentCalls=0,retrievalCalls=0;
  const candidate=(id,price)=>({productId:id,variantId:id==="p1"?"option-1":"option-2",
   productName:id==="p1"?productName:productName+" 다른 구성",unitPriceWon:price,shippingFeeWon:3000,
   rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{},
   sourceKind:"REAL",commerceVerified:true,datasetVersion:"current"});
  const source={
   findProducts:async(query)=>query===productName?
    {items:[{product_id:"p1",name:productName}],hasMore:false}:
    {items:[{product_id:"p1",name:productName},{product_id:"p2",name:productName+" 다른 구성"}],hasMore:false},
   product:async id=>["p1","p2"].includes(id)?product(id):null,
   reviews:async id=>{reviewReads++;return ["p1","p2"].includes(id)?reports(id):null;}
  };
  const deps={datasetVersion:"current",conversations,memory,
   intent:{extract:async()=>{intentCalls++;return {query:"세럼",queryMode:"SET",budgetMode:"CLEAR",
    requirementsMode:"REPLACE",context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};}},
   retriever:{search:async()=>{retrievalCalls++;return {candidates:[candidate("p1",15000),candidate("p2",25000)],evidence:[]};}},
   reviewSummary:source};
  const graphFactory=()=>createPersistentResearchGraph(deps,saver,postgresTurnLock(locks,db),fencing);
  let graph=graphFactory();
  const apiFactory=()=>createBrainApi({conversations,preferences:memory,graph});
  let api=apiFactory();
  const run=(conversationId,clientActionId,userMessage)=>graph.invoke({actorUserId:owner,conversationId,
   requestId:crypto.randomUUID(),clientActionId,userMessage});
  const apiTurn=(conversationId,clientActionId,userMessage)=>api("POST",
   `/api/brain/conversations/${conversationId}/turn`,owner,{client_action_id:clientActionId,user_message:userMessage});

  const api400=await apiTurn(crypto.randomUUID(),"invalid-action","");
  assert.equal(api400.status,400,"invalid turn requests keep the API validation status");

  const namedConversation=await conversations.create(owner);
  const namedResponse=await apiTurn(namedConversation.id,"named-review","파넬 시카마누 92세럼 50ml 더블기획 리뷰 정리해줘");
  assert.equal(namedResponse.status,200);
  const named=namedResponse.body.data;
  assert.equal(named.intent_kind,"REVIEW_SUMMARY");
  assert.equal(named.shopping_plan,null);
  assert.equal(named.review_summary.productId,"p1");
  assert.equal(named.review_summary.citations[0].sourceId,"review-positive");
  assert.equal(named.review_summary.citations[0].sourceVariantId,"option-1");
  assert.equal(named.review_summary.citations[0].sourceKind,"REAL");
  const namedCanonical=await fencing.latest(namedConversation.id);
  assert.equal(namedCanonical.result.clientActionId,"named-review");
  assert.notEqual(namedCanonical.threadId,namedConversation.id);
  const replay=await apiTurn(namedConversation.id,"named-review","파넬 시카마누 92세럼 50ml 더블기획 리뷰 정리해줘");
  assert.equal(replay.status,200);
  assert.equal(replay.body.data.message_id,named.message_id);
  assert.equal(reviewReads,1,"a completed receipt replays without a second review read");

  await saver.end();
  saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  await saver.setup();
  graph=graphFactory();api=apiFactory();
  const restoredReplay=await apiTurn(namedConversation.id,"named-review","파넬 시카마누 92세럼 50ml 더블기획 리뷰 정리해줘");
  assert.equal(restoredReplay.status,200);
  assert.equal(restoredReplay.body.data.message_id,named.message_id,"restarted graph restores the completed receipt");
  assert.equal((await fencing.latest(namedConversation.id)).result.clientActionId,"named-review");
  assert.equal(reviewReads,1,"restoration replays without another review read");

  const negative=await run(namedConversation.id,"negative-review","이 제품 후기에서 단점만 알려줘");
  assert.equal(negative.intentKind,"REVIEW_SUMMARY");
  assert.equal(negative.reviewSummary.productId,"p1");
  assert.deepEqual(negative.reviewSummary.citations.map(row=>row.sourceId),["review-negative"]);
  assert.equal(negative.reviewSummary.citations[0].sourceVariantId,null);
  assert.equal((await fencing.latest(namedConversation.id)).result.clientActionId,"negative-review");
  assert.equal(reviewReads,2,"named and negative-only requests each read reviews once");

  const clarifyConversation=await conversations.create(owner);
  const clarification=await run(clarifyConversation.id,"clarify-review","세럼 리뷰 정리해줘");
  assert.equal(clarification.intentKind,"REVIEW_SUMMARY");
  assert.equal(clarification.explanation.kind,"CLARIFICATION");
  assert.equal(clarification.shoppingPlan,undefined);
  assert.equal(clarification.reviewSummary,undefined);
  assert.equal((await fencing.latest(clarifyConversation.id)).result.explanation.kind,"CLARIFICATION");
  const clarificationReplay=await run(clarifyConversation.id,"clarify-review","세럼 리뷰 정리해줘");
  assert.equal(clarificationReplay.messageId,clarification.messageId);
  assert.equal(reviewReads,2,"ambiguous product clarification does not read review rows");
  assert.equal(intentCalls,0);assert.equal(retrievalCalls,0);

  const ordinalConversation=await conversations.create(owner);
  const recommendation=await run(ordinalConversation.id,"ordinal-recommendation","세럼 추천해줘");
  assert.deepEqual(recommendation.shoppingPlan.lastDisplayedProductIds,["p1","p2"]);
  const ordinal=await run(ordinalConversation.id,"ordinal-review","2번 상품 리뷰 자세히 알려줘");
  assert.equal(ordinal.intentKind,"REVIEW_SUMMARY");
  assert.deepEqual(ordinal.shoppingPlan,JSON.parse(JSON.stringify(recommendation.shoppingPlan)),
   "review turns preserve the prior shopping query, sort/context and displayed product order");
  assert.equal(ordinal.reviewSummary.productId,"p2");
  assert.equal(ordinal.reviewSummary.citations[0].sourceId,"review-p2");
  assert.equal(ordinal.reviewSummary.citations[0].sourceVariantId,"option-2");
  assert.equal(ordinal.reviewSummary.citations[0].sourceKind,"REAL");
  const ordinalCanonical=await fencing.latest(ordinalConversation.id);
  assert.equal(ordinalCanonical.result.clientActionId,"ordinal-review");
  assert.deepEqual(ordinalCanonical.result.shoppingPlan,JSON.parse(JSON.stringify(recommendation.shoppingPlan)));
  assert.equal(reviewReads,3,"ordinal review reads the selected product exactly once");
  assert.equal(intentCalls,1);assert.equal(retrievalCalls,1);
 }finally{await Promise.allSettled([saver.end(),locks.end(),db.end()]);}
});
