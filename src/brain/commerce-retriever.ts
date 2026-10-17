import type {SearchResult,ToolResult} from "../contracts.ts";
import type {RetrieverPort,ProductCandidate} from "./contracts.ts";
/**
 * Honest fallback for existing Commerce product search. Never infers Amazon-wide
 * review counts from locally imported review rows. Team RAG replaces this port.
 * While whole counts are unverified, all matches are reference-only.
 */
export function commerceRetriever(search:(input:{query:string;limit:number})=>Promise<ToolResult<SearchResult>>):RetrieverPort{
 return {async search({query}){
   const result=await search({query,limit:20});
   if(!result.ok)throw new Error("Commerce product search unavailable");
   const candidates:ProductCandidate[]=[];
   for(const p of result.data.items){
     for(const v of p.matched_variants){
       candidates.push({
         productName:p.name,productId:p.product_id,variantId:v.variant_id,unitPriceWon:v.unit_price_won,
         shippingFeeWon:result.data.shipping_fee_won,rating:p.rating_summary.avg,
         ratingScale:5,wholeReviewCount:null,wholeReviewCountVerified:false,
         conditions:{},facets:{}
       });
     }
   }
   return {candidates,evidence:[]};
 }};
}
