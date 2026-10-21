import test from 'node:test';
import assert from 'node:assert/strict';
import {MemorySaver} from '@langchain/langgraph';
import {buildReviewAnalysisExplanation} from '../../src/brain/review-analysis-response.ts';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import {currentDatasetResult} from '../../src/brain/dataset-state.ts';
import {FencedTurns} from '../../src/brain/fenced-turns.ts';
import {routeBrainMessage} from '../../src/brain/routing.ts';
import {resolveShoppingPlan} from '../../src/brain/shopping-plan.ts';
import type {EvidenceRecord,ProductCandidate} from '../../src/brain/contracts.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';

type Opinion='POSITIVE'|'NEGATIVE'|'MIXED'|'UNRELATED'|'UNCERTAIN';
type ProductAnalysis={productId:string;variantId?:string;name:string;displayIndex:number;status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE';
 totalMatching:number;fetchedCount:number;uniqueCount:number;duplicateCount:number;excludedCount:number;
 counts:{positive:number;negative:number;mixed:number;unrelated:number;uncertain:number};
 countsBySource:Record<'REAL'|'SYNTHETIC',{positive:number;negative:number;mixed:number;unrelated:number;uncertain:number}>;
 evidence:{id:string;sourceId:string;productId:string;variantId:string|null;sourceKind:'REAL'|'SYNTHETIC';sourceRef:string;text:string;opinion:Opinion}[];limitations:string[]};
type Analysis={status:'READY'|'PARTIAL'|'UNAVAILABLE'|'NEEDS_TARGET';aspect:string;aspectLabel:string;focus:'ALL'|'CONS';compare:boolean;
 datasetVersion?:string;method:'CONSERVATIVE_RULES';products:ProductAnalysis[]};
const emptyCounts=()=>({positive:0,negative:0,mixed:0,unrelated:0,uncertain:0});
function product(id:string):ProductCandidate{return {productId:id,variantId:`${id}-v`,productName:`상품 ${id}`,unitPriceWon:20000,shippingFeeWon:0,
 rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{},commerceVerified:true,sourceKind:'REAL',datasetVersion:'qa13'};}
function evidence(id:string,productId:string,opinion:Opinion,sourceKind:'REAL'|'SYNTHETIC'='REAL',variantId:string|null=`${productId}-v`):ProductAnalysis['evidence'][number]{
 return {id,sourceId:id,productId,variantId,sourceKind,sourceRef:'Commerce',text:opinion==='POSITIVE'?'촉촉해서 좋아요.':opinion==='NEGATIVE'?'보습력이 부족해 건조해요.':'촉촉하지만 끈적여요.',opinion};
}
function analyzed(id:string,displayIndex:number,opinionRows:ProductAnalysis['evidence'],status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE'='COMPLETE'):ProductAnalysis{
 const counts=emptyCounts(),countsBySource={REAL:emptyCounts(),SYNTHETIC:emptyCounts()};
 for(const row of opinionRows){const key=row.opinion==='POSITIVE'?'positive':row.opinion==='NEGATIVE'?'negative':row.opinion==='MIXED'?'mixed':row.opinion==='UNRELATED'?'unrelated':'uncertain';counts[key]++;countsBySource[row.sourceKind][key]++;}
 return {productId:id,variantId:`${id}-v`,name:`상품 ${id}`,displayIndex,status,totalMatching:opinionRows.length,fetchedCount:opinionRows.length,
  uniqueCount:opinionRows.length,duplicateCount:0,excludedCount:0,counts,countsBySource,evidence:opinionRows,limitations:[]};
}
function analysis(products:ProductAnalysis[],overrides:Partial<Analysis>={}):Analysis{return {status:'READY',aspect:'moisturizing',aspectLabel:'보습력',focus:'ALL',compare:true,
 datasetVersion:'qa13',method:'CONSERVATIVE_RULES',products,...overrides};}
