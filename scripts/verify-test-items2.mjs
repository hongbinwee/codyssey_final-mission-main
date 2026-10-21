import {readFile,writeFile} from 'node:fs/promises';
import {streamDatasetJsonl} from '../src/brain/local-rag.ts';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const folder=resolve(process.argv[2]);
const manifest=JSON.parse(await readFile(folder+'/metadata/export_manifest.json','utf8'));
const version='test_items2:v6.1-review-refined:sha256=94681a28271ca9b1:products=1500:reviews=46100';
if(manifest.dataset_version!==version)throw Error('unexpected test_items2 version');
const rows=async path=>(await readFile(path,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const source=folder+'/database_exports/toss/test_items2',rag=folder+'/database_exports/toss_rag/rag';
const [products,variants,reviews,indexed]=await Promise.all(['products','product_variants','reviews'].map(t=>rows(source+'/'+t+'.jsonl')).concat(rows(rag+'/indexed_products.jsonl')));
const ps=new Map(products.map(x=>[x.id,x])),vs=new Map(variants.map(x=>[x.id,x])),rs=new Map(reviews.map(x=>[x.id,x]));
if(products.length!==1500||variants.length!==1917||reviews.length!==46100||ps.size!==1500||vs.size!==1917||rs.size!==46100)throw Error('counts or duplicate IDs');
if(variants.some(v=>!ps.has(v.product_id))||reviews.some(r=>!ps.has(r.product_id)||r.variant_id!==null&&vs.get(r.variant_id)?.product_id!==r.product_id))throw Error('source FK mismatch');
if(indexed.length!==1500||new Set(indexed.map(p=>p.product_id)).size!==1500||indexed.some(p=>!ps.has(p.product_id)||p.category!==ps.get(p.product_id).category||p.dataset_version!==version))throw Error('index/source product mismatch');
const categories={},kinds={},nullVariants={};
for(const r of reviews){if(!['REAL','SYNTHETIC'].includes(r.source_kind)||!Number.isInteger(r.rating)||r.rating<1||r.rating>5)throw Error('invalid source review');kinds[r.source_kind]=(kinds[r.source_kind]??0)+1;if(r.variant_id===null)nullVariants[r.source_kind]=(nullVariants[r.source_kind]??0)+1;}
const hash=createHash('sha256'),seen=new Set(),sourceReviewIds=new Set();let chunks=0,reviewChunks=0,productChunks=0;
for await(const c of streamDatasetJsonl(rag+'/evidence_chunks.jsonl',part=>{hash.update(part);})){
 if(seen.has(c.chunk_id)||c.dataset_version!==version||c.embedding_model!==manifest.embedding_model||c.run_id!==manifest.run_id||!ps.has(c.product_id)||ps.get(c.product_id).category!==c.category||!Array.isArray(c.embedding)||c.embedding.length!==384||!c.embedding.every(Number.isFinite))throw Error('invalid chunk identity, version, or vector at '+chunks);
 seen.add(c.chunk_id);chunks++;categories[c.category]=(categories[c.category]??0)+1;
 if(c.source_type==='review'){
  reviewChunks++;const r=rs.get(c.source_id),m=c.source_metadata;
  if(!r||r.product_id!==c.product_id||r.source_kind!==m.source_kind||m.synthetic!==(r.source_kind==='SYNTHETIC')||r.variant_id!==m.variant_id||r.source_ref!==m.source_ref||r.rating!==m.rating||!r.body.includes(c.evidence_text))throw Error('review provenance mismatch at '+chunks);
  if(Array.from(r.body).slice(c.start_offset,c.end_offset).join('')!==c.evidence_text)throw Error('review offset mismatch at '+chunks);
  sourceReviewIds.add(r.id);
 }else if(c.source_type==='product'){productChunks++;if(c.source_id!==c.product_id)throw Error('product source mismatch');}
 else throw Error('unsupported source type');
}
if(chunks!==114106||reviewChunks!==76187||productChunks!==37919||sourceReviewIds.size!==46100)throw Error('incomplete corpus');
const evidenceSha256=hash.digest('hex'),indexedProductsSha256=createHash('sha256').update(await readFile(rag+'/indexed_products.jsonl')).digest('hex');
const runtimeManifest={schemaVersion:1,datasetId:'test_items2',datasetVersion:version,dataClass:'CANDIDATE',catalogSource:'test_items2',categories:['beauty','fashion','food','living'],embedding:{model:manifest.embedding_model,dimensions:384,queryRevision:'e8f8c211226b894fcb81acc59f3b34ba3efd5f42',documentRevision:null},files:{evidenceSha256,indexedProductsSha256}};
await writeFile(folder+'/runtime-manifest.json',JSON.stringify(runtimeManifest,null,2),{flag:'wx'});
const result={status:'PASS',version,products:ps.size,variants:vs.size,reviews:rs.size,kinds,nullVariants,chunks,reviewChunks,productChunks,categories,reviewIdsCovered:sourceReviewIds.size,vectorDimensions:384,evidenceSha256,indexedProductsSha256,classification:'CANDIDATE - not a final quality approval'};
await writeFile(folder+'/local-integrity-results.json',JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result));
