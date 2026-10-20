import type {ProductDetail,ReviewItem,ToolResult} from "../contracts.ts";
import type {Aspect,EvidenceRecord,GroundedFacet,ProductCandidate,RetrieverPort} from "./contracts.ts";

/**
 * Read-only RAG integration boundary. RAG supplies candidate/evidence references,
 * but price, shipping and current sellability MUST come from Commerce.
 * "wholeReviewCountVerified" is computed from a pre-approved ETL audit ID, never
 * trusted as a raw boolean returned by a model, client, or remote search service.
 */
export interface RagConnection {
  profile?:string;
  endpoint:string;
  mode?:"remote"|"local";
  dataDir?:string;
  pythonPath?:string;
  modelRevision?:string;
  modelCache?:string;
  manifestPath?:string;
  auditId?:string;
  token?:string;
  timeoutMs?:number;
  contract?:"brain-rag-v1"|"v4";
  /** Server-only catalog scope. Omitted means public and cannot enable simulated ranking. */
  catalogSource?:"public"|"test_items"|"test_items2";
  datasetVersion?:string;
  category?:string;
  categories?:string[];
}

export type LocalRagSearch=(body:Record<string,unknown>)=>Promise<unknown>;
/** In-process transport only. Output still passes the same bounded v4/Commerce checks. */
export function localRagFetcher(search:LocalRagSearch):typeof fetch{
  return async (_target,init)=>{
    if(init?.method!=="POST"||typeof init.body!=="string"||init.body.length>16000)
      throw new Error("invalid local RAG request");
    const signal=init.signal;
    signal?.throwIfAborted();
    const body:unknown=JSON.parse(init.body);
    if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("invalid local RAG body");
    let abort:(()=>void)|undefined;
    try{
      const operation=Promise.resolve().then(()=>search(body as Record<string,unknown>));
      const result=await Promise.race([operation,new Promise<never>((_resolve,reject)=>{
        abort=()=>reject(new Error("local RAG request aborted"));
        signal?.addEventListener("abort",abort,{once:true});
        if(signal?.aborted)abort();
      })]);
      return new Response(JSON.stringify(result),{status:200,headers:{"content-type":"application/json"}});
    }finally{if(abort)signal?.removeEventListener("abort",abort);}
  };
}
type ProductLookup=(input:{product_id:string})=>Promise<ToolResult<ProductDetail>>;
export type ReviewLookup=(input:{product_id:string;review_ids:string[]})=>Promise<ReviewItem[]>;

interface ParsedV4Evidence {
  sourceId:string;
  evidenceText:string;
  variantId:string|null;
  sourceKind:"REAL"|"SYNTHETIC";
  synthetic:boolean;
}
interface ParsedV4Item {productId:string;rrfScore:number;evidence:ParsedV4Evidence[];productEvidence?:true;commerceVariantId?:string}
interface ParsedV4Response {datasetVersion:string;items:ParsedV4Item[]}

function obj(v:unknown):Record<string,unknown>|null {
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
}
function text(v:unknown,max=160):v is string {
  return typeof v==="string"&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
}
function score(v:unknown):v is number{return typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1;}
function whole(v:unknown):v is number {return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;}
const maxResponseBytes=400_000;
const pickRecord=(v:unknown):GroundedFacet|undefined=>{
  const x=obj(v);
  if(!x||!score(x.score)||!Array.isArray(x.evidenceIds)||x.evidenceIds.length===0||
    x.evidenceIds.length>25||!x.evidenceIds.every(id=>text(id,128)))return;
  return {score:x.score,evidenceIds:x.evidenceIds as string[]};
};

