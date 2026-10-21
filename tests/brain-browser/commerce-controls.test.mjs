import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

// Real Product component; HTTP is a fixture. No existing QA account/session or DB access.
for(const [readOnly,storageEnabled] of [[false,true],[true,false],[true,true]])test(`Commerce controls remain visible, readonly=${readOnly}, storage=${storageEnabled}`,{timeout:45000},async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{Product}from'./src/web/screens/Product.tsx';import{bindPendingUser}from'./src/web/pending.ts';bindPendingUser('tester_05');createRoot(document.getElementById('root')).render(<div className="shell"><main><Product productId="p-control" userId="tester_05" commerceEnabled={${storageEnabled}} checkoutEnabled={${!readOnly}} cartCount={0} onBack={()=>{}} onOpenSearch={()=>{}} onOpenReviews={()=>{}} onOpenCart={()=>{document.getElementById('nav').textContent='카트 이동';}} onOpenWish={()=>{}} onBuyNow={()=>{}} onCartChanged={v=>{document.getElementById('cart').textContent=String(v.total_won);}}/></main></div>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife'});
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [390,1280]){
   const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(5000);
   const writes=[];let saved=false;
   const variants=[['v-small','소형',10000,7],['v-large','대형',15000,3],['v-sold','품절 옵션',12000,0]].map(([variant_id,size,unit_price_won,stock_qty])=>({variant_id,option_values:{size},effective_specs:{},unit_price_won,stock_qty,availability:stock_qty?'AVAILABLE':'SOLD_OUT',version:1}));
   const product={id:'p-control',name:'회귀 상품',brand:'QA',category:'monitor',description:'옵션·버튼 회귀',images:[],specs:{},active:true,version:1};
   await page.route('http://127.0.0.1:39195/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    const ok=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><output id="cart"></output><output id="nav"></output><script src="/bundle.js"></script>'});
    if(url.pathname==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
    if(url.pathname==='/style.css')return route.fulfill({contentType:'text/css',body:await readFile('src/web/styles.css','utf8')});
    if(url.pathname==='/api/products/p-control')return ok({product,variants,shipping_fee_won:3000,catalog_context:{read_only:readOnly,is_simulated:readOnly}});
    if(url.pathname==='/api/products')return ok({items:[{product_id:product.id,name:product.name,brand:'QA',category:'monitor',image:null,matched_variants:variants,rating_summary:{avg:null,count:0},availability:'AVAILABLE'}],has_more:false,next_cursor:null});
    if(url.pathname.endsWith('/reviews'))return ok({items:[],total_matching:0,next_cursor:null,has_more:false});
    if(url.pathname==='/api/wishlist'&&req.method()==='GET')return ok({items:saved?[{product_id:product.id,saved_at:new Date().toISOString(),product:{...product,product_id:product.id},availability:'AVAILABLE'}]:[]});
    if(url.pathname.startsWith('/api/wishlist/')&&req.method()==='PUT'){assert.equal(storageEnabled,true);const body=req.postDataJSON();writes.push({kind:'wish',body});saved=body.saved;return ok({product_id:product.id,saved,wishlist_count:saved?1:0});}
    if(url.pathname==='/api/cart')return ok({cart_id:'fixture-cart',version:1,items:[],items_total_won:0,shipping_fee_won:0,total_won:0});
    if(url.pathname==='/api/cart/items'){assert.equal(storageEnabled,true);const body=req.postDataJSON();writes.push({kind:'cart',body});return ok({cart:{cart_id:'fixture-cart',version:2,items:[{variant_id:body.variant_id,quantity:body.quantity}],items_total_won:30000,shipping_fee_won:3000,total_won:33000},changed_item_id:'fixture-item'});}
    if(url.pathname.startsWith('/api/'))throw Error('Unexpected fixture API '+url.pathname);
    return route.abort();
   });
   await page.goto('http://127.0.0.1:39195/');
   const wish=page.getByRole('button',{name:'회귀 상품 찜하기',exact:true});await wish.waitFor();
   assert.equal(await wish.isDisabled(),!storageEnabled);
   await page.locator('.option-open').click();
   if(readOnly)assert.doesNotMatch(await page.getByRole('dialog').innerText(),/구매 가능/);
   assert.equal(await page.getByRole('button',{name:/품절 옵션/}).isDisabled(),true);
   await page.getByRole('button',{name:/대형/}).last().click();
   assert.doesNotMatch(await page.locator('.qty-row').innerText(),/재고\s*\d+|남은 수량|재고 3|재고 7/);
   await page.locator('.qty-ctrl button').last().click();
   const add=page.getByRole('button',{name:/담기$/});assert.equal(await add.isDisabled(),!storageEnabled);
   assert.equal(await page.getByRole('button',{name:'구매하기',exact:true}).isDisabled(),readOnly);
   if(storageEnabled){
    await wish.click();await page.getByRole('button',{name:'회귀 상품 찜 해제',exact:true}).waitFor();
    await page.locator('.wish-sheet-close').click();
    await page.getByRole('button',{name:'회귀 상품 찜 해제',exact:true}).click();await wish.waitFor();
    await add.click();await page.locator('#cart').getByText('33000').waitFor();
    const write=writes.find(x=>x.kind==='cart').body;assert.equal(write.variant_id,'v-large');assert.equal(write.quantity,2);assert.equal(write.expected_variant_version,1);assert.ok(write.idempotency_key);
    assert.deepEqual(writes.filter(x=>x.kind==='wish').map(x=>x.body.saved),[true,false]);
   }else assert.equal(writes.length,0);
   await page.locator('.detail-cart-btn').click();await page.getByText('카트 이동',{exact:true}).waitFor();
   const overflow=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,6).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right}))}));
   assert.equal(overflow.document<=overflow.width,true,JSON.stringify(overflow));
   if(width===390)await page.screenshot({path:'.local-data/commerce-controls-'+(readOnly?'readonly':'writable')+'-'+Date.now()+'.png'});
   await page.close();
  }
 }finally{await browser.close();}
});
