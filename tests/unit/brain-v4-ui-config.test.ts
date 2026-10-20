import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { createElement, isValidElement } from "react";
import type { MouseEvent, MouseEventHandler, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transpileModule, JsxEmit, ModuleKind } from "typescript";
import type { EvidenceRecord, ReviewSummaryData } from "../../src/brain/contracts.ts";

// Keep server import DB-free and prevent config.ts from reading a local .env.
const moduleHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/config.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const config = {
          port: 3000, sessionSecret: "unit-test", llmBaseUrl: "https://example.invalid",
          llmApiKey: "", llmModel: "unit-test", llmReasoningEffort: "low",
          llmApiTimeoutMs: 1000, testUserCodes: {}, llmProvider: "stub"
        };`,
      };
    }
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext },
      }).outputText,
    };
  },
});

const { brainRagConnectionFromEnv, start } = await import("../../src/server.ts");
const { signSession } = await import("../../src/session.ts");
const brainPreview = await import("../../src/web/components/BrainPreview.tsx");
const { BrainRanking, BrainReviewSummary, BrainPreferencePrompt, createRetrievalRetryEntry, canExploreBrainReply } = brainPreview;
const { BrainAnswer } = await import("../../src/web/components/BrainAnswer.tsx");
const commerceState = await import("../../src/web/components/CommerceState.tsx");
const detailResume = await import("../../src/web/detail-resume.ts");
moduleHook.deregister();

function ragConfig(env: Record<string, string | undefined>) {
  assert.equal(typeof brainRagConnectionFromEnv, "function");
  if (typeof brainRagConnectionFromEnv !== "function") return undefined;
  return brainRagConnectionFromEnv(env);
}

function renderRanking(ranking: Parameters<typeof BrainRanking>[0]["ranking"]) {
  assert.equal(typeof BrainRanking, "function");
  if (typeof BrainRanking !== "function") return "";
  return renderToStaticMarkup(createElement(BrainRanking, {
    ranking,
    onOpenProduct: () => {},
  }));
}

function renderAnswer(text:string){
  assert.equal(typeof BrainAnswer,"function");
  if(typeof BrainAnswer!=="function")return "";
  return renderToStaticMarkup(createElement(BrainAnswer,{text}));
}

test("BrainAnswer renders safe bold text, preserves paragraphs and line breaks, and wraps long content",()=>{
 const text="# 안내\n첫 줄\n둘째 줄\n\n**중요**와 `코드` <img src=x onerror=alert(1)>\n\n"+
   `${"가".repeat(240)}. 두 번째 문장입니다. 세 번째 문장입니다.`;
 const html=renderAnswer(text);
 assert.match(html,/<strong>중요<\/strong>/);
 assert.doesNotMatch(html,/\*\*|`/);
 assert.match(html,/안내\n첫 줄\n둘째 줄/);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(html,/<img\b/i);
 assert.ok((html.match(/<p/g)??[]).length>=4);
 const styles=readFileSync(new URL("../../src/web/styles.css",import.meta.url),"utf8");
 assert.match(styles,/\.brain-panel \.brain-answer p\{[^}]*white-space:pre-wrap/);
 assert.match(styles,/\.brain-panel \.brain-answer p\{[^}]*overflow-wrap:anywhere/);
 const preview=readFileSync(new URL("../../src/web/components/BrainPreview.tsx",import.meta.url),"utf8");
 assert.match(preview,/토스쇼핑 AI Brain이 요청을 살펴보고 있어요…/);
 assert.match(preview,/토스쇼핑 AI Brain/);
});

test("retrieval retry creates a fresh action while generic follow-ups are available only for safe result states",()=>{
 const pageContext={screen:"reviews",product_id:"page-product-one"};
 const retry=createRetrievalRetryEntry({text:"상품 찾아줘",clientActionId:"failed-action",conversationId:"conversation-one",pageContext},"other-conversation");
 pageContext.product_id="page-product-two";
 assert.notEqual(retry.clientActionId,"failed-action");
 assert.equal(retry.text,"상품 찾아줘");
 assert.equal(retry.conversationId,"conversation-one");
 assert.deepEqual(retry.pageContext,{screen:"reviews",product_id:"page-product-one"});
 assert.equal(retry.status,"sending");
 const base={conversation_id:"c",message_id:"m",read_only:true as const,ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},trace:{totalMs:0}};
 assert.equal(canExploreBrainReply({...base,explanation:{kind:"NO_MATCH",text:"없음",items:[],limitations:[]}}),true);
 assert.equal(canExploreBrainReply({...base,explanation:{kind:"REFERENCE_ONLY",text:"참고",items:[],limitations:[]}}),true);
 assert.equal(canExploreBrainReply({...base,explanation:{kind:"NO_MATCH",text:"검색 실패",items:[],limitations:[],failure:{code:"RETRIEVAL_UNAVAILABLE"}}}),false);
});

