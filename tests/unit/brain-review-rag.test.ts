import test from 'node:test';
import assert from 'node:assert/strict';
import {ok,type ProductDetail,type ReviewItem} from '../../src/contracts.ts';
import type {EvidenceRecord} from '../../src/brain/contracts.ts';
import type {RagConnection} from '../../src/brain/rag-adapter.ts';
import type {DisplayedReviewProduct} from '../../src/brain/review-analysis.ts';
import {createScopedReviewSearch} from '../../src/brain/review-rag.ts';

const DATASET_VERSION='test_items2:v6.1-review-refined:sha256=94681a28271ca9b1:products=1500:reviews=46100';
const connection:RagConnection={endpoint:'https://rag.example.invalid/search',mode:'remote',contract:'v4',
 profile:'test_items2',catalogSource:'test_items2',datasetVersion:DATASET_VERSION,category:'beauty',timeoutMs:1000};

function productDetail(productId:string,variantIds=[`v-${productId}`]){
 return ok<ProductDetail>({catalog_context:{source:'test_items2',read_only:true,is_simulated:true},
  product:{id:productId,name:`상품 ${productId}`,brand:'brand',category:'beauty',description:'',images:[],specs:{},active:true,version:1,availability:'SOLD_OUT'},
  variants:variantIds.map(variant_id=>({variant_id,option_values:{},effective_specs:{},unit_price_won:1000,stock_qty:0,availability:'SOLD_OUT' as const,version:1})),
  shipping_fee_won:3000},'trace');
}

function review(overrides:Partial<ReviewItem>={}):ReviewItem{
 return {id:'r-p1',product_id:'p1',variant_id:'v-p1',rating:5,body:'발림성이 가볍고 보습이 오래가서 만족해요.',
  source_kind:'REAL',source_ref:'commerce:review:1',written_at:'2026-10-20T00:00:00.000Z',...overrides};
}

type ReviewHit={productId:string;sourceId:string;variantId:string|null;excerpt:string;sourceKind:'REAL'|'SYNTHETIC';
 sourceRef?:string|null;sourceVersion?:string|null;sourceType?:string};
function rawResponse(hits:ReviewHit[],options:{productIds?:string[];itemProductIds?:string[];datasetVersion?:string;profile?:string;status?:string;appliedProductIds?:string[]}={}){
 const productIds=options.productIds??['p1'];
 const profile=options.profile??'test_items2';
 return {dataset_version:options.datasetVersion??DATASET_VERSION,profile_name:profile,status:options.status??'ok',error_code:null,
  applied_filters:{category:'beauty',product_ids:options.appliedProductIds??productIds,source_type:'review'},
  search_context:{result_limit_semantics:'products',evidence_limit_per_product:3},
  items:(options.itemProductIds??productIds).map(product_id=>({product_id,rrf_score:.9,evidence:hits.filter(hit=>hit.productId===product_id).map(hit=>({
   source_type:hit.sourceType??'review',product_id:hit.productId,source_id:hit.sourceId,
   source_version:hit.sourceVersion===undefined?DATASET_VERSION:hit.sourceVersion,evidence_text:hit.excerpt,
    source_metadata:{variant_id:hit.variantId,source_kind:hit.sourceKind,synthetic:hit.sourceKind==='SYNTHETIC',
     source_ref:hit.sourceRef===undefined?'commerce:review:1':hit.sourceRef},
  }))}))};
}

function harness(options:{products?:DisplayedReviewProduct[];hits?:ReviewHit[];rows?:ReviewItem[];response?:unknown;
 productVariants?:Record<string,string[]>;timeoutMs?:number;profile?:string}={}){
 const products=options.products??[{productId:'p1',variantId:'v-p1',displayIndex:1}];
 const hits=options.hits??[{productId:'p1',sourceId:'r-p1',variantId:'v-p1',excerpt:'보습이 오래가서 만족해요.',sourceKind:'REAL'}];
 const rows=options.rows??[review()];
 let fetchCalls=0,lookupCalls:{productId:string;reviewIds:string[]}[]=[];
 let sent:Record<string,unknown>|undefined;
 const fetcher=(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  fetchCalls++;sent=JSON.parse(String(init?.body)) as Record<string,unknown>;
   return new Response(JSON.stringify(options.response??rawResponse(hits,{productIds:products.map(item=>item.productId),profile:options.profile})),{status:200});
 }) as typeof fetch;
 const catalog={
  getProduct:async({product_id}:{product_id:string})=>productDetail(product_id,options.productVariants?.[product_id]??[`v-${product_id}`]),
  getReviewsByIds:async({product_id,review_ids}:{product_id:string;review_ids:string[]})=>{
   lookupCalls.push({productId:product_id,reviewIds:review_ids});
   return rows.filter(row=>row.product_id===product_id&&review_ids.includes(row.id));
  },
 };
 const run=createScopedReviewSearch({...connection,profile:options.profile??connection.profile,
  ...(options.timeoutMs?{timeoutMs:options.timeoutMs}:{})},catalog,fetcher);
 return {run,products,fetchCalls:()=>fetchCalls,lookupCalls:()=>lookupCalls,sent:()=>sent};
}

