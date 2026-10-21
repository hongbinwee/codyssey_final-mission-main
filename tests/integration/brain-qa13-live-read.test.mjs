import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {openExternalCatalog} from '../../src/external-catalog.ts';
import {createReviewAnalysisLookup} from '../../src/brain/review-analysis.ts';
import {parseContextReviewRequest,resolveReviewTargets} from '../../src/brain/review-reference.ts';
import {buildReviewAnalysisExplanation} from '../../src/brain/review-analysis-response.ts';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';

// Explicit opt-in only: SELECT-only DGX, supplied public product IDs, no LLM or Brain DB writes.
// QA13_SETTINGS_MODULE exports externalSettings and remains outside version control.
const enabled=process.env.QA13_READONLY_LIVE==='1';
test('QA13 real external Commerce corpus, prior display references and evidence integrity',{
 skip:!enabled,timeout:40_000,
},async()=>{
 const modulePath=process.env.QA13_SETTINGS_MODULE;
 assert.ok(modulePath,'A server-owned settings module path is required');
 const targets=JSON.parse(process.env.QA13_DISPLAYED_PRODUCTS_JSON??'[]');
 const version=process.env.QA13_EXPECTED_DATASET_VERSION;
 assert.equal(targets.length,3);assert.ok(version);
 const {externalSettings}=await import(pathToFileURL(modulePath).href);
 const external=await openExternalCatalog(externalSettings,'test_items2');
 assert.ok(external);
 try{
  const [state]=await external.db.unsafe("SELECT current_setting('transaction_read_only') AS read_only");
  assert.equal(state.read_only,'on');
  const previous={conversationId:'read-only-probe',messageId:'existing-recommendation',datasetVersion:version,
   ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
   shoppingPlan:{query:'수분크림',maxTotalWon:null,requiredConditions:[],currentPreferences:{},revision:1,
    lastDisplayedProductIds:targets.map(p=>p.productId),lastDisplayedProducts:targets},
   explanation:{kind:'VERIFIED_CANDIDATES',text:'',items:[],limitations:[]}};
  const request=parseContextReviewRequest('1~3순위 촉촉한 긍정 리뷰 많은 순으로 비교해줘');
  assert.ok(request);
  const selected=resolveReviewTargets(request,previous,version);
  assert.equal(selected.needsTarget,false);assert.deepEqual(selected.products,targets);
  const started=performance.now();
  const analysis=await createReviewAnalysisLookup(external.catalog,version)({request,products:selected.products});
  assert.equal(analysis.status,'READY');assert.equal(analysis.datasetVersion,version);
  assert.deepEqual(analysis.products.map(p=>p.productId),targets.map(p=>p.productId));
  const output=[];
  for(const product of analysis.products){
   assert.equal(product.status,'COMPLETE');
   const [actual]=await external.db.unsafe(
    'SELECT count(*)::int AS count FROM test_items2.reviews WHERE product_id=$1',[product.productId]);
   assert.equal(product.fetchedCount,actual.count);
   assert.equal(Object.values(product.counts).reduce((a,b)=>a+b,0),product.uniqueCount);
   for(const key of Object.keys(product.counts)){
    assert.equal(product.counts[key],product.countsBySource.REAL[key]+product.countsBySource.SYNTHETIC[key]);
   }
   const sourceRows=await external.catalog.getReviewsByIds({product_id:product.productId,
    review_ids:[...new Set(product.evidence.map(e=>e.sourceId))]});
   for(const evidence of product.evidence){
    const source=sourceRows.find(row=>row.id===evidence.sourceId);
    assert.ok(source);assert.equal(source.product_id,product.productId);
    assert.equal(source.variant_id,evidence.variantId);
    assert.ok(source.variant_id===null||source.variant_id===product.variantId);
    assert.equal(source.source_kind,evidence.sourceKind);assert.equal(source.source_ref,evidence.sourceRef);
    assert.ok(source.body.includes(evidence.text));
   }
   output.push({productId:product.productId,status:product.status,fetched:product.fetchedCount,
    unique:product.uniqueCount,duplicates:product.duplicateCount,excluded:product.excludedCount,
    countsBySource:product.countsBySource,verifiedExcerpts:product.evidence.length});
  }
  const explanation=buildReviewAnalysisExplanation(analysis);
  assert.equal(explanation.kind,'REVIEW_ANALYSIS');assert.equal(explanation.items.length,0);
  assert.ok(explanation.text.includes('보습'));
  // The starting recommendation is a fixture; follow-up Graph -> Commerce reads are real.
  const candidates=[];
  for(const target of targets){
   const detail=await external.catalog.getProduct({product_id:target.productId});assert.equal(detail.ok,true);
   const variant=detail.data.variants.find(v=>v.variant_id===target.variantId);assert.ok(variant);
   candidates.push({productId:target.productId,variantId:target.variantId,productName:detail.data.product.name,
    unitPriceWon:variant.unit_price_won,shippingFeeWon:detail.data.shipping_fee_won,commerceVerified:true,
    datasetVersion:version,rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
    conditions:{},facets:{}});
  }
  const calls={retrieval:0,description:0,lookup:0};
  const lookup=createReviewAnalysisLookup(external.catalog,version);
  const graph=createPersistentResearchGraph({datasetVersion:version,route:routeBrainMessage,
   conversations:{assertOwned:async(actor,id)=>{assert.equal(actor,'tester_05');assert.equal(id,'qa13-live-memory');},
    appendUserMessage:async()=>crypto.randomUUID()},
   memory:{list:async()=>[],put:async()=>assert.fail('No memory writes'),delete:async()=>assert.fail('No memory writes')},
   intent:{extract:async()=>({query:'수분크림',queryMode:'SET',budgetMode:'CLEAR',
    context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}})},
   retriever:{search:async()=>{calls.retrieval++;return {candidates,evidence:[]};}},
   reviewAnalysis:async(input)=>{calls.lookup++;return lookup(input);},
  },new MemorySaver(),undefined,undefined,async()=>{
   calls.description++;return {kind:'VERIFIED_CANDIDATES',text:'검증용 시작 추천 목록',limitations:[],
    items:candidates.map(p=>({productId:p.productId,variantId:p.variantId,name:p.productName,
     totalPriceWon:p.unitPriceWon+p.shippingFeeWon,evidenceIds:[],indicators:[]}))};
  });
  const turn=message=>graph.invoke({actorUserId:'tester_05',conversationId:'qa13-live-memory',
   requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage:message});
  await turn('수분크림 추천해줘');
  const one=await turn('1순위 촉촉한 리뷰 찾아줘');
  assert.equal(one.explanation.reviewAnalysis.status,'READY');
  assert.deepEqual(one.explanation.reviewAnalysis.products.map(p=>p.productId),[targets[0].productId]);
  const compared=await turn('이 중 촉촉하다는 리뷰 제일 많은 거');
  assert.equal(compared.explanation.reviewAnalysis.status,'READY');
  assert.deepEqual(compared.explanation.reviewAnalysis.products.map(p=>p.productId),targets.map(p=>p.productId));
  const cons=await turn('2순위 제품에서 보습력이 부족하다는 리뷰를 보여줘');
  assert.equal(cons.explanation.reviewAnalysis.status,'READY');
  assert.equal(cons.explanation.reviewAnalysis.focus,'CONS');
  assert.deepEqual(cons.explanation.reviewAnalysis.products.map(p=>p.productId),[targets[1].productId]);
  assert.ok(cons.explanation.reviewAnalysis.products[0].evidence.every(e=>['NEGATIVE','MIXED','UNCERTAIN'].includes(e.opinion)));
  assert.deepEqual(calls,{retrieval:1,description:1,lookup:3});
  console.log(JSON.stringify({source:'Real DGX SELECT-only Commerce + LangGraph MemorySaver; initial recommendation fixture, no live Claude/RAG',
   datasetVersion:version,elapsedMs:Math.round(performance.now()-started),products:output,graphFollowups:3}));
 }finally{await external.close();}
});