function reviewRoute(){return {kind:'REVIEW_ANALYSIS',search:false,reviewAnalysis:{displayIndexes:[1,2,3],aspect:'moisturizing',focus:'ALL',compare:true}} as never;}
function fixture(options:{fencing?:unknown;datasetVersion?:string;route?:(message:string)=>unknown}={}){
 const calls={route:0,intent:0,retrieval:0,review:0,responder:0,failResponder:false,inputs:[] as unknown[]};
 const graph=createPersistentResearchGraph({datasetVersion:options.datasetVersion??'qa13',route:async(message)=>{calls.route++;return (options.route?.(message)??(message.includes('리뷰')?reviewRoute():routeBrainMessage(message))) as never;},
  conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[],put:async()=>{},delete:async()=>false},
  intent:{extract:async(userMessage)=>{calls.intent++;return {query:userMessage.includes('로션')?'로션':'수분크림',queryMode:'SET' as const,budgetMode:'CLEAR' as const,context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};}},
  retriever:{search:async({query})=>{calls.retrieval++;const ids=query.includes('로션')?['l1','l2','l3']:['b','a','c'];return {candidates:ids.map(product),evidence:[]};}},
  reviewAnalysis:async(input)=>{calls.review++;calls.inputs.push(input);return analysis(input.products.map((row,index)=>analyzed(row.productId,row.displayIndex,[evidence(`review-${index}`,row.productId,'POSITIVE')])));},
 },new MemorySaver() as never,options.fencing?{tryAcquire:async()=>({assertHeld:async()=>{},release:async()=>{}})} as never:undefined,
 options.fencing as never,async({ranking})=>{calls.responder++;if(calls.failResponder)throw Error('LLM timeout');return {kind:'VERIFIED_CANDIDATES',text:'추천 결과',limitations:[],items:ranking.ranked.map(row=>({
  productId:row.candidate.productId,variantId:row.candidate.variantId,name:row.candidate.productName??'상품',totalPriceWon:20000,evidenceIds:[],indicators:[],
 }))};});
 const turn=(userMessage:string,id:string)=>graph.invoke({actorUserId:'u-qa13',conversationId:'qa13-conversation',requestId:`r-${id}`,clientActionId:id,userMessage});
 return {turn,calls};
}

test('structured analysis summarizes verified counts, ties and representative source quotes without mixing REAL/SYNTHETIC',()=>{
 const first=analyzed('p1',1,[evidence('real-p','p1','POSITIVE'),evidence('real-p2','p1','POSITIVE'),evidence('real-n','p1','NEGATIVE')]);
 first.countsBySource.SYNTHETIC.positive=9;
 first.evidence.push(evidence('fake-rank','p1','POSITIVE','SYNTHETIC'));
 first.counts.positive++;first.uniqueCount++;first.fetchedCount++;
 const second=analyzed('p2',2,[evidence('real-p2','p2','POSITIVE'),evidence('real-p2b','p2','POSITIVE')]);
 const result=buildReviewAnalysisExplanation(analysis([first,second]));
 assert.equal(result.kind,'REVIEW_ANALYSIS');assert.deepEqual(result.items,[]);
 assert.deepEqual(result.reviewAnalysis?.products.map(row=>row.productId),['p1','p2']);
 assert.match(result.text,/상품 p1/);assert.match(result.text,/보습력/);assert.match(result.text,/긍정 2건/);
 assert.match(result.text,/동률|공동/);assert.match(result.text,/수집 후기 3건/);
 assert.deepEqual(result.citations?.map(row=>row.sourceId),['real-p','real-n','real-p2','real-p2b']);
 assert.ok(result.citations?.every(row=>row.sourceKind==='REAL'));
});

test('REAL comparison permits positive 2 vs 0 when both products have related REAL opinions',()=>{
 const first=analyzed('p1',1,[evidence('real-p1','p1','POSITIVE'),evidence('real-p1b','p1','POSITIVE')]);
 const second=analyzed('p2',2,[evidence('real-n2','p2','NEGATIVE')]);
 const result=buildReviewAnalysisExplanation(analysis([first,second]));
 assert.match(result.text,/2위/);assert.match(result.text,/1위/);
 assert.deepEqual(result.citations?.map(row=>row.sourceKind),['REAL','REAL','REAL']);
});

test('complete all-zero REAL positive counts share first place without claiming a positive opinion',()=>{
 const first=analyzed('p1',1,[evidence('real-n1','p1','NEGATIVE')]);
 const second=analyzed('p2',2,[evidence('real-m2','p2','MIXED')]);
 const result=buildReviewAnalysisExplanation(analysis([first,second]));
 assert.match(result.text,/긍정 0건/);
 assert.equal((result.text.match(/공동 1위/g)??[]).length,2);
});