test('scoped review search sends one semantic request for up to three verified products without commerce filters',async()=>{
 const products:DisplayedReviewProduct[]=[{productId:'p1',variantId:'v-p1',displayIndex:1},
  {productId:'p2',variantId:'v-p2',displayIndex:2},{productId:'p3',displayIndex:3}];
 const hits:ReviewHit[]=products.map((product,index)=>({productId:product.productId,sourceId:`r-${product.productId}`,
  variantId:product.variantId??null,excerpt:`원문 인용 ${index+1}`,sourceKind:'REAL',sourceRef:`commerce:${index+1}`}));
 const rows=products.map((product,index)=>review({id:`r-${product.productId}`,product_id:product.productId,
  variant_id:product.variantId??null,body:`앞 문장 원문 인용 ${index+1} 뒤 문장`,source_ref:`commerce:${index+1}`}));
 const h=harness({products,hits,rows});
 const evidence=await h.run({products,query:'가볍게 발리고 보습이 오래가는 상품 후기',originalQuestion:'민감 피부용 상품의 실제 사용감은 어때?',requestId:'review-42',category:'beauty'});
 assert.equal(h.fetchCalls(),1);assert.equal(h.lookupCalls().length,3);
 assert.deepEqual(h.lookupCalls().map(row=>row.productId),['p1','p2','p3']);
 assert.deepEqual(h.sent(),{request_id:'review-42',profile:'test_items2',query:'가볍게 발리고 보습이 오래가는 상품 후기',
  original_question:'민감 피부용 상품의 실제 사용감은 어때?',
  category:'beauty',filters:{},required_conditions:[],preferences:[],product_ids:['p1','p2','p3'],source_type:'review',top_k:3});
 assert.deepEqual(evidence.map(row=>[row.productId,row.sourceId,row.variantId,row.sourceRef,row.text,row.verified,row.datasetVersion]),[
  ['p1','r-p1','v-p1','commerce:1','원문 인용 1',true,DATASET_VERSION],
  ['p2','r-p2','v-p2','commerce:2','원문 인용 2',true,DATASET_VERSION],
  ['p3','r-p3',null,'commerce:3','원문 인용 3',true,DATASET_VERSION],
 ]);
 assert.equal(evidence.every(row=>row.kind==='REVIEW'),true);
});

test('request profile comes from the configured RAG connection',async()=>{
 const h=harness({profile:'review_profile_custom'});
 const evidence=await h.run({products:h.products,query:'semantic review query',originalQuestion:'Original question remains separate',requestId:'profile-test'});
 assert.equal((h.sent() as Record<string,unknown>).profile,'review_profile_custom');
 assert.equal(evidence.length,1);
});

test('selected-variant scope keeps product-level reviews and drops other known variants',async()=>{
 const products=[{productId:'p1',variantId:'v-p1',displayIndex:1}];
 const hits:ReviewHit[]=[
  {productId:'p1',sourceId:'selected',variantId:'v-p1',excerpt:'선택 옵션 원문',sourceKind:'REAL'},
  {productId:'p1',sourceId:'product-level',variantId:null,excerpt:'상품 전체 원문',sourceKind:'REAL'},
  {productId:'p1',sourceId:'other-option',variantId:'v-other',excerpt:'다른 옵션 원문',sourceKind:'REAL'},
 ];
 const rows=[review({id:'selected',body:'선택 옵션 원문'}),review({id:'product-level',variant_id:null,body:'상품 전체 원문'})];
 const h=harness({products,hits,rows,productVariants:{p1:['v-p1','v-other']}});
 const evidence=await h.run({products,query:'후기',originalQuestion:'리뷰 분석',requestId:'r-1'});
 assert.deepEqual(h.lookupCalls(),[{productId:'p1',reviewIds:['selected','product-level']}]);
 assert.deepEqual(evidence.map(row=>[row.sourceId,row.variantId]),[['selected','v-p1'],['product-level',null]]);
});

