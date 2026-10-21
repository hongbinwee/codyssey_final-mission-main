/**
 * H6: bounded, allowlisted observations for the LLM decision prompt.
 * Canonical observations remain unchanged in the LangGraph checkpoint. These
 * projections contain no account identity, addresses, payment data or raw Tool exceptions.
 */
import type {AgentObservation} from "./hermes-agent-step.ts";

const clip=(value:unknown,max=100)=>typeof value==="string"?value.slice(0,max):"";
const cap=<T>(value:unknown,count:number):T[]=>Array.isArray(value)?value.slice(0,count) as T[]:[];
const row=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const num=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const bool=(v:unknown)=>v===true;
const id=(v:unknown)=>clip(v,128);
const projection=(o:AgentObservation):unknown=>{
 if(o.tool==='save_to_wishlist'||o.tool==='add_to_cart'){
  const m=row(row(o.data).mutation);return {mutation:{status:clip(m.status,24),productId:id(m.productId),productName:clip(m.productName),quantity:num(m.quantity),message:clip(m.message,180)}};
 }
 if(!o.ok)return {unavailable:true};
 const v=row(o.data);
 switch(o.tool){
  case "get_purchase_history":return {purchases:cap<Record<string,unknown>>(v.purchases,10).map(p=>({
   productId:id(p.productId),productName:clip(p.productName),category:clip(p.category,60),
   unitPriceWon:num(p.unitPriceWon)}))};
  case "get_wishlist":return {saved_products:cap<Record<string,unknown>>(v.saved_products,10).map(p=>({
   productId:id(p.productId),name:clip(p.name),active:bool(p.active),minPriceWon:num(p.minPriceWon)}))};
  case "get_cart":{const c=row(v.cart);return {cart:{
   items:cap<Record<string,unknown>>(c.items,10).map(p=>({
    productId:id(p.productId),variantId:id(p.variantId),productName:clip(p.productName),
    quantity:num(p.quantity),unitPriceWon:num(p.unitPriceWon),availability:clip(p.availability,32)})),
   itemCount:num(c.itemCount),totalWon:num(c.totalWon),canCheckout:bool(c.canCheckout)
  }};}
  case "get_orders":{const q=row(v.orders);return {orders:{hasMore:bool(q.hasMore),
   orders:cap<Record<string,unknown>>(q.orders,10).map(p=>({
    orderId:id(p.orderId),itemSummary:clip(p.itemSummary),status:clip(p.status,36),
    shippingStatus:clip(p.shippingStatus,36),totalWon:num(p.totalWon),cancelEligible:bool(p.cancelEligible)}))
  }};}
  case "get_order":{const q=row(v.order);return {requestedOrderId:id(v.requestedOrderId),order:Object.keys(q).length?{
   orderId:id(q.orderId),status:clip(q.status,36),totalWon:num(q.totalWon),
   shippingStatus:clip(q.shippingStatus,36),cancelEligible:bool(q.cancelEligible),
   items:cap<Record<string,unknown>>(q.items,10).map(p=>({
    productId:id(p.productId),productName:clip(p.productName),quantity:num(p.quantity)}))
  }:null};}
  case "get_shipping_status":{const q=row(v.shipping);return {requestedOrderId:id(v.requestedOrderId),
   shipping:Object.keys(q).length?{orderId:id(q.orderId),information:clip(q.information,32),
    status:clip(q.status,36),estimatedArrivalAt:clip(q.estimatedArrivalAt,40),
    events:cap<Record<string,unknown>>(q.events,8).map(p=>({
     status:clip(p.status,36),occurredAt:clip(p.occurredAt,40)}))}:null};}
  case "get_product_detail":{const q=row(v.product);return {requestedProductId:id(v.requestedProductId),
   product:Object.keys(q).length?{
    productId:id(q.productId),name:clip(q.name),active:bool(q.active),
    shippingFeeWon:num(q.shippingFeeWon),
    variants:cap<Record<string,unknown>>(q.variants,8).map(p=>({
     variantId:id(p.variantId),priceWon:num(p.priceWon),availability:clip(p.availability,32)}))
   }:null};}
  case "get_product_reviews":{const q=row(v.review_evidence);return {
   requestedProductId:id(v.requestedProductId),requestedQuery:clip(v.requestedQuery,80),
   review_evidence:Object.keys(q).length?{
    totalMatching:num(q.totalMatching),reviews:cap<Record<string,unknown>>(q.reviews,5).map(p=>({
     id:id(p.id),rating:num(p.rating),body:clip(p.body,200),sourceKind:clip(p.sourceKind,24)
    }))
   }:null};}
  case "search_products":return {validated_candidates:cap<Record<string,unknown>>(v.validated_candidates,3).map(p=>({
   productId:id(p.productId),variantId:id(p.variantId),totalPriceWon:num(p.totalPriceWon),
   reviewCount:num(p.reviewCount)}))};
 }
};
/** Projection does not mutate or replace server-side results used for authorization. */
export function agentPromptObservations(observations:readonly AgentObservation[]):AgentObservation[]{
 return observations.slice(0,5).map(o=>({tool:o.tool,ok:o.ok,data:projection(o)}));
}