test('SYNTHETIC-only counts are labeled separately and never become a review rank',()=>{
 const first=analyzed('p1',1,[evidence('syn-p1','p1','POSITIVE','SYNTHETIC')]);
 const second=analyzed('p2',2,[evidence('syn-p2','p2','POSITIVE','SYNTHETIC')]);
 const result=buildReviewAnalysisExplanation(analysis([first,second]));
 assert.match(result.text,/합성 후기/);assert.match(result.text,/긍정 1건/);
 assert.doesNotMatch(result.text,/(?:공동\s*)?\d+위/);
 assert.ok(result.limitations.some(row=>/합성/.test(row)));
});

test('a CONS request with no related REAL opinions says none were found',()=>{
 const product=analyzed('p1',1,[evidence('real-unrelated','p1','UNRELATED')]);
 const result=buildReviewAnalysisExplanation(analysis([product],{compare:false,focus:'CONS'}));
 assert.match(result.text,/부정·혼재 의견을 찾지 못/);
});

test('CONS comparisons summarize negative and mixed counts without ranking or positive counts',()=>{
 const first=analyzed('p1',1,[evidence('negative-p1','p1','NEGATIVE'),evidence('positive-p1','p1','POSITIVE')]);
 const second=analyzed('p2',2,[evidence('mixed-p2','p2','MIXED')]);
 const result=buildReviewAnalysisExplanation(analysis([first,second],{focus:'CONS',compare:true}));
 assert.match(result.text,/보습력에 대한 부정·혼재 의견을 상품별로 정리/);
 assert.match(result.text,/부정 1건, 혼재 0건/);assert.match(result.text,/부정 0건, 혼재 1건/);
 assert.doesNotMatch(result.text,/긍정 \d+건|(?:공동\s*)?\d+위/);
});

test('partial and insufficient analyses do not present complete-result counts as full statistics',()=>{
 const partial=analyzed('p1',1,[evidence('uncertain','p1','UNCERTAIN')],'PARTIAL');
 partial.uniqueCount=1;partial.excludedCount=2;partial.totalMatching=9;partial.fetchedCount=3;
 const result=buildReviewAnalysisExplanation(analysis([partial],{status:'PARTIAL'}));
 assert.match(result.text,/일부|완료되지/);assert.match(result.limitations.join(' '),/전체|표본|완료/);
 assert.doesNotMatch(result.text,/긍정 0건.*전체/);
});

test('context review analysis bypasses retrieval and recommendation LLM while keeping the original displayed order',async()=>{
 const f=fixture();
 const first=await f.turn('수분크림 추천해줘','recommend');
 assert.deepEqual(first.explanation?.items.map(row=>row.productId),['b','a','c']);
 assert.deepEqual(first.shoppingPlan?.lastDisplayedProducts?.map(row=>[row.productId,row.variantId,row.displayIndex]),[
  ['b','b-v',1],['a','a-v',2],['c','c-v',3],
 ]);
 const result=await f.turn('1~3순위 보습력 리뷰 비교해줘','analyze');
 assert.equal(result.intentKind,'REVIEW_ANALYSIS');assert.equal(result.explanation?.kind,'REVIEW_ANALYSIS');
 assert.deepEqual(result.shoppingPlan?.lastDisplayedProducts,first.shoppingPlan?.lastDisplayedProducts);
 assert.deepEqual((f.calls.inputs[0] as {products:{productId:string;displayIndex:number}[]}).products.map(row=>[row.productId,row.displayIndex]),[
  ['b',1],['a',2],['c',3],
 ]);
 assert.deepEqual([f.calls.intent,f.calls.retrieval,f.calls.responder,f.calls.review],[1,1,1,1]);
});

test('a new product search clears old displayed products before they can be resolved again',async()=>{
 const f=fixture();await f.turn('수분크림 추천해줘','first');
 const second=await f.turn('로션 추천해줘','new-product-search');
 assert.deepEqual(second.shoppingPlan?.lastDisplayedProducts?.map(row=>row.productId),['l1','l2','l3']);
 assert.deepEqual(second.shoppingPlan?.lastDisplayedProductIds,['l1','l2','l3']);
});

test('missing review context returns a typed identification response without retrieval',async()=>{
 const f=fixture();
 const result=await f.turn('1순위 보습력 리뷰 찾아줘','no-context');
 assert.equal(result.intentKind,'REVIEW_ANALYSIS');assert.equal(result.explanation?.reviewAnalysis?.status,'NEEDS_TARGET');
 assert.equal(f.calls.review,0);assert.equal(f.calls.retrieval,0);assert.equal(f.calls.responder,0);
 assert.match(result.explanation!.text,/추천|상품/);
});

