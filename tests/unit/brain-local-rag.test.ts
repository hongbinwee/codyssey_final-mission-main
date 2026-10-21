import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {parseDatasetManifest} from "../../src/brain/dataset-manifest.ts";
import {parseV4Response} from "../../src/brain/rag-adapter.ts";

const MODEL="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const VERSION="test_items:sha256=0123456789abcdef:products=3:reviews=2";
const modulePromise=import("../../src/brain/local-rag.ts").catch(()=>null);
const vector=(x:number,y=0)=>Array.from({length:384},(_,i)=>i===0?x:i===1?y:0);
function chunk(input:{id:string;productId:string;type:"review"|"product";text:string;embedding:number[];category?:string;sourceId?:string;metadata?:Record<string,unknown>;version?:string}){
 const review=input.type==="review";
 return {category:input.category??"beauty",chunk_id:input.id,chunk_key:`key-${input.id}`,
   chunker_version:"source-evidence-token-v2:max_tokens=96",dataset_version:input.version??VERSION,
   embedding:input.embedding,embedding_model:MODEL,embedding_text:input.text,evidence_text:input.text,
   end_offset:input.text.length,product_id:input.productId,run_id:"fixture",source_field:review?"body":"description",
   source_id:input.sourceId??`source-${input.id}`,source_type:input.type,source_version:null,start_offset:0,
   source_metadata:input.metadata??(review?{rating:5,synthetic:true,variant_id:`v-${input.productId}`,
     source_kind:"SYNTHETIC",source_ref:"https://example.invalid/review",timestamp:"2026-01-01"}:
     {synthetic:null,source_kind:null,source_table:"products"})};
}
const baseChunks=[
 chunk({id:"c-p1-review",productId:"p1",type:"review",text:"무선 헤드폰 착용감이 편해서 좋아요",embedding:vector(1,.05),sourceId:"r-p1"}),
 chunk({id:"c-p1-product",productId:"p1",type:"product",text:"상품 설명 데이터",embedding:vector(.8,.6),sourceId:"product-p1"}),
 chunk({id:"c-p2-review",productId:"p2",type:"review",text:"Bluetooth wireless headset is comfortable",embedding:vector(.6,.8),sourceId:"r-p2"}),
 chunk({id:"c-p3-audio",productId:"p3",type:"review",text:"무선 헤드폰 추천",embedding:vector(.95,.02),category:"audio",sourceId:"r-p3"})
];
type FixtureProduct={product_id:string;category:string;dataset_version:string;product_payload:{
 title?:string;category?:string;source_id?:string;features?:{product_type?:string};[key:string]:unknown
}};
const baseProducts:FixtureProduct[]=["p1","p2","p3"].map(productId=>({product_id:productId,
 category:productId==="p3"?"audio":"beauty",dataset_version:VERSION,
 product_payload:{title:`상품 ${productId}`,category:productId==="p3"?"audio":"beauty",source_id:`catalog-${productId}`}}));
const request=(extra:Record<string,unknown>={})=>({request_id:"req-1",original_question:"무선 헤드폰 추천해 주세요",
 query:"무선 헤드폰",category:"beauty",filters:{},required_conditions:[],preferences:[],top_k:5,...extra});

async function withSearch<T>(run:(ctx:{search:(body:unknown)=>Promise<any>;stats:any;queries:string[]})=>Promise<T>,
 chunks:typeof baseChunks=baseChunks,products:FixtureProduct[]=baseProducts,
 encode:(query:string)=>Promise<number[]>=async()=>vector(1,.05),
 manifest?:ReturnType<typeof parseDatasetManifest>){
 const dataDir=await mkdtemp(join(tmpdir(),"codyssey-local-rag-"));
 try{
   await writeFile(join(dataDir,"evidence_chunks.jsonl"),chunks.map(row=>JSON.stringify(row)).join("\n")+"\n");
   await writeFile(join(dataDir,"indexed_products.jsonl"),products.map(row=>JSON.stringify(row)).join("\n")+"\n");
   const mod=await modulePromise;
   assert.equal(typeof mod?.createLocalRagSearch,"function","createLocalRagSearch is not implemented");
   const queries:string[]=[];
   const local=await mod!.createLocalRagSearch({dataDir,embedQuery:async(query:string)=>{queries.push(query);return encode(query);},...(manifest?{manifest}:{})});
   return await run({search:local.search,stats:local.stats,queries});
 }finally{await rm(dataDir,{recursive:true,force:true});}
}

