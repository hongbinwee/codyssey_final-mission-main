import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';
import type {ProductCandidate} from '../../src/brain/contracts.ts';
import type {ReviewAnalysisData} from '../../src/brain/review-analysis.ts';

// MAIN integration checks: real graph/checkpointer, isolated ports and no external calls.
function fixture(){
 const owners=new Map([['dialog-a','tester_05'],['dialog-b','tester_05'],['dialog-other','other-user']]);
 const calls:{lookups:string[][];writes:number;searches:number}={lookups:[],writes:0,searches:0};
 const candidate:ProductCandidate={productId:'shown-product',variantId:'shown-option',productName:'수분크림',
  commerceVerified:true,sourceKind:'REAL',datasetVersion:'qa13-dataset',unitPriceWon:10000,shippingFeeWon:3000,
  rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{}};
 const graph=createPersistentResearchGraph({datasetVersion:'qa13-dataset',route:routeBrainMessage,
  conversations:{assertOwned:async(actor,id)=>{if(owners.get(id)!==actor)throw Error('conversation is not owned');},
   appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[],put:async()=>{calls.writes++;},delete:async()=>{calls.writes++;return false;}},
  intent:{extract:async()=>({query:'수분크림',queryMode:'SET',budgetMode:'CLEAR',
   context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async()=>{calls.searches++;return {candidates:[candidate],evidence:[]};}},
  reviewAnalysis:async({request,products})=>{calls.lookups.push(products.map(p=>p.productId));return {
   status:'READY',method:'CONSERVATIVE_RULES',datasetVersion:'qa13-dataset',aspect:'moisturizing',aspectLabel:'보습력',
   focus:request.focus,compare:request.compare,products:[],
  } satisfies ReviewAnalysisData;},
 },new MemorySaver() as never,undefined,undefined,async()=>({kind:'VERIFIED_CANDIDATES',text:'추천 상품',limitations:[],
  items:[{productId:candidate.productId,variantId:candidate.variantId,name:'수분크림',totalPriceWon:13000,evidenceIds:[],indicators:[]}]}));
 const turn=(conversationId:string,message:string,action:string,actor='tester_05')=>graph.invoke({
  actorUserId:actor,conversationId,userMessage:message,clientActionId:action,requestId:crypto.randomUUID()});
 return {calls,graph,turn};
}

test('QA13 lookup cannot borrow displayed products from another conversation or user',async()=>{
 const f=fixture();await f.turn('dialog-a','수분크림 추천해줘','recommend');
 const missing=await f.turn('dialog-b','1순위 보습력 리뷰 찾아줘','no-target');
 assert.equal(missing.explanation?.reviewAnalysis?.status,'NEEDS_TARGET');
 assert.deepEqual(f.calls.lookups,[]);
 await assert.rejects(f.turn('dialog-a','1순위 보습력 리뷰 찾아줘','wrong-owner','other-user'),/not owned/);
 await assert.rejects(f.graph.getOwnedState('other-user','dialog-a'),/not owned/);
 assert.deepEqual(f.calls.lookups,[]);
 await f.turn('dialog-a','1순위 보습력 리뷰 찾아줘','owned');
 assert.deepEqual(f.calls.lookups,[['shown-product']]);
 assert.equal(f.calls.searches,1,'review follow-ups must not start another product retrieval');
 assert.equal(f.calls.writes,0,'review analysis cannot write long-term preferences');
});

test('QA13 completed action replays without another catalog lookup; changed input conflicts',async()=>{
 const f=fixture();await f.turn('dialog-a','수분크림 추천해줘','recommend');
 const first=await f.turn('dialog-a','1순위 보습력 리뷰 찾아줘','review-once');
 const replay=await f.turn('dialog-a','1순위 보습력 리뷰 찾아줘','review-once');
 assert.deepEqual(replay,first);assert.equal(f.calls.lookups.length,1);
 await assert.rejects(f.turn('dialog-a','1순위 보습력이 부족한 리뷰 찾아줘','review-once'),/duplicate action conflict/);
 assert.equal(f.calls.lookups.length,1);assert.equal(f.calls.writes,0);
});
