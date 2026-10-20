import type {ProductDetail,ReviewItem,ReviewsResult} from "../contracts.ts";
import {normalizeReviewSortAspect,reviewSortAspectLabel} from "./review-sort.ts";

export interface ReviewAnalysisRequest {
 displayIndexes?:number[];allDisplayed?:boolean;useCurrent?:boolean;aspect?:string;focus:"ALL"|"CONS";compare:boolean;
}
export interface DisplayedReviewProduct {productId:string;variantId?:string;name?:string;displayIndex:number}
export type ReviewOpinion="POSITIVE"|"NEGATIVE"|"MIXED"|"UNRELATED"|"UNCERTAIN";
export interface ReviewAnalysisCounts {positive:number;negative:number;mixed:number;unrelated:number;uncertain:number}
export interface AnalyzedReviewEvidence {
 id:string;sourceId:string;productId:string;variantId:string|null;sourceKind:"REAL"|"SYNTHETIC";sourceRef:string;text:string;opinion:ReviewOpinion;
}
export interface AnalyzedReviewProduct {
 productId:string;variantId?:string;name:string;displayIndex:number;status:"COMPLETE"|"PARTIAL"|"UNAVAILABLE";
 /** Valid rows in product/selected-variant scope before deduplication; provisional when PARTIAL. */
 totalMatching:number;
 /** Raw Catalog rows fetched across pages, before validation and option filtering. */
 fetchedCount:number;
 /** In-scope logical reviews after ID and verified original-source deduplication. */
 uniqueCount:number;
 /** Rows merged by duplicate ID or by an identical known REAL source reference. */
 duplicateCount:number;
 /** Malformed rows and reviews belonging to a different selected option. */
 excludedCount:number;
 counts:ReviewAnalysisCounts;
 countsBySource:{REAL:ReviewAnalysisCounts;SYNTHETIC:ReviewAnalysisCounts};
 evidence:AnalyzedReviewEvidence[];limitations:string[];
}
export interface ReviewAnalysisData {
 status:"READY"|"PARTIAL"|"UNAVAILABLE"|"NEEDS_TARGET";aspect:string;aspectLabel:string;focus:"ALL"|"CONS";compare:boolean;
 datasetVersion?:string;method:"CONSERVATIVE_RULES";products:AnalyzedReviewProduct[];
}
export type ReviewComparisonEligibility="COMPARABLE"|"INCOMPLETE"|"NO_REAL_REVIEWS"|"UNCERTAIN";
function validComparisonCounts(value:unknown):value is ReviewAnalysisCounts{
 if(!value||typeof value!=="object")return false;
 const counts=value as ReviewAnalysisCounts;
 return [counts.positive,counts.negative,counts.mixed,counts.unrelated,counts.uncertain]
  .every(count=>Number.isSafeInteger(count)&&count>=0);
}
/** Checks observed aggregates and coverage only; COMPARABLE does not prove semantic absence of a polarity. */
export function getReviewComparisonEligibility(data:ReviewAnalysisData):ReviewComparisonEligibility{
 if(data.focus!=="ALL"||!data.compare||data.status!=="READY"||data.products.length<2||
  data.products.some(product=>product.status!=="COMPLETE"))return "INCOMPLETE";
 const realCounts=data.products.map(product=>product.countsBySource?.REAL);
 if(realCounts.some(counts=>!validComparisonCounts(counts)))return "INCOMPLETE";
 const completeCounts=realCounts as ReviewAnalysisCounts[];
 if(completeCounts.some(counts=>counts.positive+counts.negative+counts.mixed+counts.unrelated+counts.uncertain===0))
  return "NO_REAL_REVIEWS";
 if(completeCounts.some(counts=>counts.positive===0&&counts.uncertain>0))return "UNCERTAIN";
 return "COMPARABLE";
}

