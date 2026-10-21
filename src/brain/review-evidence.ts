import {createReviewSummaryLookup} from './review-summary.ts';
import type {EvidenceRecord,ReviewSummaryData,ReviewSummaryRequest} from './contracts.ts';
import type {DisplayedReviewProduct} from './review-analysis.ts';
import type {ResearchResult} from './read-flow.ts';

type Catalog=Pick<ReturnType<typeof import('../catalog.ts')['createCatalog']>,'getProduct'|'getReviews'|'searchProducts'>;
export type ScopedReviewSearch=(input:{products:DisplayedReviewProduct[];query:string;originalQuestion:string;requestId:string;category?:string})=>Promise<EvidenceRecord[]>;
type Input={request:ReviewSummaryRequest;previous?:ResearchResult;originalQuestion?:string;requestId?:string;category?:string};

/** Keep ordinary summaries on Commerce; semantic queries use only scoped RAG evidence. */
export function createReviewEvidenceLookup(catalog:Catalog,datasetVersion?:string,search?:ScopedReviewSearch){
 const ordinary=createReviewSummaryLookup(catalog,datasetVersion);
 return async(input:Input):Promise<ReviewSummaryData>=>{
   const {request,previous}=input;
   if(!request.semanticQuery&&request.focus!=='CONS'&&!request.productIds)return ordinary(request,previous);
   if(!search)throw Error('semantic review unavailable');
   let selected:ReviewSummaryData['product'];
   let ids=request.productIds??(request.productId?[request.productId]:undefined);
   if(!ids){
     const resolved=await ordinary(request,previous);
     if(!resolved.product||resolved.status==='AMBIGUOUS'||resolved.status==='NOT_FOUND')return resolved;
     selected=resolved.product;ids=[selected.id];
   }
   if(ids.length<1||ids.length>3||new Set(ids).size!==ids.length)throw Error('invalid review target scope');
   const priorAllowed=(!datasetVersion||previous?.datasetVersion===datasetVersion)?[
     ...(previous?.shoppingPlan?.lastDisplayedProducts??[]),
     ...(previous?.explanation?.reviewSummary?.products??[]).map(p=>({productId:p.id,variantId:p.variantId,name:p.name})),
     ...(previous?.explanation?.reviewSummary?.product?[{productId:previous.explanation.reviewSummary.product.id,
       variantId:previous.explanation.reviewSummary.product.variantId,name:previous.explanation.reviewSummary.product.name}]:[]),
   ]:[];
   const products:NonNullable<ReviewSummaryData['products']>=[],targets:DisplayedReviewProduct[]=[];
   for(const id of ids){
     const prior=priorAllowed.find(row=>row.productId===id);
     if(!prior&&selected?.id!==id)throw Error('unverified review target');
     const detail=await catalog.getProduct({product_id:id});
     if(!detail.ok||detail.data.product.id!==id||!detail.data.product.name)throw Error('invalid review target');
     const expected=selected?.id===id?selected:prior;
     if(expected?.name&&expected.name!==detail.data.product.name)throw Error('review target name mismatch');
     const variantId=request.productId===id?request.variantId??expected?.variantId:expected?.variantId;
     if(variantId&&!detail.data.variants.some(v=>v.variant_id===variantId))throw Error('review target variant mismatch');
     const product={id,name:detail.data.product.name,...(variantId?{variantId}:{}),
       ...(detail.data.product.images[0]?{image:detail.data.product.images[0]}:{})};
     products.push(product);targets.push({productId:id,name:product.name,...(variantId?{variantId}:{}),displayIndex:targets.length+1});
   }
   const query=request.semanticQuery?.trim()||(request.focus==='CONS'?'사용하면서 아쉬웠던 점과 불편했던 경험':'상품 사용 경험');
   if(query.length>300)throw Error('invalid review semantic query');
   const evidence=await search({products:targets,query,originalQuestion:input.originalQuestion??query,
     requestId:input.requestId??crypto.randomUUID(),...(input.category?{category:input.category}:{})});
   return {status:evidence.length?'READY':'NO_REVIEWS',focus:request.focus,products,
     ...(products.length===1?{product:products[0]}:{}),evidence,semanticQuery:query,scope:'SEMANTIC_SAMPLES',
     ...(datasetVersion?{datasetVersion}:{})};
 };
}
