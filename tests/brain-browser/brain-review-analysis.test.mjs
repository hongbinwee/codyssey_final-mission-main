import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';
import {createReviewAnalysisLookup} from '../../src/brain/review-analysis.ts';

// Real Graph and browser rendering, isolated Commerce/HTTP fixtures; no DGX or LLM calls.
for(const width of [390,1066])test(`QA13 prior-product review comparison and verified zero, width=${width}`,{timeout:45000},async()=>{
 const conversation='13131313-1313-4131-8131-131313131313';
 const calls={retrieval:0,description:0,reviewProducts:[]};
 let partial=false;
 const candidates=['a','b','c'].map(id=>({productId:`qa13-${id}`,variantId:`qa13-${id}-v`,productName:`상품 ${id.toUpperCase()}`,
  unitPriceWon:10000,shippingFeeWon:0,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
  conditions:{},facets:{},commerceVerified:true,sourceKind:'REAL',datasetVersion:'qa13-browser-fixture'}));
 const ok=data=>({ok:true,data,observed_at:'2026-10-21T00:00:00.000Z',trace_id:'fixture'});
 const catalog={
  getProduct:async({product_id})=>{
   const candidate=candidates.find(row=>row.productId===product_id);assert.ok(candidate);
   return ok({product:{id:product_id,name:candidate.productName,brand:'fixture',category:'beauty',description:'',images:[],specs:{},active:true,version:1,availability:'AVAILABLE'},
    variants:[{variant_id:candidate.variantId,option_values:{},effective_specs:{},unit_price_won:10000,stock_qty:1,availability:'AVAILABLE',version:1}],shipping_fee_won:0});
  },
  getReviews:async({product_id})=>{
   calls.reviewProducts.push(product_id);
   if(partial&&product_id==='qa13-b')throw Error('fixture page unavailable');
   const bodies=product_id==='qa13-a'?['촉촉해서 좋아요.','보습력이 좋아서 만족해요.']:product_id==='qa13-b'?['배송이 빨라요.']:['수분감이 좋아요.'];
   const reviews=bodies.map((body,index)=>({id:`private-review-${product_id}-${index}`,product_id,variant_id:null,body,rating:5,
    source_kind:'REAL',source_ref:`oliveyoung:${product_id}:review:${index+1}`,written_at:'2026-10-21T00:00:00.000Z'}));
   return ok({reviews,total_matching:reviews.length,returned_count:reviews.length,next_cursor:null,has_more:false,sort:'LATEST'});
  },
 };
 const lookup=createReviewAnalysisLookup(catalog,'qa13-browser-fixture');
 const graph=createPersistentResearchGraph({datasetVersion:'qa13-browser-fixture',route:routeBrainMessage,
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[]},
  intent:{extract:async()=>({query:'수분크림',queryMode:'SET',budgetMode:'CLEAR',context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
  retriever:{search:async()=>{calls.retrieval++;return {candidates,evidence:[]};}},reviewAnalysis:lookup,
 },new MemorySaver(),undefined,undefined,async({ranking})=>{
  calls.description++;return {kind:'VERIFIED_CANDIDATES',text:'추천 결과',limitations:[],items:ranking.ranked.map(row=>({
   productId:row.candidate.productId,variantId:row.candidate.variantId,name:row.candidate.productName,totalPriceWon:10000,evidenceIds:[],indicators:[],
  }))};
 });
 const bundle=await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{BrainPreview}from'./src/web/components/BrainPreview.tsx';createRoot(document.getElementById('root')).render(<BrainPreview onClose={()=>{}}/>);",resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
 const css=await readFile('src/web/styles.css','utf8');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width,height:1100}});page.setDefaultTimeout(7000);
  await page.route('http://127.0.0.1:39194/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   const reply=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
   if(path==='/')return route.fulfill({contentType:'text/html',body:`<style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`});
   if(path==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   if(path==='/api/brain/history')return reply({conversationId:conversation,entries:[]});
   if(path==='/api/brain/preferences')return reply([]);
   if(path==='/api/brain/conversations')return reply({conversations:[]});
   if(path.endsWith('/turn')){
    const body=route.request().postDataJSON();
    const output=await graph.invoke({actorUserId:'fixture-qa13',conversationId:conversation,requestId:crypto.randomUUID(),clientActionId:body.client_action_id,userMessage:body.user_message});
    return reply({conversation_id:conversation,message_id:output.messageId,ranking:output.ranking,shopping_plan:output.shoppingPlan,explanation:output.explanation,trace:output.trace});
   }
   throw Error(`Unexpected fixture path ${path}`);
  });
  await page.goto('http://127.0.0.1:39194/');
  const input=page.getByPlaceholder('쇼핑 조건을 입력하세요');
  const send=async message=>{await input.fill(message);await page.getByRole('button',{name:'보내기',exact:true}).click();};
  await send('수분크림 추천해줘');await page.locator('.brain-product-card').nth(2).waitFor();
  await send('1~3순위 촉촉한 리뷰 많은 순으로 비교해줘');
  const result=page.getByRole('region',{name:'리뷰 분석 결과'}).last();
  await result.getByRole('region',{name:'상품 간 리뷰 비교'}).waitFor();
  const table=result.getByRole('table');
  assert.deepEqual(await table.locator('.brain-review-analysis-rank').allTextContents(),['1위','2위','3위']);
  const names=await table.locator('th[scope="rowgroup"]').allTextContents();
  assert.ok(names[0].includes('상품 A'));assert.ok(names[1].includes('상품 C'));assert.ok(names[2].includes('상품 B'));
  assert.match(await table.innerText(),/수집 리뷰/);assert.match(await table.innerText(),/합성 리뷰/);
  assert.doesNotMatch(await result.innerText(),/private-review-|qa13-a-v|datasetVersion/);
  assert.equal(calls.retrieval,1);assert.equal(calls.description,1);
  assert.deepEqual([...new Set(calls.reviewProducts)].sort(),candidates.map(row=>row.productId).sort());
  partial=true;await send('1~3순위 보습력 리뷰 많은 순으로 비교해줘');
  await page.waitForFunction(()=>document.querySelectorAll('.brain-review-analysis').length===2);
  const held=page.getByRole('region',{name:'리뷰 분석 결과'}).last();
  await held.getByText('비교 보류',{exact:true}).first().waitFor();
  assert.equal(await held.locator('.brain-review-analysis-rank').filter({hasText:/^\d+위$/}).count(),0);
  assert.equal(calls.retrieval,1);assert.equal(calls.description,1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 }finally{await browser.close();}
});