/** Parse only the versioned RAG payload; all product and review facts are checked separately. */
export function parseV4Response(raw:unknown,expectedVersion:string,maxItems:5|10=5):ParsedV4Response {
  const r=obj(raw);
  if(!text(expectedVersion,128)||!r||r.dataset_version!==expectedVersion||
     !Array.isArray(r.items)||r.items.length>maxItems)
    throw new Error("RAG v4 dataset version or response shape mismatch");
  const seenProducts=new Set<string>();
 const seenSources=new Map<string,{productId:string;variantId:string|null;sourceKind:string;synthetic:boolean}>();
  let evidenceCount=0;
  const items:ParsedV4Item[]=r.items.map(value=>{
    const item=obj(value);
    if(!item||!text(item.product_id,128)||typeof item.rrf_score!=="number"||
       !Number.isFinite(item.rrf_score)||item.rrf_score<0||!Array.isArray(item.evidence)||
       seenProducts.has(item.product_id))
      throw new Error("invalid or duplicate RAG v4 product item");
    seenProducts.add(item.product_id);
    evidenceCount+=item.evidence.length;
    if(evidenceCount>300)throw new Error("RAG v4 evidence limit");
    let productEvidence=false;
    const commerce=obj(item.commerce);
    if(commerce?.variant_id!==undefined&&!text(commerce.variant_id,128))throw Error('invalid RAG Commerce variant');
    const evidence:ParsedV4Evidence[]=item.evidence.flatMap(rawEvidence=>{
      const entry=obj(rawEvidence),metadata=obj(entry?.source_metadata);
      if(!entry||(entry.product_id!==undefined&&entry.product_id!==item.product_id)||
         (entry.source_version!==undefined&&entry.source_version!==null&&entry.source_version!==expectedVersion))
        throw new Error("RAG v4 evidence scope or version mismatch");
      // The live index also returns product-description chunks. They are not
      // verified review evidence and must not be passed to the review lookup.
      if(entry.source_type==="product"){productEvidence=true;return [];}
      if(entry.source_type!==undefined&&entry.source_type!=="review")
        throw new Error("invalid RAG v4 evidence source type");
      const sourceKind=metadata?.source_kind;
      const synthetic=metadata?.synthetic;
      const excerpt=entry?.evidence_text;
      if(!entry||!text(entry.source_id,128)||
         typeof excerpt!=="string"||excerpt.length===0||excerpt.length>5000||excerpt.includes("\u0000")||
         !metadata||!(metadata.variant_id===null||text(metadata.variant_id,128))||
         !(sourceKind==="SYNTHETIC"&&synthetic===true||sourceKind==="REAL"&&synthetic===false))
        throw new Error("invalid, duplicate, or inconsistent RAG review evidence");
      const prior=seenSources.get(entry.source_id);
      if(prior){
        if(prior.productId!==item.product_id||prior.variantId!==metadata.variant_id||
           prior.sourceKind!==sourceKind||prior.synthetic!==synthetic)
          throw new Error("cross-product or variant RAG review ID collision");
        // Identical Commerce review IDs may occur as multiple semantic chunks.
        // First excerpt is still verified against the Commerce original before use.
        return [];
      }
      seenSources.set(entry.source_id,{productId:item.product_id as string,variantId:metadata.variant_id,
        sourceKind,synthetic});
      return [{sourceId:entry.source_id,evidenceText:excerpt,variantId:metadata.variant_id,
        sourceKind,synthetic}];
    });
    return {productId:item.product_id,rrfScore:item.rrf_score,evidence,...(productEvidence?{productEvidence:true as const}:{}),...(commerce?.variant_id?{commerceVariantId:commerce.variant_id as string}:{})};
  });
  return {datasetVersion:expectedVersion,items};
}

function validV4ReviewRows(
  rows:unknown,
  productId:string,
  requested:readonly ParsedV4Evidence[],
):Map<string,ReviewItem> {
  if(!Array.isArray(rows))throw new Error("invalid Commerce review lookup response");
  const expected=new Map(requested.map(e=>[e.sourceId,e]));
  const found=new Map<string,ReviewItem>();
  for(const raw of rows){
    const row=obj(raw);
    if(!row||!text(row.id,128)||!text(row.product_id,128)||
       (row.variant_id!==null&&!text(row.variant_id,128))||
       typeof row.body!=="string"||
       (row.source_kind!=="REAL"&&row.source_kind!=="SYNTHETIC")||
       typeof row.rating!=="number"||!Number.isFinite(row.rating)||row.rating<1||row.rating>5||
       typeof row.source_ref!=="string"||typeof row.written_at!=="string")
      throw new Error("invalid Commerce review source");
    const expectedEvidence=expected.get(row.id);
    if(!expectedEvidence||found.has(row.id)||row.product_id!==productId||
       row.variant_id!==expectedEvidence.variantId||row.source_kind!==expectedEvidence.sourceKind||
       expectedEvidence.synthetic!==(row.source_kind==="SYNTHETIC")||
       !row.body.includes(expectedEvidence.evidenceText))
      throw new Error("RAG review source or excerpt mismatch");
    found.set(row.id,row as unknown as ReviewItem);
  }
  return found;
}