test('model failure keeps verified fallback reasons on recommendation cards',()=>{
 const candidate={productId:'p-fallback',variantId:'v-fallback',commerceVerified:true,productName:'확인한 상품',unitPriceWon:10000,shippingFeeWon:3000};
 const html=renderToStaticMarkup(createElement(BrainRanking,{ranking:{ranked:[{candidate,score:.5,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1},
   explanation:{kind:'VERIFIED_CANDIDATES',text:'확인한 상품을 추천해요.',items:[{productId:'p-fallback',variantId:'v-fallback',evidenceIds:[],reason:'배송비 포함 13,000원으로 예산 안이에요.'}],limitations:[],failure:{code:'MODEL_HTTP_ERROR',httpStatus:504}},onOpenProduct:()=>{}}));
 assert.match(html,/배송비 포함 13,000원으로 예산 안이에요/);assert.doesNotMatch(html,/MODEL_HTTP_ERROR|504/);
});

test('verified Commerce cards separate item, shipping and total prices; unknown and unverified values stay unknown',()=>{
 const candidate={productId:'priced',variantId:'v-priced',productName:'가격 확인 상품',
   unitPriceWon:28_000,shippingFeeWon:3_000,commerceVerified:true};
 const html=renderRanking({ranked:[{candidate,score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1});
 assert.match(html,/상품가/);assert.match(html,/28,000원/);
 assert.match(html,/배송비/);assert.match(html,/3,000원/);
 assert.match(html,/합계/);assert.match(html,/31,000원/);
 const unknown=renderRanking({ranked:[{candidate:{...candidate,shippingFeeWon:null},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1});
 assert.match(unknown,/배송비/);assert.match(unknown,/합계/);assert.match(unknown,/확인 전/);
 assert.doesNotMatch(unknown,/28,000원.*0원|0원.*28,000원/);
 const unverified=renderRanking({ranked:[{candidate:{...candidate,unitPriceWon:10_000,shippingFeeWon:0,commerceVerified:false},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1});
 assert.doesNotMatch(unverified,/10,000원|0원/);
});

test('applied review sort uses count evidence, shares tied ranks, and labels synthetic evidence',()=>{
 const candidate=(id:string,sourceKind:'REAL'|'SYNTHETIC'='REAL')=>({
  productId:id,variantId:`v-${id}`,productName:id,unitPriceWon:10_000,shippingFeeWon:0,
  commerceVerified:true,sourceKind,isSimulated:sourceKind==='SYNTHETIC',
 });
 const ranking={ranked:[
  {candidate:candidate('a'),score:1,evidenceCoverage:1,reviewSortEvidence:{aspect:'moisturizing',positiveCount:2,negativeCount:1,reviewIds:['ra1','ra2','ra3'],sourceKinds:['REAL']}},
  {candidate:candidate('b','SYNTHETIC'),score:.9,evidenceCoverage:1,reviewSortEvidence:{aspect:'moisturizing',positiveCount:2,negativeCount:0,reviewIds:['rb1','rb2'],sourceKinds:['SYNTHETIC']}},
 ],referenceOnly:[],rejected:[],evaluatedCount:2,explicitReviewSort:{aspect:'moisturizing',status:'APPLIED',scope:'RETRIEVED_REVIEWS'}} as never;
 const html=renderToStaticMarkup(createElement(BrainRanking,{ranking,onOpenProduct:()=>{},explanation:{kind:'LLM_GROUNDED',text:'',items:[
  {productId:'a',variantId:'v-a',evidenceIds:[],reason:'촉촉함 검색 후기에서 긍정 의견 2건, 아쉬움 1건을 확인했어요.'},
  {productId:'b',variantId:'v-b',evidenceIds:[],reason:'촉촉함 검색 합성 리뷰에서 긍정 의견 2건, 아쉬움 0건을 확인했어요.'},
 ],limitations:[]}}));
 assert.equal((html.match(/공동 1순위/g)??[]).length,2);
 assert.match(html,/검색된 일부 후기/);
 assert.match(html,/합성 리뷰/);
 assert.match(html,/긍정 의견 2건, 아쉬움 1건/);
});

test('applied sort does not assign a badge to a candidate with no review sample',()=>{
 const candidate=(id:string)=>({productId:id,variantId:`v-${id}`,productName:id,unitPriceWon:10_000,shippingFeeWon:0,commerceVerified:true});
 const ranking={ranked:[
  {candidate:candidate('sampled'),score:1,evidenceCoverage:1,reviewSortEvidence:{aspect:'moisturizing',positiveCount:0,negativeCount:1,reviewIds:['r-negative'],sourceKinds:['REAL']}},
  {candidate:candidate('unsampled'),score:.5,evidenceCoverage:1,reviewSortEvidence:{aspect:'moisturizing',positiveCount:0,negativeCount:0,reviewIds:[],sourceKinds:[]}},
 ],referenceOnly:[],rejected:[],evaluatedCount:2,explicitReviewSort:{aspect:'moisturizing',status:'APPLIED',scope:'RETRIEVED_REVIEWS'}} as never;
 const html=renderToStaticMarkup(createElement(BrainRanking,{ranking,onOpenProduct:()=>{},explanation:{kind:'LLM_GROUNDED',text:'',items:[
  {productId:'sampled',variantId:'v-sampled',evidenceIds:[],reason:'보습력 검색 후기에서 긍정 의견 0건, 아쉬운 의견 1건을 확인했어요.'},
  {productId:'unsampled',variantId:'v-unsampled',evidenceIds:[]},
 ],limitations:[]}}));
 assert.match(html,/sampled/);assert.match(html,/긍정 의견 0건, 아쉬운 의견 1건/);
 assert.doesNotMatch(html,/unsampled[^]*?<span class="brain-rank">/);
});

test('insufficient review sort hides rank badges and explains the sample limit',()=>{
 const candidate={productId:'insufficient',variantId:'v-insufficient',productName:'후기 부족 상품',unitPriceWon:10_000,shippingFeeWon:0,commerceVerified:true};
 const ranking={ranked:[{candidate,score:1,evidenceCoverage:1,reviewSortEvidence:{aspect:'moisturizing',positiveCount:0,negativeCount:0,reviewIds:[],sourceKinds:[]}}],
  referenceOnly:[],rejected:[],evaluatedCount:1,explicitReviewSort:{aspect:'moisturizing',status:'INSUFFICIENT',scope:'RETRIEVED_REVIEWS'}} as never;
 const html=renderToStaticMarkup(createElement(BrainRanking,{ranking,onOpenProduct:()=>{},explanation:{kind:'LLM_GROUNDED',text:'',items:[{productId:'insufficient',variantId:'v-insufficient',evidenceIds:[]}],limitations:[]}}));
 assert.doesNotMatch(html,/\d순위/);
 assert.match(html,/후기 수가 충분하지 않아/);
 assert.match(html,/전체가 아닌 일부 표본/);
});

test('review summary keeps original citations within the selected product and variant scopes',()=>{
 assert.equal(typeof BrainReviewSummary,'function');if(typeof BrainReviewSummary!=='function')return;
 const summary:ReviewSummaryData={status:'READY',focus:'ALL',datasetVersion:'dataset-v1',
  product:{id:'product-1',name:'상품 하나',variantId:'variant-1',image:'https://example.test/item.jpg'},
  evidence:[
   {id:'whole-review',productId:'product-1',variantId:null,kind:'REVIEW',sourceKind:'REAL',sourceRef:'private-ref-whole',sourceId:'private-id-whole',verified:true,datasetVersion:'dataset-v1',text:'상품 전체 후기 원문'},
   {id:'variant-review',productId:'product-1',variantId:'variant-1',kind:'REVIEW',sourceKind:'REAL',sourceRef:'private-ref-variant',sourceId:'private-id-variant',verified:true,datasetVersion:'dataset-v1',text:'선택 옵션 후기 원문'},
   {id:'other-product',productId:'product-2',variantId:null,kind:'REVIEW',sourceKind:'REAL',verified:true,datasetVersion:'dataset-v1',text:'다른 상품 후기'},
   {id:'other-variant',productId:'product-1',variantId:'variant-2',kind:'REVIEW',sourceKind:'REAL',verified:true,datasetVersion:'dataset-v1',text:'다른 옵션 후기'},
   {id:'unverified',productId:'product-1',variantId:null,kind:'REVIEW',sourceKind:'REAL',verified:false,datasetVersion:'dataset-v1',text:'미검증 후기'},
   {id:'spec',productId:'product-1',variantId:null,kind:'SPEC',sourceKind:'REAL',verified:true,datasetVersion:'dataset-v1',text:'상품 스펙'},
  ]};
 let opened:string[]=[];
 const element=BrainReviewSummary({summary,onOpenProduct:(id:string,variantId?:string)=>{opened=[id,variantId??''];},onChooseProduct:()=>{}});
 assert.ok(element);
 const html=renderToStaticMarkup(element);
 assert.match(html,/상품 하나/);assert.match(html,/상품 상세 보기/);assert.match(html,/https:\/\/example\.test\/item\.jpg/);
 assert.match(html,/상품 전체 후기 원문/);assert.match(html,/선택 옵션 후기 원문/);
 assert.match(html,/상품 단위 후기/);assert.match(html,/선택 옵션 후기/);
 assert.doesNotMatch(html,/다른 상품 후기|다른 옵션 후기|미검증 후기|상품 스펙/);
 assert.doesNotMatch(html,/private-ref|private-id/);
 const detail=findButton((element.props as {children:ReactNode}).children);assert.ok(detail);
 detail!.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
 assert.deepEqual(opened,['product-1','variant-1']);
});

test('REAL review citations describe collected author opinions without claiming verified purchase',()=>{
 assert.equal(typeof BrainReviewSummary,'function');if(typeof BrainReviewSummary!=='function')return;
 const summary:ReviewSummaryData={status:'READY',focus:'ALL',product:{id:'product-1',name:'상품'},evidence:[
  {id:'real-review',productId:'product-1',variantId:null,kind:'REVIEW',sourceKind:'REAL',verified:true,text:'작성자가 남긴 원문'},
 ]};
 const html=renderToStaticMarkup(createElement(BrainReviewSummary,{summary,onOpenProduct:()=>{},onChooseProduct:()=>{}}));
 assert.match(html,/수집 리뷰 · 작성자의 의견이에요/);assert.match(html,/상품 단위 후기/);
 assert.doesNotMatch(html,/검증된 실제 구매 후기|실제 구매가 확인된 후기/);
});

test('review summary limits displayed source excerpts to twenty verified originals of at most 1200 characters',()=>{
 assert.equal(typeof BrainReviewSummary,'function');if(typeof BrainReviewSummary!=='function')return;
 const evidence:EvidenceRecord[]=Array.from({length:20},(_,index)=>({id:`review-${index}`,productId:'product-1',variantId:null,kind:'REVIEW' as const,sourceKind:'REAL' as const,verified:true,text:`원문 ${index}`}));
 evidence.push({id:'review-over-limit',productId:'product-1',variantId:null,kind:'REVIEW',sourceKind:'REAL',verified:true,text:'20번째 이후 후기'});
 evidence.push({id:'review-too-long',productId:'product-1',variantId:null,kind:'REVIEW',sourceKind:'REAL',verified:true,text:'긴 원문 시작 '+ '가'.repeat(1200)});
 const html=renderToStaticMarkup(createElement(BrainReviewSummary,{summary:{status:'READY',focus:'ALL',product:{id:'product-1',name:'상품'},evidence},onOpenProduct:()=>{},onChooseProduct:()=>{}}));
 assert.equal((html.match(/<blockquote/g)??[]).length,20);
 assert.match(html,/원문 19/);assert.doesNotMatch(html,/20번째 이후 후기|긴 원문 시작/);
});

test('ambiguous review-summary choices show product names and send the internal selection token without rendering the ID',()=>{
 assert.equal(typeof BrainReviewSummary,'function');if(typeof BrainReviewSummary!=='function')return;
 const summary:ReviewSummaryData={status:'AMBIGUOUS',focus:'ALL',choices:[{productId:'internal-product-7',name:'선택할 상품'}],evidence:[]};
 const findChoice=(node:ReactNode):ReactElement|null=>{
  if(Array.isArray(node)){for(const child of node){const found=findChoice(child);if(found)return found;}return null;}
  if(!isValidElement(node))return null;
  const props=node.props as {children?:ReactNode;className?:string;onClick?:()=>void};
  if(props.className?.split(/\s+/).includes('brain-review-choice'))return node as ReactElement;
  return findChoice(props.children??null);
 };
 let sent='';const wired=BrainReviewSummary({summary,onOpenProduct:()=>{},onChooseProduct:(message:string)=>{sent=message;}});
 assert.ok(wired);
 const html=renderToStaticMarkup(wired);
 assert.match(html,/선택할 상품/);assert.doesNotMatch(html,/internal-product-7/);
 const wiredChoice=findChoice((wired.props as {children:ReactNode}).children);assert.ok(wiredChoice);
 ((wiredChoice!.props as {onClick:()=>void}).onClick)();
 assert.equal(sent,'리뷰 요약 상품 선택: internal-product-7');
});

test('review-summary replies are not eligible for recommendation exploration',()=>{
 const reply:Parameters<typeof canExploreBrainReply>[0]={conversation_id:'c',message_id:'m',read_only:true as const,
  explanation:{kind:'REVIEW_SUMMARY',text:'후기 요약',items:[],limitations:[],reviewSummary:{status:'NO_REVIEWS',focus:'ALL',evidence:[]}},
  ranking:{ranked:[{candidate:{productId:'ranked',variantId:'v',commerceVerified:true},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1},trace:{totalMs:0}};
 assert.equal(canExploreBrainReply(reply),false);
});

test('price preference prompt uses the requested labels and separates request, confirmation, saving, completion, and failure',()=>{
 assert.equal(typeof BrainPreferencePrompt,'function');if(typeof BrainPreferencePrompt!=='function')return;
 const base={selected:'value' as const,storedValue:null,pending:false,busy:false,error:'',onSelect:()=>{},onRequest:()=>{},onConfirm:()=>{},onDefer:()=>{}};
 const renderPrompt=(status:'idle'|'requesting'|'confirming'|'saving'|'saved'|'failed',extra:Partial<Parameters<typeof BrainPreferencePrompt>[0]>={})=>
  renderToStaticMarkup(createElement(BrainPreferencePrompt,{...base,status,...extra}));
 const idle=renderPrompt('idle');
 assert.match(idle,/이 가격 기준을 기억해둘까요\?/);
 assert.match(idle,/다음 상품 추천에도 선택한 기준을 반영할 수 있어요\./);
 assert.match(idle,/가성비를 우선해요/);assert.match(idle,/가격과 품질을 균형 있게 봐요/);assert.match(idle,/품질을 더 중요하게 생각해요/);
 assert.match(idle,/저장하기/);assert.match(idle,/원할 때 저장하고, 나중에 바꿀 수 있어요\./);
 assert.match(renderPrompt('requesting'),/저장 요청 중/);
 assert.match(renderPrompt('confirming',{pending:true}),/최종 확인/);
 assert.match(renderPrompt('saving',{pending:true}),/저장 중/);
 assert.match(renderPrompt('saved'),/저장 완료/);
 const failed=renderPrompt('failed',{pending:true,error:'저장 확인에 실패했어요. 기존에 저장한 기준은 유지돼요.'});
 assert.match(failed,/role="alert"/);assert.match(failed,/기존에 저장한 기준은 유지돼요/);assert.match(failed,/다시 확인/);
});

test('price preference prompt prevents requesting an already saved identical value',()=>{
 assert.equal(typeof BrainPreferencePrompt,'function');if(typeof BrainPreferencePrompt!=='function')return;
 const html=renderToStaticMarkup(createElement(BrainPreferencePrompt,{selected:'balanced',storedValue:'balanced',status:'idle',pending:false,busy:false,error:'',onSelect:()=>{},onRequest:()=>{},onConfirm:()=>{},onDefer:()=>{}}));
 assert.match(html,/이미 저장된 기준/);assert.doesNotMatch(html,/저장하기/);
});

test('preference confirmation accepts only the exact key and proposed value with a timestamp',()=>{
 const matches=brainPreview.isPricePreferenceConfirmation as ((value:unknown,expected:'value'|'balanced'|'performance')=>boolean)|undefined;
 assert.equal(typeof matches,'function');if(!matches)return;
 const valid={key:'price_priority',value:'performance',updatedAt:'2026-10-20T00:00:00.000Z'};
 assert.equal(matches(valid,'performance'),true);
 assert.equal(matches({...valid,key:'eye_comfort'},'performance'),false);
 assert.equal(matches({...valid,value:'balanced'},'performance'),false);
 assert.equal(matches({key:'price_priority',value:'performance'},'performance'),false);
 assert.equal(matches({...valid,updatedAt:''},'performance'),false);
 assert.equal(matches({...valid,updatedAt:123},'performance'),false);
});

test("test catalog notice identifies simulated prices and explicitly excludes purchase",()=>{
 const Notice=(commerceState as unknown as {CatalogNotice?:()=>ReactElement}).CatalogNotice;
 assert.equal(typeof Notice,"function");if(!Notice)return;
 const html=renderToStaticMarkup(createElement(Notice));
 assert.match(html,/검증 중인 데이터셋 테스트/);
 assert.match(html,/가격·재고·옵션은 시연용/);
 assert.match(html,/주문·결제할 수 없/);
});

test("read-only catalog server wires the selected schema and blocks writes before reaching business services",async()=>{
 let handler:Function|undefined;let readOnly=false;let queryCount=0;
 const db={unsafe:async(query:string)=>{
   queryCount++;
   if(query.includes('FROM pg_roles'))return [{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:'on'}];
   assert.match(query,/FROM test_items\./);return [];
 },end:async()=>{}};
 await start(0,{env:{COMMERCE_CATALOG_SOURCE:'test_items',DATABASE_URL:'postgres://unit:fixture@127.0.0.1/toss',HOST:'127.0.0.1'},
   ensureDevDb:async()=>'',connectDb:((_url:string,options?:{readOnly?:boolean})=>{readOnly=options?.readOnly===true;return db;}) as never,
   build:(async()=>({})) as never,createServer:((listener:Function)=>{handler=listener;return {
     listen:(...args:unknown[])=>{(args.at(-1) as Function)();},on:()=>{}};}) as never});
 assert.equal(readOnly,true);assert.ok(handler);
 const invoke=async(method:string,url:string)=>{
   let status=0;let body='';
   await handler!({method,url,headers:{cookie:'session='+encodeURIComponent(signSession('fixture-user','unit-test'))}},
    {writeHead:(code:number)=>{status=code;},end:(value:string)=>{body=value;},headersSent:false});
   return {status,body:JSON.parse(body)};
 };
 const products=await invoke('GET','/api/products');assert.equal(products.status,200);
 assert.equal(products.body.data.catalog_context.source,'test_items');
 const before=queryCount;
 for(const path of ['/api/cart/items','/api/checkout/confirm','/api/orders/o/cancel','/api/agent/turn']){
   const result=await invoke('POST',path);assert.equal(result.status,403);
   assert.equal(result.body.error.code,'READ_ONLY_CATALOG');
 }
 assert.equal(queryCount,before,'blocked routes must not reach any DB-backed business service');
});

function findButton(node: ReactNode): ReactElement<{
  children?: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  }>;
  return element.type === "button" ? element : findButton(element.props.children);
}

test("omitted RAG contract keeps the existing brain-rag-v1 config", () => {
  assert.deepEqual(ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/v1/search",
    BRAIN_RAG_AUDIT_ID: "legacy-audit",
  }), {
    endpoint: "https://rag.example.invalid/v1/search",
    auditId: "legacy-audit",
    token: undefined,
    contract: "brain-rag-v1",
    datasetVersion: undefined,
    category: "beauty",
  });
});

test('remote profile passes through while a stale local manifest is rejected',()=>{
 const env={BRAIN_RAG_MODE:'remote',BRAIN_RAG_URL:'https://rag.example.invalid/v1/rag/search',BRAIN_RAG_CONTRACT:'v4',BRAIN_RAG_DATASET_VERSION:'fixture',BRAIN_RAG_PROFILE:'test_items2',BRAIN_RAG_CATEGORIES:'beauty,fashion,food,living',BRAIN_RAG_CATEGORY:''};
 assert.equal(ragConfig(env)?.profile,'test_items2');assert.equal(ragConfig(env)?.category,'');
 assert.throws(()=>ragConfig({...env,BRAIN_RAG_MANIFEST_PATH:'C:/local/manifest.json'}),/manifest/i);
});
test('external catalog product HTTP never falls back to business catalog and pauses only local storage mutations',async()=>{
 let handler:Function|undefined,closed=false;const localQueries:string[]=[],externalQueries:string[]=[];
 const db={unsafe:async(query:string)=>{localQueries.push(query);if(query.includes('pg_roles'))return [{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:'on'}];return [];},end:async()=>{}};
 const source={...db,unsafe:async(query:string)=>{externalQueries.push(query);assert.match(query,/test_items2\./);return [];}};
 const {createCatalog}=await import('../../src/catalog.ts');
 await start(0,{env:{COMMERCE_CATALOG_SOURCE:'test_items2',DATABASE_URL:'postgres://local:fixture@127.0.0.1/business',CATALOG_DATABASE_URL:'postgres://remote:fixture@catalog.example/toss',HOST:'127.0.0.1'},
  ensureDevDb:async()=>'',connectDb:(()=>db) as never,
  openExternalCatalog:(async()=>({db:source,source:'test_items2',catalog:createCatalog('test_items2',source as never),close:async()=>{closed=true;}})) as never,
  build:(async()=>({})) as never,createServer:((listener:Function)=>{handler=listener;return {listen:(...args:unknown[])=>{(args.at(-1) as Function)();},on:()=>{}};}) as never});
 const invoke=async(method:string,url:string)=>{let status=0,body='';await handler!({method,url,headers:{cookie:'session='+encodeURIComponent(signSession('fixture-user','unit-test'))}},{writeHead:(s:number)=>{status=s;},end:(s:string)=>{body=s;},headersSent:false});return {status,body:JSON.parse(body)};};
 const result=await invoke('GET','/api/products');assert.equal(result.status,200);assert.ok(externalQueries.length>0);assert.equal(localQueries.some(q=>q.includes('test_items2.')),false);
 const context=await invoke('GET','/api/catalog/context');assert.equal(context.body.data.cart_enabled,undefined);
 assert.equal((await invoke('POST','/api/cart/items')).status,403);
 assert.equal(closed,false);
});

test("v4 config forwards the exact deployment version and requires one", () => {
  const version = "dataset-v4-exact-unit-fixture";
  assert.deepEqual(ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/v4/search",
    BRAIN_RAG_CONTRACT: "v4",
    BRAIN_RAG_DATASET_VERSION: version,
    BRAIN_RAG_CATEGORY: "beauty",
    BRAIN_RAG_TOKEN: "unit-token",
  }), {
    endpoint: "https://rag.example.invalid/v4/search",
    auditId: "",
    token: "unit-token",
    contract: "v4",
    datasetVersion: version,
    category: "beauty",
  });
  assert.throws(() => ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/v4/search",
    BRAIN_RAG_CONTRACT: "v4",
    BRAIN_RAG_DATASET_VERSION: " ",
  }), /BRAIN_RAG_DATASET_VERSION/);
  assert.throws(() => ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/search",
    BRAIN_RAG_CONTRACT: "v5",
  }), /BRAIN_RAG_CONTRACT/);
});

test("verified synthetic ranked candidates retain simulation provenance without exposing internal IDs", () => {
  const html = renderRanking({
    ranked: [{ candidate: {
      productId: "synthetic-product", productName: "합성 뷰티 상품", variantId: "variant-1",
      unitPriceWon: 12000, shippingFeeWon: 3000, sourceKind: "SYNTHETIC",
      datasetVersion: "dataset-v4-exact-unit-fixture", commerceVerified: true,
    }, score: 1, evidenceCoverage: 1 }],
    referenceOnly: [], rejected: [], evaluatedCount: 1,
  });
  assert.ok(html.includes("합성"));
  assert.ok(html.includes("테스트 카탈로그의 가격·재고로 실제 주문·결제는 할 수 없어요."));
  assert.ok(html.includes("합성 리뷰는 실제 구매 후기가 아니에요."));
  assert.ok(html.includes("상품 보기"));
  assert.ok(!html.includes("variant-1"));
  assert.ok(!html.includes("추천 적격성을 확인한 상품이 없어요"));
});

test("unverified v4 synthetic reference candidates have no product link", () => {
  const html = renderRanking({
    ranked: [],
    referenceOnly: [{ candidate: {
      productId: "synthetic-product", productName: "합성 뷰티 상품", variantId: "variant-1",
      sourceKind: "SYNTHETIC", datasetVersion: "dataset-v4-exact-unit-fixture",
      commerceVerified: false,
    }, reasons: ["실제 리뷰 표본 부족"] }],
    rejected: [], evaluatedCount: 1,
  });
  assert.ok(html.includes("합성"));
  assert.ok(html.includes("상품 확인 전"));
  assert.ok(!/<button[^>]*>상품 보기<\/button>/.test(html));
});

test("legacy reference-only candidates keep their existing text-only display", () => {
  const html = renderRanking({
    ranked: [],
    referenceOnly: [{ candidate: {
      productId: "legacy-product", productName: "기존 후보", variantId: "legacy-variant",
    }, reasons: ["검증 표본 부족"] }],
    rejected: [], evaluatedCount: 1,
  });
  assert.ok(html.includes("기존 후보"));
  assert.ok(html.includes("더 확인이 필요한 상품"));
  assert.ok(!html.includes("v4 합성 데이터"));
  assert.ok(!html.includes("Commerce 상품 확인 전"));
  assert.ok(!html.includes("상품 보기"));
});

test("Brain reference option shows and forwards the exact product and variant IDs", () => {
  const ranking: Parameters<typeof BrainRanking>[0]["ranking"] = {
    ranked: [],
    referenceOnly: [{
      candidate: { productId: "p-beauty", productName: "뷰티 상품", variantId: "v-option-b", sourceKind: "SYNTHETIC", commerceVerified: true },
      reasons: ["합성 리뷰 참고 전용"],
    }],
    rejected: [],
    evaluatedCount: 1,
  };
  let opened: [string, string?] | undefined;
  const tree = BrainRanking({
    ranking,
    onOpenProduct: (productId, variantId) => { opened = [productId, variantId]; },
  });
  const html = renderToStaticMarkup(createElement(BrainRanking, {
    ranking,
    onOpenProduct: () => {},
  }));
  const button = findButton(tree);
  assert.ok(button);
  button?.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
  assert.deepEqual(opened, ["p-beauty", "v-option-b"]);
  assert.ok(!html.includes("v-option-b"));
});

test("requested product variant selects only an available exact match; ordinary entry keeps the first available", () => {
  const resolveRequestedVariant = (detailResume as unknown as {
    resolveInitialVariant?: (
      variants: { variant_id: string; availability: string }[],
      requestedVariantId?: string,
    ) => { variantId: string | null; unavailable: boolean };
  }).resolveInitialVariant;
  assert.equal(typeof resolveRequestedVariant, "function");
  if (!resolveRequestedVariant) return;

  const variants = [
    { variant_id: "v-option-a", availability: "AVAILABLE" },
    { variant_id: "v-option-b", availability: "AVAILABLE" },
    { variant_id: "v-option-c", availability: "SOLD_OUT" },
  ];
  assert.deepEqual(resolveRequestedVariant(variants, "v-option-b"), { variantId: "v-option-b", unavailable: false });
  assert.deepEqual(resolveRequestedVariant(variants, "v-deleted"), { variantId: null, unavailable: true });
  assert.deepEqual(resolveRequestedVariant(variants, "v-option-c"), { variantId: null, unavailable: true });
  assert.deepEqual(resolveRequestedVariant(variants), { variantId: "v-option-a", unavailable: false });
});

test('ranked cards use matching product and variant reasons; references never acquire a rank',()=>{
 const candidate={productId:'safe-product',variantId:'safe-variant',productName:'검증 상품',unitPriceWon:12000,commerceVerified:true,keywords:['type: mask','sub_category: raw','향 없음']};
 const ranking={ranked:[{candidate,score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1};
 const html=renderToStaticMarkup(createElement(BrainRanking,{ranking,explanation:{kind:'VERIFIED_CANDIDATES',text:'',items:[{productId:'safe-product',variantId:'safe-variant',evidenceIds:['r'],reason:'확인된 **예산** 안의 <img src=x onerror=alert(1)> 상품이에요.'}],limitations:[]},onOpenProduct:()=>{}}));
 assert.match(html,/1순위|검증 상품/);assert.match(html,/<strong>예산<\/strong>/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img\b|type:|sub_category:/);
  const reference=renderRanking({...ranking,ranked:[],referenceOnly:[{candidate,reasons:['unverified']}]});assert.match(reference,/더 확인이 필요한 상품/);assert.doesNotMatch(reference,/1순위/);
 const wrong=renderToStaticMarkup(createElement(BrainRanking,{ranking,explanation:{kind:'LLM_GROUNDED',text:'',items:[{productId:'safe-product',variantId:'other-variant',evidenceIds:['r']}],limitations:[]},onOpenProduct:()=>{}}));assert.doesNotMatch(wrong,/1순위/);
});

test('model timeout retains verified retrieval cards without invented model reasons',()=>{const ranking={ranked:[{candidate:{productId:'safe',variantId:'v-safe',productName:'검증 후보',unitPriceWon:10000,commerceVerified:true},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1};const html=renderToStaticMarkup(createElement(BrainRanking,{ranking,explanation:{kind:'EVIDENCE_INSUFFICIENT',text:'',items:[],limitations:[],failure:{code:'MODEL_TIMEOUT'}},onOpenProduct:()=>{}}));assert.match(html,/검증 후보/);assert.match(html,/상품 보기/);});

test('retrieval failure does not retain stale ranked or reference cards',()=>{
 const ranking={ranked:[{candidate:{productId:'stale',variantId:'v-stale',productName:'오래된 상품',commerceVerified:true,unitPriceWon:10000},score:1,evidenceCoverage:1}],
  referenceOnly:[{candidate:{productId:'ref',variantId:'v-ref',productName:'오래된 참고 상품'},reasons:['old']}],rejected:[],evaluatedCount:2};
 const html=renderToStaticMarkup(createElement(BrainRanking,{ranking,explanation:{kind:'NO_MATCH',text:'상품 정보를 불러오는 연결에 문제가 생겼어요.',items:[],limitations:[],failure:{code:'RETRIEVAL_UNAVAILABLE'}},onOpenProduct:()=>{}}));
 assert.equal(html,'');
});

test('card actions keep exact product/variant targets with separate view and polite exclusion labels',()=>{
 const opened:string[][]=[],excluded:string[]=[];
 const props={ranking:{ranked:[{candidate:{productId:'card-p',variantId:'card-v',productName:'상품명',commerceVerified:true,unitPriceWon:12000},score:1,evidenceCoverage:1}],referenceOnly:[],rejected:[],evaluatedCount:1},
   onOpenProduct:(id:string,variant?:string)=>opened.push([id,variant!]),onExcludeProduct:(id:string)=>excluded.push(id)};
 const element=BrainRanking(props)!;
 const buttons:any[]=[];
 function walk(node:any){if(!node||typeof node!=='object')return;if(node.type==='button')buttons.push(node);for(const child of [node.props?.children].flat(Infinity))walk(child);}
 walk(element);
 const remove=buttons.find(b=>b.props.children==='이 상품은 빼주세요');assert.ok(remove);remove.props.onClick();
 const view=buttons.find(b=>b.props['aria-label']==='상품 보기');assert.ok(view);view.props.onClick();
 assert.deepEqual(excluded,['card-p']);assert.deepEqual(opened,[['card-p','card-v']]);
 const html=renderToStaticMarkup(element);assert.match(html,/brain-product-heading/);assert.match(html,/brain-product-footer/);
 assert.doesNotMatch(html,/>이 상품 제외</);
});