type ReviewAnalysisCatalog=Pick<ReturnType<typeof import("../catalog.ts")["createCatalog"]>,"getProduct"|"getReviews">;
type SourceKind="REAL"|"SYNTHETIC";
type CatalogReview=ReviewItem;
type ReviewPage=ReviewsResult;
type SourceEntry={row:CatalogReview;conflict:boolean};
const PAGE_SIZE=50,MAX_PAGES=20,MAX_REVIEW_MS=12_000,MAX_EVIDENCE=6,MAX_REVIEW_TEXT=1_200;
const opinionKeys:ReviewOpinion[]=["POSITIVE","NEGATIVE","MIXED","UNRELATED","UNCERTAIN"];
const aspectTerms:Record<string,string[]>={
 moisturizing:["촉촉","보습","수분","건조","푸석","당김"],
 comfort:["사용감","발림","끈적","답답","무겁","흡수","밀림","산뜻","부드럽"],
 fit:["착용감","착용","잘 맞","밀착"],battery_life:["배터리","사용시간","사용 시간","방전"],
 noise:["소음","조용","정숙","시끄럽"],durability:["내구성","튼튼","고장","망가"],
 cleaning_power:["세정력","세척력","세정","세척"],value:["가성비","가격 대비","가격","비싸","저렴"],
 scent:["향","냄새"],connectivity:["연결성","연결","블루투스"],taste:["맛","고소","달콤"],
 portability:["휴대성","휴대","가벼움","가벼운"],performance:["성능","속도","빠르"],quality:["품질","마감"],
};
const genericPositive=/(?:좋|만족|뛰어나|충분|괜찮|추천|최고|훌륭|우수|편리|안정적|부드럽|산뜻|가볍|빠르|잘\s*(?:돼|되|맞))/u;
const genericNegative=/(?:건조|푸석|당김|부족|아쉽|불만|별로|나쁘|싫|후회|없|않|아니|못|불편|불량|끈적|답답|무겁|밀림|시끄럽|끊기|고장|방전|비싸)/u;
const moistureNegative=/(?:촉촉(?:하?지\s*(?:않|못)|하진\s*(?:않|못))|촉촉한\s*(?:게|것이)\s*아니|보습(?:력)?(?:이|은|도)?\s*(?:부족|약하|별로|나쁘|없|떨어|안\s*(?:돼|되))|수분(?:감)?(?:이|은|도)?\s*(?:부족|없|약하|낮|별로|안\s*(?:돼|되))|건조|푸석|당김|당겨)/u;
const moisturePositive=/(?:촉촉(?:해서|하고|하니|하긴|하지만|해요|해|했(?:어요|습니다)?|합니다)|촉촉한\s*(?:(?:게|것이|피부가)\s*)?(?:좋|만족|충분|마음에\s*들)|촉촉함(?:이|은|도)?\s*(?:좋|만족|충분)|보습(?:력)?(?:이|은|도)?\s*(?:좋|뛰어나|만족|충분)|수분(?:감)?(?:이|은|도)?\s*(?:.{0,8}(?:오래가|지속|유지|좋|충분|만족|있))|건조하지\s*않|당기지\s*않)/u;
const moistureNegatedBenefit=/(?:보습(?:력)?|수분(?:감)?)(?:이|은|도)?\s*(?:좋지|충분하지|충분치)\s*(?:않|못)/u;
const moistureImprovement=/(?:건조(?:함)?(?:이|가|을)?\s*(?:크게\s*)?(?:줄|개선|잡)|건조를\s*잡|당김\s*없이|당김(?:이|은)?\s*없|당기지\s*않|푸석(?:함)?(?:이|가)?\s*(?:줄|개선))/u;
const moistureImprovementFailure=/(?:건조|푸석|당김).{0,16}(?:줄지\s*않|개선되지|잡지\s*못|잡아\s*주지\s*못|줄여\s*주지\s*못|개선하지\s*못)/u;
const drySkinUseIntent=/건조한\s*피부.{0,20}(?:쓰려고|사용하려고|바르려고|사용할\s*목적|쓰기\s*위해)/u;
const drySkinDescription=/건조한\s*피부(?:에|가|는|라서|라|인데)?/gu;
const dryingOutcome=/(?:금방|쉽게|빠르게)?\s*(?:마르|말라|건조해|푸석해|당겨요?|당깁니다)/u;
const comfortPositive=/(?:끈적이지|끈적임이\s*없|산뜻|부드럽|가볍|잘\s*발리|흡수가\s*잘)/u;
const comfortNegative=/(?:끈적|답답|무겁|밀리|흡수.{0,5}(?:안|않|못)|발림.{0,5}(?:별로|나쁘|불편))/u;
const explicitUncertain=/(?:모르겠|잘\s*모르|알\s*수\s*없|있는지\s*없는지|확실하지\s*않|잘\s*모르는)/u;
const weakLitotes=/(?:나쁘지\s*않|별로\s*나쁘지|없는\s*건\s*아니|촉촉하지\s*않은\s*건\s*아니)/u;
const reportedSpeech=/(?:친구|다들|사람들|후기|리뷰|남들|주변(?:사람|분)?)/u;
const reportSeparators=/(하지만|그렇지만|다만|그런데|라던데|하던데|다던데|라고\s*해서|다고\s*해서|샀는데|구매했는데|저는|제가|제\s*피부(?:는|가))/u;
const moistureImprovementsGlobal=/(?:건조(?:함)?(?:이|가|을)?\s*(?:크게\s*)?(?:줄|개선|잡)|건조를\s*잡|당김\s*없이|당김(?:이|은)?\s*없|당기지\s*않|푸석(?:함)?(?:이|가)?\s*(?:줄|개선))/gu;
const negatedDryGlobal=/건조하지\s*(?:않|못)/gu;
const knownOliveyoungReviewRef=/^oliveyoung:[^:\s]{1,120}:review:\d{1,24}$/i;
const validId=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=160&&value===value.trim()&&!/[\u0000-\u001f]/.test(value);
const emptyCounts=():ReviewAnalysisCounts=>({positive:0,negative:0,mixed:0,unrelated:0,uncertain:0});
const safeText=(value:unknown,max:number):value is string=>typeof value==="string"&&value.length>0&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const validIndex=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=3;
const sameReview=(a:CatalogReview,b:CatalogReview)=>a.id===b.id&&a.product_id===b.product_id&&a.variant_id===b.variant_id&&
 a.rating===b.rating&&a.body===b.body&&a.source_kind===b.source_kind&&a.source_ref===b.source_ref&&a.written_at===b.written_at;
