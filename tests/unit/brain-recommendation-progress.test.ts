import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {buildGroundedExplanation} from '../../src/brain/grounded-response.ts';
import type {BrainGraphResult} from '../../src/brain/api.ts';
import type {ProductCandidate} from '../../src/brain/contracts.ts';

function fixture(){
 let release!:()=>void,calls=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const candidates:ProductCandidate[]=[1,2].map(n=>({productId:'p'+n,variantId:'v'+n,productName:'상품 '+n,
  unitPriceWon:10000*n,shippingFeeWon:3000,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
  conditions:{},facets:{},commerceVerified:true,sourceKind:'REAL',datasetVersion:'version'}));
 const graph=createPersistentResearchGraph({datasetVersion:'version',
  conversations:{assertOwned:async actor=>{if(actor!=='u')throw Error('not owned');},appendUserMessage:async()=>crypto.randomUUID()},
  memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
  intent:{extract:async()=>({query:'마스크팩',context:{maxTotalWon:30000,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async()=>({candidates,evidence:[]})},
 },new MemorySaver() as never,undefined,undefined,async input=>{
  calls++;await gate;return {...buildGroundedExplanation(input.ranking,input.evidence,input.plan),text:'최종 추천 설명'};
 });
 const request={actorUserId:'u',conversationId:'c',requestId:'r',clientActionId:'a',userMessage:'3만원 이하 마스크팩 추천'};
 return {graph,request,candidates,release,calls:()=>calls};
}

test('verified recommendation cards arrive before the explanation and final result keeps their IDs and prices',async()=>{
 const f=fixture();let preview:BrainGraphResult|undefined;
 const turn=f.graph.invoke(f.request,{onPreview:result=>{preview=result;}});
 try{
  for(let i=0;i<30&&!preview;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(preview,'preview must not wait for the model');
  assert.equal(f.calls(),1);
  assert.equal(preview.explanation?.kind,'VERIFIED_CANDIDATES');
  assert.ok(preview.ranking.ranked.every(row=>row.candidate.commerceVerified===true));
  assert.doesNotMatch(preview.explanation?.text??'',/최종 추천 설명/);
 }finally{f.release();}
 const final=await turn;
 assert.equal(final.explanation?.text,'최종 추천 설명');
 assert.deepEqual(final.explanation?.items.map(row=>[row.productId,row.variantId,row.totalPriceWon]),
  preview?.explanation?.items.map(row=>[row.productId,row.variantId,row.totalPriceWon]));
 await f.graph.invoke(f.request,{onPreview:()=>assert.fail('replay must not generate another preview')});
 assert.equal(f.calls(),1);
});

test('preview transport failure cannot prevent the final result being saved',async()=>{
 const f=fixture();f.release();
 const final=await f.graph.invoke(f.request,{onPreview:()=>{throw Error('client disconnected');}});
 assert.equal(final.explanation?.text,'최종 추천 설명');
 assert.equal((await f.graph.invoke(f.request)).messageId,final.messageId);
});

test('unowned requests cannot receive previews or invoke the recommendation model',async()=>{
 const f=fixture();
 await assert.rejects(f.graph.invoke({...f.request,actorUserId:'other'},{onPreview:()=>assert.fail('private preview')}),/not owned/);
 assert.equal(f.calls(),0);f.release();
});

test('unverified reference products never become early recommendation cards',async()=>{
 const f=fixture();f.candidates.forEach(candidate=>{candidate.commerceVerified=false;});f.release();
 await f.graph.invoke(f.request,{onPreview:()=>assert.fail('unverified early card')});
});
