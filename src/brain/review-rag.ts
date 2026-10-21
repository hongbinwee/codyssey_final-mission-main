import type {ProductDetail,ReviewItem,ToolResult} from "../contracts.ts";
import type {EvidenceRecord} from "./contracts.ts";
import {parseV4Response,validateRagEndpoint,type RagConnection} from "./rag-adapter.ts";
import type {DisplayedReviewProduct} from "./review-analysis.ts";

const MAX_TARGETS=3;
const MAX_RESPONSE_BYTES=400_000;
const MAX_REVIEW_TEXT=1200;
const SAFE_ID=/^[^\u0000-\u001f]{1,128}$/;

type ReviewSearchCatalog={
 getProduct(input:{product_id:string}):Promise<ToolResult<ProductDetail>>;
 getReviewsByIds(input:{product_id:string;review_ids:string[]}):Promise<ReviewItem[]>;
};
type ReviewSearchInput={products:DisplayedReviewProduct[];query:string;originalQuestion:string;requestId:string;category?:string};
type SearchFetcher=(input:ReviewSearchInput)=>Promise<EvidenceRecord[]>;
type JsonObject=Record<string,unknown>;
type VerifiedProduct={product:ProductDetail;selectedVariantId?:string};

function object(value:unknown):JsonObject|undefined{
 return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as JsonObject:undefined;
}
function safeId(value:unknown):value is string{return typeof value==="string"&&SAFE_ID.test(value)&&value===value.trim();}
function safeText(value:unknown,max=3000):value is string{
 return typeof value==="string"&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f]/.test(value);
}
function sameIds(actual:unknown,expected:string[]):boolean{
 if(!Array.isArray(actual)||actual.length!==expected.length||!actual.every(safeId)||new Set(actual).size!==actual.length)return false;
 const expectedSet=new Set(expected);
 return actual.every(id=>expectedSet.has(id));
}
function isEmptyObject(value:unknown):boolean{
 const row=object(value);
 return !!row&&Object.keys(row).length===0;
}
function validAppliedFilters(raw:JsonObject,productIds:string[],profile:string,category?:string):boolean{
 const applied=object(raw.applied_filters);
 if(!applied||applied.source_type!=="review"||!sameIds(applied.product_ids,productIds))return false;
 if(Object.hasOwn(applied,"filters")&&!isEmptyObject(applied.filters))return false;
 for(const key of ["required_conditions","preferences"]){
  if(Object.hasOwn(applied,key)&&(!Array.isArray(applied[key])||(applied[key] as unknown[]).length!==0))return false;
 }
 if(applied.profile!==undefined&&applied.profile!==profile)return false;
 if(category!==undefined&&applied.category!==category)return false;
 return true;
}
async function boundedJson(response:Response):Promise<unknown>{
 if(!response.ok)throw new Error("RAG unavailable");
 if(!response.body)throw new Error("RAG body absent");
 const reader=response.body.getReader(),parts:Uint8Array[]=[];
 let size=0;
 try{
  for(;;){
   const part=await reader.read();
   if(part.done)break;
   size+=part.value.length;
   if(size>MAX_RESPONSE_BYTES)throw new Error("RAG response too large");
   parts.push(part.value);
  }
 }finally{reader.releaseLock();}
 const combined=new Uint8Array(size);let offset=0;
 for(const part of parts){combined.set(part,offset);offset+=part.length;}
 try{return JSON.parse(new TextDecoder().decode(combined));}catch{throw new Error("RAG response must be JSON");}
}
function validateTargetList(products:unknown):products is DisplayedReviewProduct[]{
 if(!Array.isArray(products)||products.length<1||products.length>MAX_TARGETS)return false;
 const ids=new Set<string>(),indexes=new Set<number>();
 for(const value of products){
  if(!value||typeof value!=="object")return false;
  const item=value as Partial<DisplayedReviewProduct>;
  if(!safeId(item.productId)||item.variantId!==undefined&&!safeId(item.variantId)||
     !Number.isSafeInteger(item.displayIndex)||item.displayIndex!<1||item.displayIndex!>MAX_TARGETS||
     ids.has(item.productId)||indexes.has(item.displayIndex!))return false;
  ids.add(item.productId);indexes.add(item.displayIndex!);
 }
 return true;
}
function validateRequest(input:ReviewSearchInput):boolean{
 return !!input&&validateTargetList(input.products)&&safeText(input.query,3000)&&
  safeText(input.originalQuestion,3000)&&input.query.trim().length>0&&input.originalQuestion.trim().length>0&&safeId(input.requestId)&&
  (input.category===undefined||safeText(input.category,80));
}
async function verifyProducts(catalog:ReviewSearchCatalog,targets:DisplayedReviewProduct[]):Promise<Map<string,VerifiedProduct>>{
 const verified=new Map<string,VerifiedProduct>();
 for(const target of targets){
  const result=await catalog.getProduct({product_id:target.productId});
  if(!result.ok||result.data.product.id!==target.productId||!Array.isArray(result.data.variants))
   throw new Error("Commerce product lookup failed");
  if(target.variantId!==undefined&&!result.data.variants.some(variant=>variant.variant_id===target.variantId))
   throw new Error("unknown Commerce variant");
  verified.set(target.productId,{product:result.data,...(target.variantId?{selectedVariantId:target.variantId}:{})});
 }
 return verified;
}
function validateRawScope(raw:JsonObject,productIds:string[],profile:string,version:string):Map<string,string>{
 if(raw.profile_name!==profile||raw.dataset_version!==version||!Array.isArray(raw.items)||
    raw.items.length>productIds.length)throw new Error("RAG profile, version, or item scope mismatch");
 const allowed=new Set(productIds);
 const sourceRefs=new Map<string,string>();
 for(const value of raw.items){
  const item=object(value);
  if(!item||!safeId(item.product_id)||!allowed.has(item.product_id)||!Array.isArray(item.evidence))
   throw new Error("RAG item outside requested product scope");
   for(const evidenceValue of item.evidence){
   const evidence=object(evidenceValue);
    const metadata=object(evidence?.source_metadata);
    const sourceId=evidence?.source_id;
    const sourceRef=metadata?.source_ref;
   if(!evidence||evidence.source_type!=="review"||evidence.product_id!==item.product_id||
       evidence.source_version!==version||!safeId(sourceId)||!safeText(sourceRef,500))
     throw new Error("RAG review source scope, version, or reference mismatch");
    const previous=sourceRefs.get(sourceId);
    if(previous!==undefined&&previous!==sourceRef)throw new Error("RAG review source reference conflict");
    sourceRefs.set(sourceId,sourceRef);
  }
 }
 return sourceRefs;
}
function validReviewRows(rows:unknown,productId:string,expected:Map<string,{variantId:string|null;sourceKind:"REAL"|"SYNTHETIC";excerpts:string[]}>):Map<string,ReviewItem>{
 if(!Array.isArray(rows))throw new Error("invalid Commerce review lookup response");
 const found=new Map<string,ReviewItem>();
 for(const value of rows){
  const row=object(value);
  const body=row?.body;
  if(!row||!safeId(row.id)||!safeId(row.product_id)||
     !(row.variant_id===null||safeId(row.variant_id))||typeof body!=="string"||
     typeof row.rating!=="number"||!Number.isFinite(row.rating)||row.rating<1||row.rating>5||
     (row.source_kind!=="REAL"&&row.source_kind!=="SYNTHETIC")||!safeText(row.source_ref,500)||
     typeof row.written_at!=="string")throw new Error("invalid Commerce review source");
  const wanted=expected.get(row.id);
  if(!wanted||found.has(row.id)||row.product_id!==productId||row.variant_id!==wanted.variantId||
     row.source_kind!==wanted.sourceKind||!wanted.excerpts.every(excerpt=>body.includes(excerpt)))
   throw new Error("RAG review source or excerpt mismatch");
  found.set(row.id,row as unknown as ReviewItem);
 }
 return found;
}