function sameSourceRecord(a:CatalogReview,b:CatalogReview):boolean{
 return a.product_id===b.product_id&&a.variant_id===b.variant_id&&a.rating===b.rating&&a.body===b.body&&a.source_kind===b.source_kind;
}
function versionOf(value:unknown):string|undefined{
 if(!value||typeof value!=="object")return undefined;
 const row=value as Record<string,unknown>,context=row.catalog_context&&typeof row.catalog_context==="object"?row.catalog_context as Record<string,unknown>:undefined;
 const version=row.datasetVersion??row.dataset_version??context?.datasetVersion??context?.dataset_version;
 return typeof version==="string"&&version.trim()?version:undefined;
}
function catalogIdentity(value:unknown):string|undefined{
 if(!value||typeof value!=="object")return undefined;
 const context=(value as Record<string,unknown>).catalog_context;
 if(context===undefined)return undefined;
 if(!context||typeof context!=="object")return "!invalid";
 const row=context as Record<string,unknown>;
 if(!["test_items","test_items2"].includes(String(row.source))||row.read_only!==true||row.is_simulated!==true)return "!invalid";
 return `${row.source}|${row.read_only}|${row.is_simulated}`;
}
function validReview(row:CatalogReview,productId:string):boolean{
 return validId(row.id)&&row.product_id===productId&&(row.variant_id===null||validId(row.variant_id))&&
  Number.isFinite(row.rating)&&row.rating>=1&&row.rating<=5&&safeText(row.body,20_000)&&row.body.trim().length>0&&
  (row.source_kind==="REAL"||row.source_kind==="SYNTHETIC")&&safeText(row.source_ref,512)&&safeText(row.written_at,80)&&Number.isFinite(Date.parse(row.written_at));
}
function addOpinion(counts:ReviewAnalysisCounts,opinion:ReviewOpinion){counts[opinion.toLowerCase() as keyof ReviewAnalysisCounts]++;}
function baseAnalysis(request:ReviewAnalysisRequest,version?:string,status:ReviewAnalysisData["status"]="NEEDS_TARGET"):ReviewAnalysisData{
 const raw=typeof request?.aspect==="string"?request.aspect.trim():"moisturizing";
 const normalized=normalizeReviewSortAspect(raw)||raw;
 return {status,aspect:normalized,aspectLabel:reviewSortAspectLabel(normalized),focus:request?.focus==="CONS"?"CONS":"ALL",
  compare:request?.compare===true,method:"CONSERVATIVE_RULES",products:[],...(version?{datasetVersion:version}:{})};
}
type Timed<T>={timedOut:true}|{timedOut:false;value:T};
async function withinDeadline<T>(promise:Promise<T>,deadline:number):Promise<Timed<T>>{
 const remaining=deadline-Date.now();if(remaining<=0)return {timedOut:true};
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise.then(value=>({timedOut:false as const,value})),new Promise<Timed<T>>(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),remaining);})]);}
 finally{if(timer)clearTimeout(timer);}
}