function fixtureManifest(chunks:typeof baseChunks,products:FixtureProduct[]){
 const evidence=chunks.map(row=>JSON.stringify(row)).join("\n")+"\n";
 const indexedProducts=products.map(row=>JSON.stringify(row)).join("\n")+"\n";
 return parseDatasetManifest({schemaVersion:1,datasetId:"fixture",datasetVersion:VERSION,
  dataClass:"CANDIDATE",catalogSource:"test_items2",
  categories:[...new Set(products.map(row=>row.category))],
  embedding:{model:MODEL,dimensions:384,queryRevision:"a".repeat(40),documentRevision:null},
  files:{evidenceSha256:createHash("sha256").update(evidence).digest("hex"),
   indexedProductsSha256:createHash("sha256").update(indexedProducts).digest("hex")}});
}

test("local RAG returns exact v4 shape, combines Korean BM25 and cosine RRF, and emits only synthetic review sources",async()=>{
 await withSearch(async({search,stats,queries})=>{
   const result=await search(request());
   assert.equal(result.dataset_version,VERSION);
   assert.deepEqual(result.items.map((x:any)=>x.product_id),["p1","p2"]);
   assert.ok(result.items[0].rrf_score>result.items[1].rrf_score);
   assert.deepEqual(queries,["무선 헤드폰"]);
   assert.equal(result.items[0].evidence.length,1);
   const citation=result.items[0].evidence[0];
   assert.deepEqual({product_id:citation.product_id,chunk_id:citation.chunk_id,source_type:citation.source_type,
     source_id:citation.source_id,source_version:citation.source_version,evidence_text:citation.evidence_text},
     {product_id:"p1",chunk_id:"c-p1-review",source_type:"review",source_id:"r-p1",source_version:null,
       evidence_text:"무선 헤드폰 착용감이 편해서 좋아요"});
   assert.equal(citation.source_metadata.source_kind,"SYNTHETIC");
   assert.equal(citation.source_metadata.synthetic,true);
   assert.equal(result.items.some((x:any)=>x.evidence.some((e:any)=>e.source_type==="product")),false);
   assert.equal(stats.chunkCount,4);
   assert.equal(stats.productCount,3);
   assert.equal(stats.vectorDimensions,384);
   assert.equal(stats.embeddingModel,MODEL);
   assert.match(stats.evidenceSha256,/^[a-f0-9]{64}$/);
   assert.ok(result.search_trace.bm25Ms>=0);assert.ok(result.search_trace.vectorMs>=0);
   assert.ok(result.search_trace.embeddingMs>=0);assert.ok(result.search_trace.fusionMs>=0);
   assert.equal(result.search_trace.vectorScannedCount,3);
   assert.ok(result.search_trace.bm25HitCount>0);assert.equal(result.search_trace.fusedProductCount,2);
   assert.equal(parseV4Response(result,VERSION).items[0].evidence[0].sourceId,"r-p1");
 });
});