test('review text is an exact original-source excerpt with matching Commerce provenance',async()=>{
 const hits:ReviewHit[]=[
  {productId:'p1',sourceId:'present',variantId:'v-p1',excerpt:'정확히 이 문장만',sourceKind:'SYNTHETIC',sourceRef:'fixture:present'},
 ];
 const h=harness({hits,rows:[review({id:'present',body:'앞부분 정확히 이 문장만 뒷부분',source_kind:'SYNTHETIC',source_ref:'fixture:present'})]});
 const evidence=await h.run({products:h.products,query:'후기',originalQuestion:'후기 정리',requestId:'r-2'});
 assert.equal(evidence.length,1);
 assert.deepEqual(evidence[0],{id:'present',productId:'p1',variantId:'v-p1',kind:'REVIEW',sourceKind:'SYNTHETIC',
  sourceRef:'fixture:present',text:'정확히 이 문장만',sourceId:'present',rating:5,verified:true,datasetVersion:DATASET_VERSION});
});

test('a retrieved review missing from Commerce is an error, not a partial success',async()=>{
 const hits:ReviewHit[]=[
  {productId:'p1',sourceId:'present',variantId:'v-p1',excerpt:'있는 원문',sourceKind:'REAL'},
  {productId:'p1',sourceId:'missing',variantId:'v-p1',excerpt:'없는 원문',sourceKind:'REAL'},
 ];
 const h=harness({hits,rows:[review({id:'present',body:'있는 원문'})]});
 await assert.rejects(()=>h.run({products:h.products,query:'후기',originalQuestion:'후기 정리',requestId:'missing-source'}),
  error=>error instanceof Error&&error.message==='Review evidence search failed');
});

test('semantic query is forwarded unchanged while the original question stays separate',async()=>{
 const h=harness();
 const query='의미 검색 문장 '.repeat(30).trim();
 await h.run({products:h.products,query,originalQuestion:'질문 원문',requestId:'query-preservation'});
 assert.equal((h.sent() as Record<string,unknown>).query,query);
 assert.equal((h.sent() as Record<string,unknown>).original_question,'질문 원문');
});

test('empty RAG results return no evidence and do not trigger a broad fallback',async()=>{
 const response=rawResponse([],{productIds:['p1'],itemProductIds:[],status:'no_results'});
 const h=harness({response});
 assert.deepEqual(await h.run({products:h.products,query:'후기',originalQuestion:'후기 분석',requestId:'r-3'}),[]);
 assert.equal(h.fetchCalls(),1);assert.equal(h.lookupCalls().length,0);
});

test('a target product with no retrieved review evidence remains empty while other targets stay scoped',async()=>{
 const products:DisplayedReviewProduct[]=[{productId:'p1',variantId:'v-p1',displayIndex:1},
  {productId:'p2',variantId:'v-p2',displayIndex:2}];
 const hits:ReviewHit[]=[{productId:'p1',sourceId:'r-p1',variantId:'v-p1',excerpt:'원문 인용',sourceKind:'REAL'}];
 const rows=[review({id:'r-p1',body:'정확한 원문 인용'})];
 const h=harness({products,hits,rows});
 const evidence=await h.run({products,query:'후기',originalQuestion:'두 상품 후기 비교',requestId:'r-3b'});
 assert.deepEqual(h.lookupCalls(),[{productId:'p1',reviewIds:['r-p1']}]);
 assert.deepEqual(evidence.map(row=>row.sourceId),['r-p1']);
 assert.equal(evidence.some(row=>row.productId==='p2'),false);
});