/** Conservative, deterministic aspect classification; it never treats a matching word alone as sentiment. */
export function classifyReviewOpinion(text:string,aspect:string):ReviewOpinion{
 if(typeof text!=="string"||text.length>20_000)return "UNCERTAIN";
 const canonical=normalizeReviewSortAspect(aspect),terms=aspectTerms[canonical??""]??[aspect.trim()].filter(Boolean);
 const normalized=text.normalize("NFKC").replace(/\s+/g," ").trim().toLocaleLowerCase();
 if(!normalized)return "UNCERTAIN";
 if(!terms.some(term=>normalized.includes(term.normalize("NFKC").toLocaleLowerCase())))return "UNRELATED";
 if(canonical==="moisturizing"){
  const pieces=normalized.split(reportSeparators);
  const directText=pieces.map((part,index)=>index%2===1||!reportedSpeech.test(part)?part:"").join("");
  if(!directText.trim()||explicitUncertain.test(directText)||weakLitotes.test(directText))return "UNCERTAIN";
  const targetText=directText.replace(drySkinDescription," ");
  const improvement=moistureImprovement.test(targetText)&&!moistureImprovementFailure.test(targetText);
  const positive=(moisturePositive.test(targetText)&&!moistureNegatedBenefit.test(targetText))||improvement;
  const negativeText=(improvement?targetText.replace(moistureImprovementsGlobal," "):targetText).replace(negatedDryGlobal," ");
  const negative=moistureNegative.test(negativeText)||moistureNegatedBenefit.test(targetText)||moistureImprovementFailure.test(targetText)||dryingOutcome.test(targetText);
  if(drySkinUseIntent.test(directText)&&!positive&&!negative)return "UNCERTAIN";
  if(positive&&negative)return "MIXED";
  if(negative)return "NEGATIVE";
  if(positive)return "POSITIVE";
  return "UNCERTAIN";
 }
 if(canonical==="comfort"){
  const positive=comfortPositive.test(normalized),negative=comfortNegative.test(normalized);
  if(positive&&negative)return "MIXED";
  if(negative)return "NEGATIVE";
  if(positive)return "POSITIVE";
 }
 const positive=genericPositive.test(normalized),negative=genericNegative.test(normalized);
 if(positive&&negative)return "MIXED";
 if(positive)return "POSITIVE";
 if(negative)return "NEGATIVE";
 return "UNCERTAIN";
}

