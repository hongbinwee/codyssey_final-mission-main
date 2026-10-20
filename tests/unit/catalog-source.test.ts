import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../../src/catalog.ts';
import * as database from '../../src/db.ts';
import {verifiedRagRetriever} from '../../src/brain/rag-adapter.ts';
import {createLlmGroundedResponder} from '../../src/brain/grounded-response.ts';
import {retrieveTurn} from '../../src/brain/read-flow.ts';

const product={id:'p-v4-fixture',name:'v4 모의 크림',brand:'fixture',category:'beauty',
 description:'합성 테스트 상품',image_urls:[],specs_json:{},active:true,version:1};
const variant={id:'v-v4-fixture',product_id:product.id,option_values_json:{size:'50ml'},
 spec_overrides_json:{},unit_price_won:15000,stock_qty:10,active:true,version:1};
const review={id:'r-v4-fixture',product_id:product.id,variant_id:variant.id,rating:4,
 body:'합성 리뷰입니다.',source_kind:'SYNTHETIC',source_ref:'fixture-v4',written_at:'2026-10-17T00:00:00Z'};

function mockDb(schema:string){
 const calls:{query:string;args?:unknown[]}[]=[];
 const db={unsafe:async(query:string,args?:unknown[])=>{
  calls.push({query,args});
  assert.match(query,/^SELECT /);
  assert.doesNotMatch(query,/search_path|\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT)\b/i);
  assert.ok(query.includes('FROM '+schema+'.'),'wrong source: '+query);
  if(query.includes('avg(rating)'))return [{product_id:product.id,avg:4,count:1}];
  if(query.includes(schema+'.product_variants'))return [variant];
  if(query.includes(schema+'.reviews'))return [review];
  if(args?.[0]==='missing')return [];
  return [product];
 }};
 return {db,calls};
}

test('v4 catalog uses explicit source tables, original IDs and simulated read-only metadata',async()=>{
 const create=(catalog as unknown as {createCatalog?:Function}).createCatalog;
 assert.equal(typeof create,'function');if(!create)return;
 const {db,calls}=mockDb('test_items');const reader=create('test_items',db);
 const listed=await reader.searchProducts({query:"cream' OR true --"});
 assert.equal(listed.ok,true);assert.equal(listed.data.items[0].product_id,product.id);
 assert.equal(listed.data.catalog_context.is_simulated,true);
 const detail=await reader.getProduct({product_id:product.id});
 assert.equal(detail.data.product.id,product.id);assert.equal(detail.data.variants[0].variant_id,variant.id);
 assert.equal(detail.data.catalog_context.read_only,true);
 const reviews=await reader.getReviews({product_id:product.id,variant_id:variant.id});
 assert.equal(reviews.data.reviews[0].id,review.id);assert.equal(reviews.data.reviews[0].source_kind,'SYNTHETIC');
 const exact=await reader.getReviewsByIds({product_id:product.id,review_ids:[review.id]});
 assert.equal(exact[0].variant_id,variant.id);
 assert.ok(calls.every(c=>!c.query.includes("cream'")));
 const last=calls.at(-1)!;assert.deepEqual(last.args,[product.id,[review.id]]);
 const missing=await reader.getProduct({product_id:'missing'});assert.equal(missing.ok,false);
 assert.ok(calls.every(c=>!c.query.includes('public.')),'no public fallback');
});

test('public catalog remains separate and arbitrary schema names are rejected before querying',async()=>{
 const create=(catalog as unknown as {createCatalog?:Function}).createCatalog;
 assert.equal(typeof create,'function');if(!create)return;
 const {db,calls}=mockDb('public');const reader=create('public',db);
 const result=await reader.getProduct({product_id:product.id});assert.equal(result.ok,true);
 assert.equal(result.data.catalog_context,undefined);
 const count=calls.length;
 for(const source of ['test_earphones','public; DROP SCHEMA public CASCADE','__proto__'])
  assert.throws(()=>create(source,db),/catalog source/i);
 assert.equal(calls.length,count);
});