/** Searches only the verified displayed product IDs and returns excerpts backed by original Commerce reviews. */
export function createScopedReviewSearch(
 connection:RagConnection,
 catalog:ReviewSearchCatalog,
 fetcher:typeof fetch=fetch,
):SearchFetcher{
 if(connection.contract!==undefined&&connection.contract!=="v4")throw new Error("review RAG requires the v4 contract");
 if(!safeText(connection.profile,80)||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(connection.profile))
  throw new Error("review RAG profile required");
 if(!safeText(connection.datasetVersion,128))throw new Error("review RAG dataset version required");
 if(connection.mode==="local"&&fetcher===fetch)throw new Error("local review RAG requires an injected transport");
 const target=validateRagEndpoint(connection.endpoint);
 const timeout=connection.timeoutMs??8000;
 if(!Number.isSafeInteger(timeout)||timeout<100||timeout>20000)throw new Error("invalid RAG timeout");
 return async(input)=>{
  if(!validateRequest(input))throw new Error("Invalid review evidence request");
  const productIds=input.products.map(product=>product.productId);
  const category=input.category??connection.category;
  if(category!==undefined&&(!safeText(category,80)||
     connection.categories!==undefined&&!connection.categories.includes(category)||
     connection.category!==undefined&&connection.categories===undefined&&category!==connection.category))
   throw new Error("Invalid review evidence category");
  if(connection.categories!==undefined&&(!connection.categories.length||connection.categories.length>100||
     !connection.categories.every(value=>safeText(value,80))))throw new Error("Invalid review evidence categories");
  try{
   // Commerce validation happens before RAG receives any target IDs.
   const products=await verifyProducts(catalog,input.products);
   const response=await fetcher(target.toString(),{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(timeout),
    headers:{"content-type":"application/json",...(connection.token?{authorization:"Bearer "+connection.token}:{})},
    body:JSON.stringify({request_id:input.requestId,profile:connection.profile,query:input.query,
     original_question:input.originalQuestion,...(category?{category}:{}),
     filters:{},required_conditions:[],preferences:[],product_ids:productIds,source_type:"review",top_k:3}),
   });
   if(response.status!==200)throw new Error("Review evidence service returned an unexpected status");
   const raw=object(await boundedJson(response));
   if(!raw||(raw.status!=="ok"&&raw.status!=="no_results")||raw.error_code!==undefined&&raw.error_code!==null)
    throw new Error("RAG review search failed");
   if(raw.error_code!==null)throw new Error("RAG review error status missing");
   if(!validAppliedFilters(raw,productIds,connection.profile!,category))throw new Error("RAG applied filter mismatch");
   const sourceRefs=validateRawScope(raw,productIds,connection.profile!,connection.datasetVersion!);
   const searchContext=object(raw.search_context);
   if(searchContext?.result_limit_semantics!=="products"||searchContext.evidence_limit_per_product!==3)
    throw new Error("RAG result limit semantics mismatch");
   if(raw.status==="no_results"){
    if((raw.items as unknown[]).length!==0)throw new Error("RAG no-results response contained items");
    return [];
   }
   if((raw.items as unknown[]).length===0)throw new Error("RAG success response contained no results");

   const parsed=parseV4Response(raw,connection.datasetVersion!);
   const output:EvidenceRecord[]=[],seenSources=new Set<string>();
   const itemsByProduct=new Map(parsed.items.map(item=>[item.productId,item]));
   for(const targetProduct of input.products){
    const item=itemsByProduct.get(targetProduct.productId);
    if(!item)continue;
    if(item.evidence.length>3)throw new Error("RAG review evidence limit");
    const verifiedProduct=products.get(item.productId);
    if(!verifiedProduct)throw new Error("unverified RAG product");
    const knownVariants=new Set(verifiedProduct.product.variants.map(variant=>variant.variant_id));
    const eligible=item.evidence.filter(entry=>{
     if(entry.variantId!==null&&!knownVariants.has(entry.variantId))throw new Error("unknown RAG review variant");
     return verifiedProduct.selectedVariantId===undefined||entry.variantId===null||entry.variantId===verifiedProduct.selectedVariantId;
    });
    if(!eligible.length)continue;
    const expected=new Map(eligible.map(entry=>[entry.sourceId,{variantId:entry.variantId,sourceKind:entry.sourceKind,excerpts:entry.evidenceTexts}]));
    const rows=validReviewRows(await catalog.getReviewsByIds({product_id:item.productId,review_ids:[...expected.keys()]}),item.productId,expected);
    for(const entry of eligible){
     const source=rows.get(entry.sourceId);
     if(!source||source.source_ref!==sourceRefs.get(entry.sourceId))
      throw new Error("RAG review source reference does not match Commerce");
     if(seenSources.has(entry.sourceId))throw new Error("duplicate Commerce review source ID");
     seenSources.add(entry.sourceId);
     const excerpt=entry.evidenceTexts[0]!.slice(0,MAX_REVIEW_TEXT);
     output.push({id:source.id,productId:source.product_id,variantId:source.variant_id,kind:"REVIEW",
      sourceKind:source.source_kind,sourceRef:source.source_ref,text:excerpt,sourceId:source.id,rating:source.rating,
      verified:true,datasetVersion:parsed.datasetVersion});
    }
   }
   return output;
  }catch{throw new Error("Review evidence search failed");}
 };
}

