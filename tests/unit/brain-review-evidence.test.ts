import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewEvidenceLookup} from '../../src/brain/review-evidence.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';
const rows=[{productId:'p1',variantId:'v1',name:'노프랍 마스크팩',displayIndex:1},{productId:'p2',variantId:'v2',name:'넘버즈인 1번-5번 마스크팩',displayIndex:2}];
const previous={datasetVersion:'dataset',shoppingPlan:{lastDisplayedProducts:rows,lastDisplayedProductIds:['p1','p2']},ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},explanation:{items:[]}} as unknown as ResearchResult;
const catalog={getProduct:async({product_id}:any)=>({ok:true,data:{product:{id:product_id,name:rows.find(r=>r.productId===product_id)?.name,images:[]},variants:[{variant_id:product_id==='p1'?'v1':'v2'}]}}),
 getReviews:async()=>({ok:true,data:{reviews:[]}}),searchProducts:async()=>({ok:true,data:{items:[],has_more:false}})} as any;
test('scoped semantic review lookup preserves selected products and makes one scoped retrieval',async()=>{
 const inputs:any[]=[];const lookup=createReviewEvidenceLookup(catalog,'dataset',async input=>{inputs.push(input);return [];});
 const data=await lookup({request:{productIds:['p1','p2'],semanticQuery:'처음엔 촉촉하지만 나중에 건조',focus:'ALL'},previous,originalQuestion:'이 중에서 찾아줘',requestId:'r',category:'beauty'});
 assert.equal(inputs.length,1);assert.deepEqual(inputs[0].products,rows);
 assert.equal(data.scope,'SEMANTIC_SAMPLES');assert.deepEqual(data.products?.map(p=>p.id),['p1','p2']);assert.equal(data.status,'NO_REVIEWS');
});
test('missing RAG configuration and out-of-scope targets fail without whole-catalog fallback',async()=>{
 const lookup=createReviewEvidenceLookup(catalog,'dataset');
 await assert.rejects(lookup({request:{productId:'p1',focus:'CONS'},previous}),/semantic review unavailable/);
 const calls:any[]=[];const scoped=createReviewEvidenceLookup(catalog,'dataset',async input=>{calls.push(input);return [];});
 await assert.rejects(scoped({request:{productIds:['unknown'],semanticQuery:'단점',focus:'CONS'},previous}),/review target/);
 assert.equal(calls.length,0);
});
test('ordinary single-product overview keeps the existing balanced Commerce lookup',async()=>{
 let searches=0;const lookup=createReviewEvidenceLookup(catalog,'dataset',async()=>{searches++;return [];});
 const data=await lookup({request:{productId:'p1',focus:'ALL'},previous});
 assert.equal(searches,0);assert.equal(data.product?.id,'p1');assert.equal(data.scope,undefined);
});

test('a general summary after semantic results accepts only their same-dataset product IDs',async()=>{
 const lookup=createReviewEvidenceLookup(catalog,'dataset');
 const prior={...previous,shoppingPlan:undefined,explanation:{items:[],reviewSummary:{status:'READY',focus:'ALL',products:[{id:'p1',name:rows[0].name,variantId:'v1'}],evidence:[]}}} as unknown as ResearchResult;
 assert.equal((await lookup({request:{productId:'p1',focus:'ALL'},previous:prior})).product?.id,'p1');
 assert.equal((await lookup({request:{productId:'p2',focus:'ALL'},previous:prior})).status,'NOT_FOUND');
 assert.equal((await lookup({request:{productId:'p1',focus:'ALL'},previous:{...prior,datasetVersion:'old'}})).status,'NOT_FOUND');
});
