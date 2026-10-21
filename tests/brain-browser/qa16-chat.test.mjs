import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

// Real React component and browser; only HTTP/data/model boundaries are fixtures.
// No service credentials, DB, existing Preview process, or real model calls.
test('chat sends immediately, retries the same action, separates conversations and confirms memory', {timeout:60000}, async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AgentPanel} from './src/web/components/AgentPanel.tsx';const root=createRoot(document.getElementById('root'));const props={brain:'shopping',messages:[],setMessages:()=>{},onOpenProduct:()=>{},onCartChanged:()=>{},onClose:()=>{}};window.setBrainPageContext=context=>root.render(<AgentPanel {...props} pageContext={context}/>);window.setBrainPageContext({screen:'reviews',product_id:'page-review-1'});`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  const requests=[];let release, fail=true, savedValue='balanced', proposals=0, confirms=0, failConfirm=true;const creations=[];let loseCreation=true;
  const response=(conversation,text)=>text==='리뷰 요약 확인'?({
   conversation_id:conversation,message_id:'33333333-3333-4333-8333-333333333333',read_only:true,
   shopping_plan:null,ranking:{ranked:[{candidate:{productId:'fixture',variantId:'variant',productName:'가격 후보',commerceVerified:true,unitPriceWon:10000},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1},
   explanation:{text:'후기 요약 응답이 늦어졌어요.',kind:'REVIEW_SUMMARY',items:[],limitations:[],failure:{code:'MODEL_TIMEOUT'},reviewSummary:{status:'READY',focus:'CONS',product:{id:'fixture',name:'요약 대상 상품',variantId:'variant'},evidence:[{id:'source-review',productId:'fixture',variantId:'variant',kind:'REVIEW',sourceKind:'REAL',verified:true,text:'원문 후기 내용을 그대로 보여요.'}]}},trace:{totalMs:7}
  }):({conversation_id:conversation,message_id:'33333333-3333-4333-8333-333333333333',read_only:true,shopping_plan:{query:text,maxTotalWon:20000,requiredConditions:[],revision:1},ranking:{ranked:[{candidate:{productId:'fixture',variantId:'variant',productName:'상품',commerceVerified:true,unitPriceWon:10000},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1},explanation:{text:'조건을 확인했어요.',kind:'VERIFIED_CANDIDATES',items:[{productId:'fixture',variantId:'variant',evidenceIds:['spec']}],limitations:[]},trace:{totalMs:7}});
  await page.route('http://127.0.0.1:39191/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   const ok=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
   if(p==='/')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/bundle.js"></script>'});
   if(p==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   if(p==='/api/brain/status')return ok({enabled:true});
   if(p==='/api/brain/history')return ok({conversationId:a,entries:[]});
   if(p==='/api/brain/conversations'&&route.request().method()==='GET')return ok({conversations:[{id:b,title:'이전 대화',createdAt:'2026-10-18'},{id:a,title:'첫 대화',createdAt:'2026-10-19'}]});
   if(p==='/api/brain/conversations'){
    creations.push(route.request().postDataJSON());
    if(loseCreation){loseCreation=false;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'NETWORK',message:'lost response'}})});}
    return ok({id:b});
   }
   if(p.endsWith('/history'))return ok({conversationId:b,entries:[{text:'이전 질문',reply:response(b,'이전 질문')}]});
   if(p.endsWith('/turn')){
    const body=route.request().postDataJSON();requests.push(body);
    if(requests.length===1)await new Promise(resolve=>{release=resolve;});
    if(fail){fail=false;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'MODEL_TIMEOUT',message:'internal'}})});}
    return ok(response(p.includes(a)?a:b,body.user_message));
   }
   if(p==='/api/brain/preferences/proposals'){proposals++;return ok({proposal_id:'proposal'});}
   if(p==='/api/brain/preferences/confirm'){
    confirms++;
    if(failConfirm){failConfirm=false;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'CONFLICT',message:'confirm failed'}})});}
    if(confirms===2)return ok({key:'price_priority',value:'value',updatedAt:'2026-10-19'});
    savedValue='performance';return ok({key:'price_priority',value:savedValue,updatedAt:'2026-10-19'});
   }
   if(p==='/api/brain/preferences')return ok([{key:'price_priority',value:savedValue,updatedAt:'2026-10-19'}]);
   throw Error('unexpected fixture path '+p);
  });
  await page.goto('http://127.0.0.1:39191/');
  page.setDefaultTimeout(5000);
  const input=page.getByPlaceholder('쇼핑 조건을 입력하세요');
  await input.waitFor();
  await input.fill('2만원 이하 상품');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await page.locator('.msg.user').getByText('2만원 이하 상품',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),'');
  await page.evaluate(()=>window.setBrainPageContext({screen:'product',product_id:'page-review-2'}));
  assert.equal(await page.getByRole('button',{name:'새 대화 시작'}).isDisabled(),true);
  assert.deepEqual(requests[0].page_context,{screen:'reviews',product_id:'page-review-1'});
  release();
  await page.getByRole('button',{name:'다시 시도',exact:true}).click();
  await page.getByText('조건을 확인했어요.',{exact:true}).waitFor();
  assert.equal(requests.length,2);assert.equal(requests[0].client_action_id,requests[1].client_action_id);
  assert.deepEqual(requests[1].page_context,{screen:'reviews',product_id:'page-review-1'},'retry keeps the original product snapshot after navigation');
  assert.equal(await page.locator('.msg.user').count(),1);
  await input.fill('다른 예산으로 수정');
  await page.getByRole('button',{name:'보내기',exact:true}).click();
  await page.locator('.msg.user').getByText('다른 예산으로 수정',{exact:true}).waitFor();
  await page.getByLabel('가격 선호').waitFor();
  assert.deepEqual(requests[2].page_context,{screen:'product',product_id:'page-review-2'},'new actions use the current product snapshot');
  assert.notEqual(requests[1].client_action_id,requests[2].client_action_id,'edited questions are independent actions');
  await page.getByLabel('가격 선호').selectOption('balanced');
  assert.equal(await page.getByRole('button',{name:'저장하기',exact:true}).count(),0,'an identical saved value cannot create another proposal');
  await page.getByLabel('가격 선호').selectOption('performance');
  await page.getByRole('button',{name:'저장하기',exact:true}).waitFor();
  await page.getByRole('button',{name:'저장하기',exact:true}).evaluate(button=>{
   button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  });
  await page.getByRole('button',{name:'최종 확인',exact:true}).waitFor();
  assert.equal(proposals,1,'a double click creates only one proposal');
  assert.equal(confirms,0,'proposal creation alone does not save the preference');
  assert.equal(savedValue,'balanced');
  await page.getByRole('button',{name:'최종 확인',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'기존에 저장한 기준은 유지돼요'}).waitFor();
  assert.equal(savedValue,'balanced','failed confirmation preserves the prior saved memory');
  assert.equal(await page.getByText('가격 선호: 균형',{exact:true}).count(),1);
  await page.getByRole('button',{name:'다시 확인',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'저장 결과를 선택한 기준과 확인하지 못했어요'}).waitFor();
  assert.equal(savedValue,'balanced','a mismatched successful response does not replace the prior saved memory');
  assert.equal(await page.getByText('가격 선호: 균형',{exact:true}).count(),1);
  await page.getByRole('button',{name:'다시 확인',exact:true}).click();
  await page.getByRole('status').filter({hasText:'저장 완료'}).waitFor();
  assert.equal(confirms,3);assert.equal(savedValue,'performance');
  assert.equal(await page.locator('.brain-memory').getByText(/성능 중심/).count()>0,true);
  await page.getByRole('button',{name:'새 대화 시작',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'대화를 열지 못했어요'}).waitFor();
  assert.equal(await page.locator('.msg.user').count(),2,'failed creation leaves current conversation intact');
  await page.getByRole('button',{name:'새 대화 시작',exact:true}).click();
  await page.getByRole('status').filter({hasText:'새 대화를 시작했어요'}).waitFor();
  assert.equal(typeof creations[0].client_action_id,'string');
  assert.equal(creations[0].client_action_id,creations[1].client_action_id,'lost creation responses reuse creation identity');
  assert.equal(await page.locator('.msg.user').count(),0);
  assert.equal(await page.getByRole('button',{name:'최종 확인',exact:true}).count(),0,'conversation change clears an old confirmation step');
  assert.equal(await page.getByText('저장된 장기 선호',{exact:true}).count(),1);
  await input.fill('리뷰 요약 확인');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await page.getByText('원문 후기 내용을 그대로 보여요.',{exact:true}).waitFor();
  assert.equal(await page.locator('.brain-review-summary').count(),1);
  assert.equal(await page.locator('.brain-products').count(),0,'LLM fallback must not render recommendation price cards');
  assert.equal(await page.locator('.brain-preference-prompt').count(),0);
  assert.equal(await page.getByRole('button',{name:'다른 상품 보기',exact:true}).count(),0);
  await page.getByLabel('이전 대화').selectOption(b);
  await page.locator('.msg.user').getByText('이전 질문',{exact:true}).waitFor();
  assert.equal(await page.getByText('Brain Graph 처리 시간',{exact:false}).count(),0);
 }finally{await browser.close();}
});