const notVerifiedMarker=/(?:미확인|미검증|미확정|unknown|unverified|unconfirmed|mock|historical)/i;
const specMetadataKey=/(?:price|stock|variant|verified|evidence|source|data_version|dataset)/i;
const negativeSpecValue=/(?:아니요|아니오|없음|불가|미지원|미포함|미적용|지원하지\s*않|불가능|not\s+(?:available|supported|included|verified)|false|no|off)/i;
function usableCommerceSpec(key:string,value:string):boolean{
  return text(key,160)&&text(value,500)&&!notVerifiedMarker.test(key+" "+value)&&
    !specMetadataKey.test(key)&&!negativeSpecValue.test(value)&&!/^\s*0\s*$/.test(value)&&
    !/^\s*[.…·_-]+\s*$/.test(value);
}
function normalizeFact(value:string):string{
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g,"");
}
function matchesCommerceCondition(key:string,value:string,condition:string):boolean{
  const target=normalizeFact(condition);
  if(!target)return false;
  if(/(?:카테고리|category)/i.test(key)&&/(?:효능|효과|성능|개선|진정|치료)/.test(condition))return false;
  return (normalizeFact(key)===target&&/^(?:true|yes|on|지원|가능|있음|해당)$/i.test(value.trim()))||normalizeFact(value)===target||
    value.split(/[,/;|，、]+/).some(part=>normalizeFact(part)===target);
}
function verifiedCommerceImage(images:string[]):string|undefined{
  for(const image of images){
    if(!text(image,2048))continue;
    try{
      const url=new URL(image);
      if(url.protocol==="https:"&&!url.username&&!url.password)return url.toString();
    }catch{}
  }
}