/** Reads a bounded full Commerce review corpus for the displayed product IDs only. */
export function createReviewAnalysisLookup(catalog:ReviewAnalysisCatalog,datasetVersion?:string){
 const runtimeVersion=typeof datasetVersion==="string"&&datasetVersion.length<=128?datasetVersion:undefined;
 return async({request,products}:{request:ReviewAnalysisRequest;products:DisplayedReviewProduct[]}):Promise<ReviewAnalysisData>=>{
  const data=baseAnalysis(request,runtimeVersion);
  if(!Array.isArray(products)||products.length===0||products.length>3)return data;
  const seenIndexes=new Set<number>(),seenTargets=new Set<string>();
  for(const item of products){
   if(!item||!validId(item.productId)||!validIndex(item.displayIndex)||item.variantId!==undefined&&!validId(item.variantId)||
    item.name!==undefined&&!safeText(item.name,200))return data;
   const targetKey=`${item.productId}\u0000${item.variantId??""}`;
   if(seenIndexes.has(item.displayIndex)||seenTargets.has(targetKey))return data;
   seenIndexes.add(item.displayIndex);seenTargets.add(targetKey);
  }
  if(request.displayIndexes?.length&&products.some(item=>!request.displayIndexes!.includes(item.displayIndex)))return data;

  const deadline=Date.now()+MAX_REVIEW_MS;
  let sharedCatalogIdentity:string|undefined,sharedObservedVersion:string|undefined,deadlineReached=false;
  const compatibleMetadata=(value:unknown):boolean=>{
   const identity=catalogIdentity(value),observed=versionOf(value);
   if(identity==="!invalid")return false;
   if(identity){if(sharedCatalogIdentity&&sharedCatalogIdentity!==identity)return false;sharedCatalogIdentity=identity;}
   if(observed){if(runtimeVersion&&runtimeVersion!==observed||sharedObservedVersion&&sharedObservedVersion!==observed)return false;sharedObservedVersion=observed;}
   return true;
  };
  const results:AnalyzedReviewProduct[]=[];
  for(const item of products){
   if(deadlineReached||Date.now()>=deadline){
    deadlineReached=true;
    results.push(unavailableProduct(item,["리뷰 조회 시간 상한에 도달해 이 상품은 조회하지 못했습니다."]));
    continue;
   }
   const result=await analyzeProduct(catalog,item,data.aspect,data.focus,runtimeVersion,deadline,compatibleMetadata);
   results.push(result.product);
   if(result.deadlineReached)deadlineReached=true;
  }
  data.products=results;
  const complete=results.filter(item=>item.status==="COMPLETE").length;
  const incomplete=results.filter(item=>item.status==="PARTIAL").length;
  data.status=complete===results.length?"READY":complete+incomplete===0?"UNAVAILABLE":"PARTIAL";
  return data;
 };
}

function unavailableProduct(item:DisplayedReviewProduct,limitations:string[]):AnalyzedReviewProduct{
 return {productId:item.productId,...(item.variantId?{variantId:item.variantId}:{}),name:item.name??item.productId,displayIndex:item.displayIndex,status:"UNAVAILABLE",
  totalMatching:0,fetchedCount:0,uniqueCount:0,duplicateCount:0,excludedCount:0,counts:emptyCounts(),
  countsBySource:{REAL:emptyCounts(),SYNTHETIC:emptyCounts()},evidence:[],limitations};
}