test('test catalog blocks Commerce tools and writes, while Brain uses its independent API boundary',()=>{
 const allowed=(catalog as unknown as {catalogRequestAllowed?:Function}).catalogRequestAllowed;
 assert.equal(typeof allowed,'function');if(!allowed)return;
 for(const path of ['/api/cart','/api/cart/items','/api/checkout/quote','/api/checkout/confirm',
  '/api/orders','/api/wishlist','/api/agent/turn','/api/actions'])
  for(const method of ['GET','POST','PUT','PATCH','DELETE'])assert.equal(allowed('test_items',method,path),false);
 assert.equal(allowed('test_items','GET','/api/products'),true);
 assert.equal(allowed('test_items','GET','/api/products/p-v4-fixture/reviews'),true);
 assert.equal(allowed('test_items','POST','/api/products'),false);
 assert.equal(allowed('test_items','GET','/api/catalog/context'),true);
 assert.equal(allowed('test_items','POST','/api/brain/conversations/c/turn'),true);
 assert.equal(allowed('public','POST','/api/cart/items'),true);
});

test('service role guard rejects administrative roles and requires a read-only Commerce connection',async()=>{
 const verify=(database as unknown as {assertServiceRole?:Function}).assertServiceRole;
 assert.equal(typeof verify,'function');if(!verify)return;
 const ordinary={rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:'on'};
 await verify({unsafe:async()=>[ordinary]},true);
 for(const column of ['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls'])
  await assert.rejects(()=>verify({unsafe:async()=>[{...ordinary,[column]:true}]},true),/service role/i);
 await assert.rejects(()=>verify({unsafe:async()=>[{...ordinary,read_only:'off'}]},true),/read.only/i);
 await verify({unsafe:async()=>[{...ordinary,read_only:'off'}]},false);
});

test('test_items catalog IDs and simulated facts pass through the v4 adapter and grounded answer',async()=>{
 const {db}=mockDb('test_items');
 const reader=catalog.createCatalog('test_items',db as never);
 const version='fixture-v4';
 const retriever=verifiedRagRetriever({endpoint:'http://127.0.0.1:8002/v1/rag/search',contract:'v4',datasetVersion:version},
  reader.getProduct,async()=>new Response(JSON.stringify({dataset_version:version,
   items:[{product_id:product.id,rrf_score:.03,evidence:[{source_type:'review',product_id:product.id,
    source_id:review.id,source_version:version,evidence_text:review.body,
    source_metadata:{variant_id:variant.id,source_kind:'SYNTHETIC',synthetic:true}}]}]})),reader.getReviewsByIds);
 const plan={query:'크림',maxTotalWon:30000,requiredConditions:[],currentPreferences:{},revision:1};
 const request={actorUserId:'user',conversationId:'conversation',requestId:'request',clientActionId:'action',userMessage:'크림을 비교해줘'};
 const fetched=await retrieveTurn(request,{messageId:'message',memories:[],startedAt:performance.now(),memoryMs:0},plan,
  {retriever} as never);
 assert.equal(fetched.result.ranking.ranked.length,0);
 assert.equal(fetched.result.ranking.referenceOnly[0].candidate.isSimulated,true);
 const respond=createLlmGroundedResponder({chat:async()=>({content:JSON.stringify({sourceKind:'SYNTHETIC',
  productId:product.id,variantId:variant.id,sourceId:review.id,quote:review.body})})});
 const answer=await respond({originalQuestion:request.userMessage,ranking:fetched.result.ranking,evidence:fetched.evidence,plan});
 assert.equal(answer.kind,'REFERENCE_ONLY');
 assert.match(answer.text,/시연 데이터 참고 내용이에요/);
 assert.match(answer.text,/합성 리뷰 의견이 포함되어 있어요/);
 assert.match(answer.text,/표시된 가격과 재고는 실제 판매 정보가 아니며 주문·결제할 수 없어요/);
 assert.deepEqual(answer.citations?.map(c=>[c.productId,c.variantId,c.sourceId]),[[product.id,variant.id,review.id]]);
});