async function retrieveV4(
  connection:RagConnection,
  input:Parameters<RetrieverPort["search"]>[0],
  target:URL,
  timeout:number,
  getProduct:ProductLookup,
  fetcher:typeof fetch,
  reviewLookup:ReviewLookup,
):Promise<{candidates:ProductCandidate[];evidence:EvidenceRecord[];trace?:Record<string,number>}> {
  if(!text(input.requestId,128)||!text(input.originalQuestion,3000)||
     !text(input.query,250)||!Array.isArray(input.requiredConditions)||
     input.requiredConditions.length>25||!input.requiredConditions.every(x=>text(x,128)))
    throw new Error("invalid RAG v4 request");
  const preferences=input.preferences??[];
  if(!Array.isArray(preferences)||preferences.length>20||!preferences.every(p=>text(p,128))||
    input.maxTotalWon!==null&&(!Number.isSafeInteger(input.maxTotalWon)||input.maxTotalWon<0))throw Error('invalid RAG search context');
  const categories=connection.categories;
  if(categories&&(!categories.length||categories.length>100||!categories.every(c=>text(c,80))))throw Error("invalid RAG categories");
  const category=categories?(input.category??connection.category??""):(connection.category??"beauty");
  if((!categories&&!text(category,80))||categories&&category!==""&&!categories.includes(category))return {candidates:[],evidence:[]};
  if(!categories&&input.category&&input.category!==category)return {candidates:[],evidence:[]};
  const response=await fetcher(target.toString(),{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(timeout),
    headers:{"content-type":"application/json",...(connection.token?{authorization:"Bearer "+connection.token}:{})},
    body:JSON.stringify({request_id:input.requestId,original_question:input.originalQuestion,...(connection.profile?{profile:connection.profile}:{}),
      // Remote preferences are hints, not verified conditions. Commerce and
      // Ranking enforce the original hard requirements and shipping-inclusive budget.
      query:connection.mode==='local'?[input.query,...preferences].join(' ').slice(0,250):input.query,
      ...(category||connection.mode==='local'?{category}:{}),
      filters:connection.mode==='remote'?{in_stock:true,...(input.maxTotalWon!==null?{price_max:input.maxTotalWon,currency:'KRW'}:{})}:{},
      required_conditions:input.requiredConditions,preferences:connection.mode==='local'?[]:preferences,top_k:input.reviewSortAspect?10:5})
  });
  const rawResponse=await boundedJson(response);
  const envelope=obj(rawResponse);
  if(connection.profile&&envelope?.profile_name!==connection.profile)throw Error('RAG profile mismatch');
  if(envelope?.status==='error'||envelope?.error_code)throw Error('RAG search failed');
  const parsed=parseV4Response(rawResponse,connection.datasetVersion!,input.reviewSortAspect?10:5);
  if(envelope?.status==='low_relevance'||envelope?.status==='no_results')return {candidates:[],evidence:[]};
  const candidates:ProductCandidate[]=[],evidence:EvidenceRecord[]=[];
  for(const item of parsed.items){
    const got=await getProduct({product_id:item.productId});
    if(!got.ok||got.data.product.id!==item.productId||!got.data.product.active)continue;
    const available=got.data.variants.filter(v=>v.availability==='AVAILABLE'&&v.stock_qty>0&&(!item.commerceVariantId||v.variant_id===item.commerceVariantId));
    if(!available.length)continue;
    const eligible=item.evidence.filter(e=>available.some(v=>
      (e.variantId===null||v.variant_id===e.variantId)&&v.availability==="AVAILABLE"&&v.stock_qty>0));
    if(eligible.length===0&&!item.productEvidence)continue;
    const reviews=validV4ReviewRows(
      eligible.length?await reviewLookup({product_id:item.productId,review_ids:eligible.map(e=>e.sourceId)}):[],
      item.productId,eligible,
    );
    const byVariant=new Map<string,ParsedV4Evidence[]>();
    if(!eligible.length&&item.productEvidence)byVariant.set(available[0].variant_id,[]);
    for(const entry of eligible){
      for(const variant of available.filter(v=>
        (entry.variantId===null||v.variant_id===entry.variantId))){
        const group=byVariant.get(variant.variant_id)??[];
        group.push(entry);byVariant.set(variant.variant_id,group);
      }
      const source=reviews.get(entry.sourceId);
      if(source)evidence.push({id:source.id,productId:source.product_id,variantId:source.variant_id,rating:source.rating,
        kind:"REVIEW",sourceKind:source.source_kind,sourceRef:source.source_ref,
        text:entry.evidenceText,sourceId:entry.sourceId,verified:true,datasetVersion:parsed.datasetVersion});
    }
    for(const [variantId,entries] of byVariant){
      const variant=got.data.variants.find(v=>v.variant_id===variantId);
      if(!variant||variant.availability!=="AVAILABLE"||variant.stock_qty<=0)continue;
      const hasSynthetic=entries.some(e=>e.synthetic);
      const hasVerifiedSource=entries.some(e=>reviews.has(e.sourceId));
      const catalogContext=got.data.catalog_context;
      const isSimulated=(catalogContext?.source==="test_items"||catalogContext?.source==="test_items2")&&catalogContext.read_only===true&&catalogContext.is_simulated===true;
      const qaRankingEligible=(connection.catalogSource==="test_items"||connection.catalogSource==="test_items2")&&isSimulated;
      const specSourceKind=isSimulated?"SYNTHETIC":"REAL";
      const specs={...got.data.product.specs,...variant.effective_specs};
      const specFacts=Object.entries(specs).filter(([key,value])=>usableCommerceSpec(key,value)).slice(0,20)
        .map(([key,value],index)=>{
          const row:EvidenceRecord={id:`commerce-spec:${item.productId}:${variantId}:${index}`,
            productId:item.productId,variantId,kind:"SPEC",sourceKind:specSourceKind,sourceRef:key,
            text:value,verified:true,datasetVersion:parsed.datasetVersion};
          evidence.push(row);return {key,value,id:row.id};
        });
      const conditions:Record<string,string[]>={};
      for(const condition of input.requiredConditions){
        const ids=specFacts.filter(row=>matchesCommerceCondition(row.key,row.value,condition)).map(row=>row.id);
        if(ids.length)conditions[condition]=ids;
      }
      const ratingRows=entries.map(entry=>reviews.get(entry.sourceId)).filter((row):row is ReviewItem=>
        !!row&&row.product_id===item.productId&&(row.variant_id===null||row.variant_id===variantId)&&
        Number.isFinite(row.rating)&&row.rating>=1&&row.rating<=5);
      const facets:ProductCandidate["facets"]={};
      if(ratingRows.length)facets.retrieved_review_rating={
        score:ratingRows.reduce((sum,row)=>sum+row.rating,0)/ratingRows.length/5,
        evidenceIds:[...new Set(ratingRows.map(row=>row.id))],
      };
      const productImage=verifiedCommerceImage(got.data.product.images);
      const keywords=specFacts.map(row=>`${row.key}: ${row.value}`).filter(value=>value.length<=128).slice(0,3);
      candidates.push({productName:got.data.product.name,productId:item.productId,variantId,
        ...(productImage?{productImage}:{}),...(keywords.length?{keywords}:{}),
        unitPriceWon:variant.unit_price_won,shippingFeeWon:got.data.shipping_fee_won,
        rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
        conditions,facets,sourceKind:hasSynthetic?"SYNTHETIC":hasVerifiedSource?"REAL":item.productEvidence?specSourceKind:undefined,
        datasetVersion:parsed.datasetVersion,commerceVerified:true,
        ...(isSimulated?{isSimulated:true}:{}),...(qaRankingEligible?{qaRankingEligible:true}:{})});
    }
  }
  if(candidates.length>100)throw new Error("RAG v4 candidate limit");
  const trace:Record<string,number>={};
  // Only the in-process transport supplies stage measurements; never trust remote timings.
  if(connection.mode==="local"){
    const measured=obj(obj(rawResponse)?.search_trace);
    for(const key of ["embeddingMs","bm25Ms","vectorMs","fusionMs","bm25HitCount","vectorScannedCount","fusedProductCount"]){
      const value=measured?.[key];
      if(typeof value==="number"&&Number.isFinite(value)&&value>=0)trace[key]=value;
    }
    trace.verifiedCandidateCount=candidates.length;trace.verifiedReviewCount=evidence.filter(row=>row.kind==="REVIEW").length;
  }
  return {candidates,evidence,...(Object.keys(trace).length?{trace}:{})};
}
export function validateRagEndpoint(endpoint:string):URL {
  let u:URL;
  try{u=new URL(endpoint);}catch{throw new Error("invalid RAG endpoint URL");}
  const local=["localhost","127.0.0.1","[::1]"].includes(u.hostname);
  if((u.protocol!=="https:"&&!(local&&u.protocol==="http:"))||!u.hostname||
     u.username||u.password||u.hash||u.search)
    throw new Error("RAG endpoint must use HTTPS (HTTP loopback only)");
  return u;
}
async function boundedJson(response:Response):Promise<unknown>{
  if(!response.ok)throw new Error("RAG unavailable");
  const body=response.body;
  if(!body)throw new Error("RAG body absent");
  const reader=body.getReader(),parts:Uint8Array[]=[];
  let size=0;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.length;
      if(size>maxResponseBytes)throw new Error("RAG response too large");
      parts.push(part.value);
    }
  }finally{reader.releaseLock();}
  const combined=new Uint8Array(size);let offset=0;
  for(const p of parts){combined.set(p,offset);offset+=p.length;}
  try{return JSON.parse(new TextDecoder().decode(combined));}
  catch{throw new Error("RAG response must be JSON");}
}
function parseEvidence(rows:unknown):EvidenceRecord[]{
  if(!Array.isArray(rows)||rows.length>300)throw new Error("RAG evidence limit");
  const result:EvidenceRecord[]=[],seen=new Set<string>();
  for(const raw of rows){
    const r=obj(raw);if(!r||!text(r.id,128)||!text(r.productId,128)||
      (r.variantId!==null&&!text(r.variantId,128))||
      (r.kind!=="SPEC"&&r.kind!=="REVIEW")||
      (r.kind==="REVIEW"&&(r.sourceKind!=="REAL"||!text(r.sourceRef,500)))||
      seen.has(r.id))throw new Error("invalid or duplicate RAG evidence");
    seen.add(r.id);
    result.push({id:r.id,productId:r.productId,variantId:r.variantId as string|null,
      kind:r.kind,sourceKind:r.sourceKind==="REAL"?"REAL":undefined,
      sourceRef:typeof r.sourceRef==="string"?r.sourceRef:undefined});
  }
  return result;
}
function parseCandidates(rows:unknown):Record<string,unknown>[] {
  if(!Array.isArray(rows)||rows.length>30)throw new Error("RAG candidate limit");
  const seen=new Set<string>();
  return rows.map(raw=>{
    const r=obj(raw);
    if(!r||!text(r.productId,128)||!text(r.variantId,128))throw new Error("invalid Commerce ID mapping");
    const key=JSON.stringify([r.productId,r.variantId]);
    if(seen.has(key))throw new Error("duplicate RAG candidate");
    seen.add(key);
    return r;
  });
}
export function verifiedRagRetriever(
  connection:RagConnection,
  getProduct:ProductLookup,
  fetcher:typeof fetch=fetch,
  reviewLookup?:ReviewLookup,
):RetrieverPort {
  if(connection.profile&&!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(connection.profile))throw Error('invalid RAG profile');
  if(connection.mode==="local"&&fetcher===fetch)
    throw new Error("local RAG requires an injected in-process transport");
  const target=validateRagEndpoint(connection.endpoint);
  const contract=connection.contract??"brain-rag-v1";
  if(contract==="brain-rag-v1"&&!text(connection.auditId,128))
    throw new Error("RAG audited dataset ID required");
  if(contract==="v4"&&!text(connection.datasetVersion,128))
    throw new Error("RAG dataset version required");
  if(connection.catalogSource!==undefined&&connection.catalogSource!=="public"&&connection.catalogSource!=="test_items"&&connection.catalogSource!=="test_items2")
    throw new Error("invalid server catalog source");
  if(contract==="v4"&&!reviewLookup)throw new Error("RAG v4 ReviewLookup required");
  const timeout=connection.timeoutMs??8000;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>20000)throw new Error("invalid RAG timeout");
  return {async search(input){
    if(contract==="v4")return retrieveV4(connection,input,target,timeout,getProduct,fetcher,reviewLookup!);
    if(!text(input.query,250))throw new Error("invalid RAG query");
    const response=await fetcher(target.toString(),{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(timeout),
      headers:{"content-type":"application/json",...(connection.token?{authorization:"Bearer "+connection.token}:{})},
      body:JSON.stringify({version:"brain-rag-v1",query:input.query,
        maxTotalWon:input.maxTotalWon,requiredConditions:input.requiredConditions})
    });
    const raw=obj(await boundedJson(response));
    if(!raw||raw.version!=="brain-rag-v1")throw new Error("RAG contract version mismatch");
    const evidence=parseEvidence(raw.evidence),candidateRows=parseCandidates(raw.candidates);
    const evidenceById=new Map(evidence.map(e=>[e.id,e]));
    const byProduct=new Map<string,ProductDetail|null>();
    const candidates:ProductCandidate[]=[];
    for(const row of candidateRows){
      const productId=row.productId as string,variantId=row.variantId as string;
      if(!byProduct.has(productId)){
        const got=await getProduct({product_id:productId});
        byProduct.set(productId,got.ok?got.data:null);
      }
      const verified=byProduct.get(productId);
      if(!verified||verified.product.id!==productId||!verified.product.active)continue;
      const variant=verified.variants.find(v=>v.variant_id===variantId);
      if(!variant||variant.availability!=="AVAILABLE"||variant.stock_qty<=0)continue;
      const rawFacets=obj(row.facets)??{},facets:ProductCandidate["facets"]={};
      if(Object.keys(rawFacets).length>25)throw Error("RAG facet limit");
      for(const aspect of Object.keys(rawFacets)){
        if(!/^[a-z][a-z0-9_]{0,79}$/.test(aspect))throw Error("invalid RAG facet identifier");
        const f=pickRecord(rawFacets[aspect]);if(f)facets[aspect]=f;
      }
      // A retrieved claim must cite evidence for this exact Commerce product
      // and, when variant-scoped, for this exact variant. Never borrow another
      // candidate's review or a stale variant's specification.
      const checkIds=(ids:readonly string[])=>{
        for(const id of ids){
          const ev=evidenceById.get(id);
          if(!ev||ev.productId!==productId||(ev.variantId!==null&&ev.variantId!==variantId))
            throw new Error("RAG cross-product evidence mismatch");
        }
      };
      for(const facet of Object.values(facets))if(facet)checkIds(facet.evidenceIds);
      const conditions:Record<string,string[]>={};
      const rawConditions=obj(row.conditions);
      if(rawConditions){
        for(const [k,v] of Object.entries(rawConditions)){
          if(text(k,80)&&Array.isArray(v)&&v.length<=25&&v.every(x=>text(x,128))){
            checkIds(v as string[]);
            conditions[k]=v as string[];
          }
        }
      }
      const audited=row.reviewCountAuditId===connection.auditId&&
        text(row.sourceProductId,128)&&whole(row.wholeReviewCount)&&
        typeof row.rating==="number"&&Number.isFinite(row.rating)&&
        row.rating>=1&&row.rating<=5&&row.ratingScale===5;
      candidates.push({
        productName:verified.product.name,productId,variantId,unitPriceWon:variant.unit_price_won,
        shippingFeeWon:verified.shipping_fee_won,
        rating:audited?row.rating as number:null,ratingScale:audited?5:null,
        wholeReviewCount:audited?row.wholeReviewCount as number:null,
        wholeReviewCountVerified:!!audited,conditions,facets,commerceVerified:true
      });
    }
    return {candidates,evidence};
  }};
}