test("evidence bodies allow line breaks and tabs while rejecting unsafe control characters",async()=>{
 const multiline=chunk({id:"c-multiline",productId:"p1",type:"review",text:"첫 줄\n둘째 줄\t확인",
   embedding:vector(1),sourceId:"r-multiline"});
 await withSearch(async({search})=>{
   const result=await search(request());
   assert.equal(result.items[0].evidence[0].evidence_text,"첫 줄\n둘째 줄\t확인");
 },[multiline],[baseProducts[0]]);
 const unsafe=chunk({id:"c-unsafe",productId:"p1",type:"review",text:"첫 줄\u0000둘째 줄",
   embedding:vector(1),sourceId:"r-unsafe"});
 await assert.rejects(()=>withSearch(async()=>undefined,[unsafe],[baseProducts[0]]),/invalid or incompatible evidence chunk/);
});

test("English terms contribute BM25 ranking and the query encoder receives the text once",async()=>{
 await withSearch(async({search,queries})=>{
   const result=await search(request({query:"Bluetooth wireless",original_question:"Bluetooth headset",required_conditions:["comfortable"]}));
   assert.equal(queries[0],"Bluetooth wireless comfortable");
   assert.equal(result.items[0].product_id,"p2");
 });
});

test("an explicit product query limits retrieval to matching indexed product titles",async()=>{
 const products=[
  {...baseProducts[0],product_payload:{...baseProducts[0].product_payload,title:"에스트라 하이드로에센스",features:{product_type:"스킨케어"}}},
  {...baseProducts[1],product_payload:{...baseProducts[1].product_payload,title:"페리페라 글로이 틴트",features:{product_type:"립 메이크업"}}}
 ];
 const chunks=[
  chunk({id:"essence-review",productId:"p1",type:"review",text:"보습감이 좋아요",embedding:vector(.4,.8)}),
  chunk({id:"tint-review",productId:"p2",type:"review",text:"촉촉하게 발색돼요",embedding:vector(1,.05)})
 ];
 await withSearch(async({search})=>{
  const result=await search(request({query:"에센스",original_question:"에센스 추천",top_k:5}));
  assert.deepEqual(result.items.map((item:any)=>item.product_id),["p1"]);
 },chunks,products,async()=>vector(1,.05));
});

test("a multiword query matches titles after compact whitespace normalization",async()=>{
 const products=[
  {...baseProducts[0],product_payload:{...baseProducts[0].product_payload,title:"에스트라 하이드로에센스",features:{product_type:"스킨케어"}}},
  {...baseProducts[1],product_payload:{...baseProducts[1].product_payload,title:"페리페라 글로이 틴트",features:{product_type:"립 메이크업"}}}
 ];
 const chunks=[
  chunk({id:"compact-match",productId:"p1",type:"review",text:"보습감이 좋아요",embedding:vector(.4,.8)}),
  chunk({id:"compact-distractor",productId:"p2",type:"review",text:"촉촉하게 발색돼요",embedding:vector(1,.05)})
 ];
 await withSearch(async({search})=>{
  const result=await search(request({query:"하이드로 에센스",original_question:"하이드로 에센스 추천",top_k:5}));
  assert.deepEqual(result.items.map((item:any)=>item.product_id),["p1"]);
 },chunks,products,async()=>vector(1,.05));
});

test("an explicit product query matches indexed product_type when the title omits it",async()=>{
 const products=[
  {...baseProducts[0],product_payload:{...baseProducts[0].product_payload,title:"하이드로 200ml",features:{product_type:"에센스"}}},
  {...baseProducts[1],product_payload:{...baseProducts[1].product_payload,title:"글로이 틴트",features:{product_type:"립 메이크업"}}}
 ];
 const chunks=[
  chunk({id:"typed-essence-review",productId:"p1",type:"review",text:"산뜻해요",embedding:vector(.4,.8)}),
  chunk({id:"typed-tint-review",productId:"p2",type:"review",text:"가볍고 좋아요",embedding:vector(1,.05)})
 ];
 await withSearch(async({search})=>{
  const result=await search(request({query:"에센스",original_question:"에센스 추천",top_k:5}));
  assert.deepEqual(result.items.map((item:any)=>item.product_id),["p1"]);
 },chunks,products,async()=>vector(1,.05));
});

