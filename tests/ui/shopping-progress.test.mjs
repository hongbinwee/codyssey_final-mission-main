import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {chromium,expect} from '@playwright/test';

// Actual React bundle, isolated mock APIs; no live DB, model or external network.
test('home displays first page while complete-only views and counts wait; failure and remount are safe', {timeout:60000}, async()=>{
 const assets=new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],['/web/app.js','web/app.js','text/javascript'],['/web/styles.css','src/web/styles.css','text/css']
 ].map(async([url,path,type])=>[url,{body:await readFile(path),type}])));
 let release=()=>{},pageCalls=0,firstAt=0,fail=false,pending=false;
 const item=(id,name,category)=>({product_id:id,name,brand:'QA',category,image:null,matched_variants:[],rating_summary:{avg:null,count:0},availability:'AVAILABLE'});
 const first=item('first','처음 도착한 상품','beauty'),second=item('second','다음 페이지 상품','food');
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const reply=b=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(b));};
  if(url.pathname==='/api/session')return reply({ok:true,user:{id:'fixture',display_name:'QA'}});
  if(url.pathname==='/api/catalog/context')return reply({ok:true,data:{read_only:true,is_simulated:true,cart_enabled:false,wishlist_enabled:false}});
  if(url.pathname==='/api/brain/status')return reply({ok:true,data:{enabled:false}});
  if(url.pathname==='/api/products'){
   pageCalls++;
   if(!url.searchParams.has('cursor')){firstAt=Date.now();return reply({ok:true,data:{items:[first],has_more:true,next_cursor:'second',shipping_fee_won:0}});}
   pending=true;release=()=>{pending=false;release=()=>{};if(!res.writableEnded)reply(fail?{ok:false,error:{code:'NETWORK',message:'failed'}}:{ok:true,data:{items:[second],has_more:false,next_cursor:null,shipping_fee_won:0}});};
   return;
  }
  const asset=assets.get(url.pathname);if(asset){res.writeHead(200,{'content-type':asset.type});return res.end(asset.body);}
  res.writeHead(404);res.end();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch();const page=await browser.newPage();
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 try{
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.getByText('처음 도착한 상품',{exact:true}).waitFor({timeout:3000});
  assert.ok(Date.now()-firstAt<3000,'first product must not wait for the held next page');
  assert.equal(pageCalls,2);
  assert.equal(await page.getByText('상품을 더 불러오는 중이에요.').count(),1);
  assert.equal(await page.locator('.benefit-chip').count(),0,'partial catalog must not claim the global maximum');
  await page.getByRole('button',{name:'카테고리',exact:true}).first().click();
  assert.equal(await page.locator('.sub-count').count(),0,'partial counts stay out of category filters');
  await page.locator('.bottom-nav button').first().click();
  await page.getByText('처음 도착한 상품',{exact:true}).waitFor();
  await expect.poll(()=>pending).toBe(true);release();
  await page.getByText('다음 페이지 상품',{exact:true}).waitFor();
  await page.getByText('상품을 더 불러오는 중이에요.').waitFor({state:'hidden'});
  assert.equal(await page.locator('.benefit-chip').count(),1);
  fail=true;
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByText('처음 도착한 상품',{exact:true}).waitFor();
  await expect.poll(()=>pending).toBe(true);release();
  await page.getByText('조회에 실패했어요 (NETWORK)').waitFor();
  assert.equal(await page.getByText('처음 도착한 상품',{exact:true}).count(),0,'failed partial load is not a complete success');
  fail=false;
  await page.getByRole('button',{name:'다시 시도',exact:true}).click();
  await page.getByText('처음 도착한 상품',{exact:true}).waitFor();
  await expect.poll(()=>pending).toBe(true);release();
  await page.getByText('다음 페이지 상품',{exact:true}).waitFor();
 }finally{release();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