test('fenced canonical receipts accept planless REVIEW_ANALYSIS results',async()=>{
 const serialized=JSON.stringify({conversationId:'c',messageId:'m',clientActionId:'action',intentKind:'REVIEW_ANALYSIS',
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},explanation:{kind:'REVIEW_ANALYSIS',items:[],limitations:[],text:'분석 결과'},
  trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:0}});
 const db={query:async()=>[{completed_result:serialized,checkpoint_thread_id:'attempt'}]};
 const latest=await new FencedTurns(db as never).latest('c');
 assert.equal(latest?.result.explanation?.kind,'REVIEW_ANALYSIS');assert.equal(latest?.result.shoppingPlan,undefined);
});

test('review analysis response remains independent of any recommendation model timeout',async()=>{
 const f=fixture();await f.turn('수분크림 추천해줘','recommend');
 const before=f.calls.responder;f.calls.failResponder=true;
 const result=await f.turn('1순위 보습력 리뷰 찾아줘','analyze-after-model-timeout');
 assert.equal(f.calls.responder,before);assert.equal(result.explanation?.kind,'REVIEW_ANALYSIS');
 assert.ok(result.explanation?.reviewAnalysis?.products.length);
});

test('new task shopping plan does not inherit review target order',()=>{
 const previous={query:'수분크림',maxTotalWon:null,requiredConditions:[],currentPreferences:{},revision:3,
  lastDisplayedProductIds:['p1','p2'],lastDisplayedProducts:[
   {productId:'p1',variantId:'v1',name:'상품1',displayIndex:1},{productId:'p2',variantId:'v2',name:'상품2',displayIndex:2},
  ]};
 const next=resolveShoppingPlan(previous,{query:'로션',queryMode:'SET',budgetMode:'CLEAR',context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}});
 assert.equal(next.lastDisplayedProducts,undefined);assert.equal(next.lastDisplayedProductIds,undefined);
});

test('old dataset display targets stay cleared through a social turn before a review request',async()=>{
 let canonical={datasetVersion:'old',conversationId:'qa13-conversation',messageId:'old',clientActionId:'old-action',intentKind:'SHOPPING_SEARCH',
  shoppingPlan:{query:'수분크림',revision:2,maxTotalWon:25000,requiredConditions:['저자극'],currentPreferences:{price_priority:'value'},
   lastDisplayedProductIds:['old-p1'],lastDisplayedProducts:[{productId:'old-p1',variantId:'old-v1',name:'이전 상품',displayIndex:1}]},
  ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},
  explanation:{kind:'VERIFIED_CANDIDATES',text:'이전 상품',items:[{productId:'old-p1',variantId:'old-v1',name:'이전 상품'}],limitations:[]},
  trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:0}} as unknown as ResearchResult;
 let generation=0;
 const fencing={latest:async()=>({result:canonical,threadId:'previous'}),
  claim:async()=>({kind:'run' as const,generation:String(++generation),attemptId:`attempt-${generation}`,prior:canonical}),
  publish:async(_input:unknown,_claim:unknown,result:ResearchResult)=>{canonical=result;}};
 const f=fixture({fencing,route:message=>message==='고마워'?{kind:'SOCIAL',search:false,text:'별말씀을요.'}:reviewRoute()});
 const social=await f.turn('고마워','social');
 assert.equal(social.explanation?.kind,'CONVERSATION');
 assert.equal(social.shoppingPlan?.maxTotalWon,25000);
 assert.deepEqual(social.shoppingPlan?.requiredConditions,['저자극']);
 assert.deepEqual(social.shoppingPlan?.currentPreferences,{price_priority:'value'});
 assert.equal(social.shoppingPlan?.lastDisplayedProductIds,undefined);
 assert.equal(social.shoppingPlan?.lastDisplayedProducts,undefined);
 const result=await f.turn('1순위 보습력 리뷰 찾아줘','review-after-dataset-switch');
 assert.equal(result.explanation?.reviewAnalysis?.status,'NEEDS_TARGET');
 assert.equal(f.calls.review,0);assert.equal(f.calls.retrieval,0);
 assert.deepEqual(canonical.shoppingPlan?.lastDisplayedProducts,undefined);
 assert.deepEqual(canonical.shoppingPlan?.lastDisplayedProductIds,undefined);
 assert.deepEqual(canonical.explanation?.kind,'REVIEW_ANALYSIS');
});