test("a generic cross-category query keeps hybrid semantic fallback when no title or type matches",async()=>{
 const products=baseProducts.map(row=>({...row,product_payload:{category:row.category,source_id:row.product_payload.source_id}}));
 const manifest=fixtureManifest(baseChunks,products);
 await withSearch(async({search})=>{
  const result=await search(request({query:"편하게 사용할 제품",original_question:"편하게 사용할 제품 추천",category:"",top_k:5}));
  assert.equal(result.items[0].product_id,"p3");
  assert.deepEqual(new Set(result.items.map((item:any)=>item.product_id)),new Set(["p1","p2","p3"]));
 },baseChunks,products,async()=>vector(.95,.02),manifest);
});

test("a title match outside the requested category keeps semantic fallback inside the category",async()=>{
 const products:FixtureProduct[]=[
  {...baseProducts[0],product_payload:{title:"하이드로 크림",features:{product_type:"크림"}}},
  {...baseProducts[1],product_payload:{title:"수분 토너 패드",features:{product_type:"토너 패드"}}},
  {...baseProducts[2],product_payload:{title:"에센스",features:{product_type:"에센스"}}}
 ];
 await withSearch(async({search})=>{
  const result=await search(request({query:"에센스",original_question:"에센스 추천",category:"beauty",top_k:5}));
  assert.deepEqual(result.items.map((item:any)=>item.product_id),["p1","p2"]);
 },baseChunks,products,async()=>vector(1,.05));
});

test("unsupported filters, preferences, profile switches, and top_k above ten are rejected",async()=>{
 await withSearch(async({search})=>{
   await assert.rejects(()=>search(request({filters:{brand:"example"}})),/unsupported.*filter/i);
   await assert.rejects(()=>search(request({preferences:["quiet"]})),/unsupported.*preference/i);
   await assert.rejects(()=>search(request({top_k:11})),/top_k/i);
   await assert.rejects(()=>search({...request(),profile:"other_profile"}),/unsupported.*field/i);
 });
});

test("retrieval output is bounded by top_k and five unique source IDs per product",async()=>{
 const chunks=Array.from({length:8},(_,i)=>chunk({id:`c-${i}`,productId:"p1",type:"review",
   text:"무선 헤드폰 사용감이 좋아요",embedding:vector(1,.05),sourceId:i===7?"r-0":`r-${i}`}));
 await withSearch(async({search})=>{
   const result=await search(request({top_k:1}));
   assert.equal(result.items.length,1);
   assert.equal(result.items[0].evidence.length,5);
   assert.equal(new Set(result.items[0].evidence.map((e:any)=>e.source_id)).size,5);
 },chunks,[baseProducts[0]]);
});

test("local retrieval supports ten bounded products while keeping evidence IDs unique",async()=>{
 const products:FixtureProduct[]=Array.from({length:12},(_,i)=>({product_id:`p-${i}`,category:"beauty",
   dataset_version:VERSION,product_payload:{title:`무선 헤드폰 ${i}`}}));
 const chunks=products.map((row,i)=>chunk({id:`ten-${i}`,productId:row.product_id,type:"review",
   text:"무선 헤드폰 착용감이 좋아요",embedding:vector(1,.05),sourceId:`review-${i}`}));
 await withSearch(async({search})=>{
   const result=await search(request({top_k:10}));
   assert.equal(result.items.length,10);
   assert.equal(new Set(result.items.map((item:any)=>item.product_id)).size,10);
   assert.equal(result.search_trace.fusedProductCount,12);
 },chunks,products);
});

test("mixed dataset versions and incomplete product mappings fail closed during load",async()=>{
 const mixed=[...baseChunks.slice(0,2),chunk({id:"bad-version",productId:"p1",type:"review",text:"좋아요",
   embedding:vector(1),version:"other-version"})];
 await assert.rejects(()=>withSearch(async()=>undefined,mixed,baseProducts),/dataset version/i);
 await assert.rejects(()=>withSearch(async()=>undefined,baseChunks,[baseProducts[0]]),/product mapping/i);
});

