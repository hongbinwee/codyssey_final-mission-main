import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

test('mobile catalog loads its first page and paginates on scroll with summary counts', {timeout:30000},async()=>{
 const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{Shopping}from'./src/web/screens/Shopping.tsx';function App(){const[c,setC]=useState('beauty'),[s,setS]=useState('');return <main><Shopping category={c} sub={s} userName="QA" userId="fixture-only" onNav={(c,s='')=>{setC(c);setS(s)}} onOpenProduct={()=>{}} onOpenOrders={()=>{}} onOpenCart={()=>{}} onOpenWish={()=>{}} commerceEnabled={false}/></main>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},write:false,bundle:true,jsx:'automatic',format:'iife'});
 const css=await readFile('src/web/styles.css','utf8');
 // Literal independent taxonomy fixture; actual 180-row export is separately unit-tested.
 const items=Array.from({length:180},(_,i)=>({product_id:'p-fixture-'+i,name:'상품 '+i,brand:'QA',category:'beauty',image:null,matched_variants:[{variant_id:'v-fixture-'+i,option_values:{},effective_specs:{'원본 목록 세부 카테고리':i<100?'스킨케어':'메이크업'},unit_price_won:12000,stock_qty:7,availability:'AVAILABLE',version:1}],rating_summary:{avg:4.2,count:2},availability:'AVAILABLE'}));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}});page.setDefaultTimeout(5000);
  const seen=[];
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script src="/bundle.js"></script>'});
   if(url.pathname==='/styles.css')return route.fulfill({contentType:'text/css',body:css});
   if(url.pathname==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   if(url.pathname==='/api/products'){
    assert.equal(url.searchParams.get('browse'),'1');
    const start=Number(url.searchParams.get('cursor')??0);
    const group=url.searchParams.get('browse_group')??'';
    const sub=url.searchParams.get('browse_sub')??'';
    seen.push({start,group,sub});
    const filtered=items.filter((_,i)=>{
     if(group&&group!=='beauty')return false;
     if(sub==='makeup')return i>=100;
     if(sub==='skincare')return i<100;
     if(sub==='sun'||sub==='cleansing')return false;
     return true;
    });
    const summary={total_count:filtered.length,group_counts:{beauty:180},
      subcategory_counts:{beauty:{sun:0,skincare:100,cleansing:0,makeup:80}},max_discount_rate:35};
    const next=start+50<filtered.length?String(start+50):null;
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{
     items:filtered.slice(start,start+50),next_cursor:next,has_more:next!==null,
     shipping_fee_won:3000,browse_summary:summary,
     catalog_context:{source:'test_items',read_only:true,is_simulated:true}}})});
   }
   if(url.pathname.startsWith('/api/'))throw Error('readonly UI must not call '+url.pathname);
   return route.abort();
  });
  await page.goto('http://127.0.0.1:39192/');
  await page.getByText('상품 49',{exact:true}).waitFor();
  assert.equal(await page.locator('.product-grid .product-card').count(),50);
  assert.deepEqual(seen.map(x=>x.start),[0]);
  assert.equal((await page.locator('.rec-h .cnt').textContent()).trim(),'180');
  assert.ok(await page.getByRole('button',{name:'메이크업 80개 상품'}).count()>0);
  assert.ok(await page.getByRole('button',{name:/찜하기/}).count()>0);
  assert.equal(await page.getByRole('button',{name:/찜하기/}).first().isDisabled(),true);
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.getByText('상품 99',{exact:true}).waitFor();
  assert.deepEqual(seen.map(x=>x.start),[0,50]);
  await page.locator('.icon-rail').getByRole('button',{name:'메이크업 80개 상품'}).click();
  await page.getByText('상품 149',{exact:true}).waitFor();
  assert.equal(await page.locator('.product-grid .product-card').count(),50);
  assert.equal((await page.locator('.list-h .cnt').textContent()).trim(),'80');
  assert.deepEqual(seen.at(-1),{start:0,group:'beauty',sub:'makeup'});
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.getByText('상품 179',{exact:true}).waitFor();
  assert.equal(await page.locator('.product-grid .product-card').count(),80);
  assert.deepEqual(seen.at(-1),{start:50,group:'beauty',sub:'makeup'});
  await page.getByRole('button',{name:'선케어',exact:true}).click();
  await page.getByText(/조건에 맞는 상품이 없어요/).waitFor();
  await page.getByRole('button',{name:'스킨케어',exact:true}).click();
  await page.getByText('상품 49',{exact:true}).waitFor();
  assert.equal(await page.locator('.product-grid .product-card').count(),50);
  assert.equal((await page.locator('.list-h .cnt').textContent()).trim(),'100');
  assert.deepEqual(seen.at(-1),{start:0,group:'beauty',sub:'skincare'});
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.getByText('상품 99',{exact:true}).waitFor();
  assert.equal(await page.locator('.product-grid .product-card').count(),100);
  assert.deepEqual(seen.at(-1),{start:50,group:'beauty',sub:'skincare'});
  const overflow=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,
    elements:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right}))}));
  assert.equal(overflow.document<=overflow.width,true,JSON.stringify(overflow));
 }finally{await browser.close();}
});