async function analyzeProduct(catalog:ReviewAnalysisCatalog,item:DisplayedReviewProduct,aspect:string,focus:"ALL"|"CONS",
 runtimeVersion:string|undefined,deadline:number,compatibleMetadata:(value:unknown)=>boolean):Promise<{product:AnalyzedReviewProduct;deadlineReached:boolean}>{
 const unavailable=(reason:string,deadlineReached=false)=>({product:unavailableProduct(item,[reason]),deadlineReached});
 let productResult;
 try{
  const timed=await withinDeadline(catalog.getProduct({product_id:item.productId}),deadline);
  if(timed.timedOut)return unavailable("상품 검증 시간 상한에 도달했습니다.",true);
  productResult=timed.value;
 }catch{return unavailable("Commerce 상품 검증에 실패했습니다.");}
 if(!productResult.ok)return unavailable("표시된 상품 ID를 Commerce에서 검증하지 못했습니다.");
 const detail:ProductDetail=productResult.data;
 if(!compatibleMetadata(detail)||detail.product.id!==item.productId||!safeText(detail.product.name,200)||
  item.name!==undefined&&detail.product.name.normalize("NFKC").trim()!==item.name.normalize("NFKC").trim())
  return unavailable("상품 ID, 이름 또는 Catalog 출처 검증에 실패했습니다.");
 if(item.variantId&&!detail.variants.some(variant=>variant.variant_id===item.variantId))
  return unavailable("선택 옵션이 해당 상품의 Commerce 옵션 목록에서 확인되지 않았습니다.");

 const rawRows:CatalogReview[]=[],limitations:string[]=[];
 let cursor:string|undefined,expectedTotal:number|undefined,complete=false,fetchedCount=0,excludedCount=0,totalMatching=0,deadlineReached=false;
 const cursors=new Set<string>();
 for(let pageNumber=0;pageNumber<MAX_PAGES;pageNumber++){
  if(Date.now()>=deadline){limitations.push("리뷰 조회 시간 상한에 도달해 전체 집계를 확정하지 않았습니다.");deadlineReached=true;break;}
  let timed:Timed<Awaited<ReturnType<ReviewAnalysisCatalog["getReviews"]>>>;
  try{timed=await withinDeadline(catalog.getReviews({product_id:item.productId,sort:"LATEST",limit:PAGE_SIZE,...(cursor?{cursor}:{})}),deadline);}
  catch{limitations.push("Commerce 리뷰 페이지 조회가 실패해 전체 집계를 확정하지 않았습니다.");break;}
  if(timed.timedOut){limitations.push("리뷰 조회 시간 상한에 도달해 전체 집계를 확정하지 않았습니다.");deadlineReached=true;break;}
  const pageResult=timed.value;
  if(!pageResult.ok){limitations.push("Commerce 리뷰 페이지 조회가 실패해 전체 집계를 확정하지 않았습니다.");break;}
  const rawPage=pageResult.data as ReviewPage|undefined;
  if(!rawPage||typeof rawPage!=="object"){
   limitations.push("Commerce 리뷰 페이지 응답 형식이 잘못되어 전체 집계를 확정하지 않았습니다.");break;
  }
  const page:ReviewPage=rawPage;
  if(Array.isArray(page.reviews))fetchedCount+=page.reviews.length;
  if(!compatibleMetadata(page)||!Array.isArray(page.reviews)||!Number.isSafeInteger(page.total_matching)||page.total_matching<0||
   !Number.isSafeInteger(page.returned_count)||page.returned_count!==page.reviews.length||page.reviews.length>PAGE_SIZE||typeof page.has_more!=="boolean"){
   limitations.push("페이지 메타데이터 또는 Catalog 출처가 일치하지 않아 전체 집계를 확정하지 않았습니다.");break;
  }
  if(expectedTotal===undefined)expectedTotal=page.total_matching;
  else if(expectedTotal!==page.total_matching){limitations.push("페이지 간 전체 리뷰 수가 달라 전체 집계를 확정하지 않았습니다.");break;}
  for(const row of page.reviews){
   if(!validReview(row,item.productId)){excludedCount++;continue;}
   if(item.variantId&&row.variant_id!==null&&row.variant_id!==item.variantId){excludedCount++;continue;}
   totalMatching++;rawRows.push(row);
  }
  if(!page.has_more){
   if(page.next_cursor!==null||expectedTotal!==fetchedCount){limitations.push("최종 cursor 또는 전체 조회 건수가 일치하지 않아 전체 집계를 확정하지 않았습니다.");break;}
   complete=true;break;
  }
  if(typeof page.next_cursor!=="string"||!page.next_cursor||cursors.has(page.next_cursor)){
   limitations.push("리뷰 페이지 cursor가 없거나 반복되어 전체 집계를 확정하지 않았습니다.");break;
  }
  cursors.add(page.next_cursor);cursor=page.next_cursor;
  if(pageNumber===MAX_PAGES-1)limitations.push("리뷰 페이지 안전 상한에 도달해 전체 집계를 확정하지 않았습니다.");
 }
 if(!complete&&!limitations.length)limitations.push("리뷰 조회가 끝나지 않아 전체 집계를 확정하지 않았습니다.");
 if(!runtimeVersion)limitations.push("Catalog 조회 설정에서 datasetVersion을 받지 못했습니다.");
 else limitations.push("Catalog 응답은 데이터셋 버전을 노출하지 않아 datasetVersion은 실행 설정값이며 Commerce 원본과 독립 대조되지 않았습니다.");

 const idMap=new Map<string,SourceEntry>();let duplicateCount=0;
 for(const row of rawRows){
  const prior=idMap.get(row.id);
  if(!prior){idMap.set(row.id,{row,conflict:false});continue;}
  duplicateCount++;
  if(!sameReview(prior.row,row))prior.conflict=true;
 }
 const sourceGroups=new Map<string,SourceEntry[]>();
 for(const itemById of idMap.values()){
  const row=itemById.row;
  if(row.source_kind!=="REAL"||!knownOliveyoungReviewRef.test(row.source_ref))continue;
  const group=sourceGroups.get(row.source_ref)??[];group.push(itemById);sourceGroups.set(row.source_ref,group);
 }
 const sourceDuplicates=new Set<string>();
 for(const [sourceRef,group] of sourceGroups){
  if(group.length<2)continue;
  if(group.every(entry=>sameSourceRecord(group[0]!.row,entry.row))){
   for(const entry of group.slice(1))sourceDuplicates.add(entry.row.id);
   duplicateCount+=group.length-1;
  }else for(const entry of group)entry.conflict=true;
 }
 const logicalRows=[...idMap.values()].filter(entry=>!sourceDuplicates.has(entry.row.id));
 const counts=emptyCounts(),countsBySource:{REAL:ReviewAnalysisCounts;SYNTHETIC:ReviewAnalysisCounts}={REAL:emptyCounts(),SYNTHETIC:emptyCounts()};
 const evidence:AnalyzedReviewEvidence[]=[];
 for(const entry of logicalRows){
  const row=entry.row,opinion=entry.conflict?"UNCERTAIN":classifyReviewOpinion(row.body,aspect);
  addOpinion(counts,opinion);addOpinion(countsBySource[row.source_kind],opinion);
  const visibleForFocus=focus==="ALL"||opinion==="NEGATIVE"||opinion==="MIXED"||opinion==="UNCERTAIN";
  if(opinion!=="UNRELATED"&&visibleForFocus&&evidence.length<MAX_EVIDENCE)evidence.push({id:row.id,sourceId:row.id,productId:row.product_id,
   variantId:row.variant_id,sourceKind:row.source_kind,sourceRef:row.source_ref,text:row.body.slice(0,MAX_REVIEW_TEXT),opinion});
 }
 const product:AnalyzedReviewProduct={productId:item.productId,...(item.variantId?{variantId:item.variantId}:{}),name:detail.product.name,
  displayIndex:item.displayIndex,status:complete?"COMPLETE":fetchedCount?"PARTIAL":"UNAVAILABLE",totalMatching,fetchedCount,
  uniqueCount:logicalRows.length,duplicateCount,excludedCount,counts,countsBySource,evidence,limitations};
 return {product,deadlineReached};
}