test("query embedding must match the stored finite 384-dimensional vector contract",async()=>{
 await withSearch(async({search})=>{
   await assert.rejects(()=>search(request()),/384.*dimension|embedding.*dimension/i);
 },baseChunks,baseProducts,async()=>[1,2,3]);
 await assert.rejects(()=>withSearch(async()=>undefined,
   [chunk({id:"bad-vector",productId:"p1",type:"review",text:"무선 헤드폰",embedding:[1,2,3]})],
   [baseProducts[0]]),/384.*dimension|embedding.*dimension/i);
});

test("indexed category is applied and raw source metadata is not reconstructed",async()=>{
 await withSearch(async({search})=>{
   const result=await search(request());
   assert.equal(result.items.some((x:any)=>x.product_id==="p3"),false);
   assert.deepEqual(result.items[0].evidence[0].source_metadata,baseChunks[0].source_metadata);
 });
});

test("collected and synthetic product-level reviews preserve source kind and null variant",async()=>{
 const real=chunk({id:"real-null",productId:"p1",type:"review",text:"무선 헤드폰 편해요",embedding:vector(1),sourceId:"real-review",metadata:{source_kind:"REAL",synthetic:false,variant_id:null}});
 const synthetic=chunk({id:"synthetic-null",productId:"p2",type:"review",text:"무선 헤드폰 착용감",embedding:vector(1),sourceId:"synthetic-review",metadata:{source_kind:"SYNTHETIC",synthetic:true,variant_id:null}});
 await withSearch(async({search})=>{
  const result=await search(request());assert.equal(result.items.length,2);
  for(const item of result.items)assert.equal(item.evidence[0].source_metadata.variant_id,null);
  assert.deepEqual(new Set(result.items.map((item:any)=>item.evidence[0].source_metadata.source_kind)),new Set(["REAL","SYNTHETIC"]));
  const parsed=parseV4Response(result,VERSION);assert.equal(parsed.items[0].evidence[0].variantId,null);
 },[real,synthetic],baseProducts.slice(0,2));
});

test("manifest selects a different encoder and category, and rejects corpus substitution before embedding",async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),"codyssey-manifest-rag-"));
 try{
  const rows=[{...baseChunks[3],embedding:[1,0],embedding_model:"org/audio-encoder"}];
  const evidence=rows.map(x=>JSON.stringify(x)).join("\n")+"\n";
  const products=JSON.stringify(baseProducts[2])+"\n";
  await writeFile(join(dataDir,"evidence_chunks.jsonl"),evidence);
  await writeFile(join(dataDir,"indexed_products.jsonl"),products);
  const manifest=parseDatasetManifest({schemaVersion:1,datasetId:"audio",datasetVersion:VERSION,
   dataClass:"SYNTHETIC_PRODUCT",catalogSource:"test_items",categories:["audio"],
   embedding:{model:"org/audio-encoder",dimensions:2,queryRevision:"a".repeat(40),documentRevision:null},
   files:{evidenceSha256:createHash("sha256").update(evidence).digest("hex"),
    indexedProductsSha256:createHash("sha256").update(products).digest("hex")}});
  let embedded=0;
  const mod=await modulePromise;assert.ok(mod);
  const local=await mod.createLocalRagSearch({dataDir,embedQuery:async()=>{embedded++;return [1,0];},manifest} as never);
  assert.equal(local.stats.embeddingModel,"org/audio-encoder");
  assert.equal(local.stats.vectorDimensions,2);
  const result=await local.search(request({category:"audio"}));
  assert.equal(result.items[0].product_id,"p3");assert.equal(embedded,1);
  await writeFile(join(dataDir,"indexed_products.jsonl"),products+"\n");
  await assert.rejects(()=>mod.createLocalRagSearch({dataDir,embedQuery:async()=>[1,0],manifest} as never),/manifest/i);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
