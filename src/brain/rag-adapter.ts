import type {ProductDetail,ToolResult} from "../contracts.ts";
import type {Aspect,EvidenceRecord,GroundedFacet,ProductCandidate,RetrieverPort} from "./contracts.ts";

/**
 * Read-only RAG integration boundary. RAG supplies candidate/evidence references,
 * but price, shipping and current sellability MUST come from Commerce.
 * "wholeReviewCountVerified" is computed from a pre-approved ETL audit ID, never
 * trusted as a raw boolean returned by a model, client, or remote search service.
 */
export interface RagConnection {
  endpoint:string;
  auditId:string;
  token?:string;
  timeoutMs?:number;
}
type ProductLookup=(input:{product_id:string})=>Promise<ToolResult<ProductDetail>>;

function obj(v:unknown):Record<string,unknown>|null {
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
}
function text(v:unknown,max=160):v is string {
  return typeof v==="string"&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
}
function score(v:unknown):v is number{return typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1;}
function whole(v:unknown):v is number {return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;}
const aspects:Aspect[]=["performance","eye_comfort","noise"];
const maxResponseBytes=400_000;
const pickRecord=(v:unknown):GroundedFacet|undefined=>{
  const x=obj(v);
  if(!x||!score(x.score)||!Array.isArray(x.evidenceIds)||x.evidenceIds.length===0||
    x.evidenceIds.length>25||!x.evidenceIds.every(id=>text(id,128)))return;
  return {score:x.score,evidenceIds:x.evidenceIds as string[]};
};
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
  fetcher:typeof fetch=fetch
):RetrieverPort {
  const target=validateRagEndpoint(connection.endpoint);
  if(!text(connection.auditId,128))throw new Error("RAG audited dataset ID required");
  const timeout=connection.timeoutMs??8000;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>20000)throw new Error("invalid RAG timeout");
  return {async search(input){
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
      for(const aspect of aspects){
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
        rating:typeof row.rating==="number"&&Number.isFinite(row.rating)?row.rating:null,
        ratingScale:row.ratingScale===5?5:null,
        wholeReviewCount:whole(row.wholeReviewCount)?row.wholeReviewCount:null,
        wholeReviewCountVerified:!!audited,conditions,facets
      });
    }
    return {candidates,evidence};
  }};
}