test('unavailable, wrong-version, wrong-profile, wrong-filter, and out-of-scope responses reject',async(t)=>{
 const hit:ReviewHit={productId:'p1',sourceId:'r-p1',variantId:'v-p1',excerpt:'보습이 오래가서 만족해요.',sourceKind:'REAL'};
 const cases:[string,number,unknown][]=[
  ['forbidden',403,rawResponse([hit])],['unprocessable',422,rawResponse([hit])],['server error',500,rawResponse([hit])],
  ['wrong version',200,rawResponse([hit],{datasetVersion:'other'})],
  ['wrong profile',200,rawResponse([hit],{profile:'all_products'})],
  ['wrong product filter',200,rawResponse([hit],{appliedProductIds:['p-other']})],
  ['low relevance is not a no-results response',200,rawResponse([hit],{status:'low_relevance'})],
  ['non-null service error code',200,{...rawResponse([hit]),error_code:'service_unavailable'}],
  ['foreign product evidence',200,rawResponse([{...hit,productId:'p-other'}],{productIds:['p1'],itemProductIds:['p-other']})],
  ['product-description evidence',200,rawResponse([{...hit,sourceType:'product'}])],
  ['wrong source version',200,rawResponse([{...hit,sourceVersion:'other'}])],
   ['missing source reference',200,rawResponse([{...hit,sourceRef:null}])],
  ['mismatched source reference',200,rawResponse([{...hit,sourceRef:'other-reference'}])],
 ];
 for(const [name,status,response] of cases){
  await t.test(name,async()=>{
   const fetcher=(async()=>new Response(JSON.stringify(response),{status})) as typeof fetch;
   const catalog={getProduct:async({product_id}:{product_id:string})=>productDetail(product_id),
    getReviewsByIds:async()=>[review()]};
   const run=createScopedReviewSearch(connection,catalog,fetcher);
    await assert.rejects(()=>run({products:[{productId:'p1',variantId:'v-p1',displayIndex:1}],query:'후기',
     originalQuestion:'리뷰 분석',requestId:'r-4'}),error=>error instanceof Error&&error.message==='Review evidence search failed');
  });
 }
});

test('duplicate or mismatched Commerce rows reject the full scoped response',async()=>{
 for(const rows of [
  [review(),review()],
  [review({product_id:'p-other'})],
  [review({variant_id:'v-other'})],
  [review({source_kind:'SYNTHETIC'})],
   [review({source_ref:'different-reference'})],
  [review({body:'원문에 인용문이 없음'})],
 ]){
  const h=harness({rows});
  await assert.rejects(()=>h.run({products:h.products,query:'후기',originalQuestion:'리뷰',requestId:'r-5'}),
   error=>error instanceof Error&&error.message==='Review evidence search failed');
 }
});

test('timeouts and invalid or duplicate display targets reject without searching broadly',async()=>{
 const timed=createScopedReviewSearch({...connection,timeoutMs:100},{
  getProduct:async({product_id})=>productDetail(product_id),getReviewsByIds:async()=>[],
 },(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
  init?.signal?.addEventListener('abort',()=>reject(new DOMException('timed out','TimeoutError')),{once:true});
  })) as typeof fetch)({products:[{productId:'p1',displayIndex:1}],query:'후기',originalQuestion:'리뷰',requestId:'r-6'});
 await assert.rejects(timed,error=>error instanceof Error&&error.message==='Review evidence search failed');
 let calls=0;
 const h=harness();
 await assert.rejects(()=>h.run({products:[{productId:'p1',displayIndex:1},{productId:'p1',displayIndex:2}],query:'후기',originalQuestion:'리뷰',requestId:'r-7'}),/Invalid review evidence request/);
 calls=h.fetchCalls();assert.equal(calls,0);
});

test('catalog validates every target and selected variant before sending the RAG request',async()=>{
 let calls=0;
 const run=createScopedReviewSearch(connection,{
  getProduct:async()=>productDetail('different-product'),getReviewsByIds:async()=>[],
 },(async()=>{calls++;return new Response('{}');}) as typeof fetch);
 await assert.rejects(()=>run({products:[{productId:'p1',variantId:'v-p1',displayIndex:1}],query:'후기',originalQuestion:'리뷰',requestId:'r-8'}),
  error=>error instanceof Error&&error.message==='Review evidence search failed');
 assert.equal(calls,0);
 const wrongVariant=createScopedReviewSearch(connection,{
  getProduct:async({product_id})=>productDetail(product_id),getReviewsByIds:async()=>[],
 },(async()=>{calls++;return new Response('{}');}) as typeof fetch);
 await assert.rejects(()=>wrongVariant({products:[{productId:'p1',variantId:'unknown',displayIndex:1}],query:'후기',originalQuestion:'리뷰',requestId:'r-9'}),
  error=>error instanceof Error&&error.message==='Review evidence search failed');
 assert.equal(calls,0);
});

