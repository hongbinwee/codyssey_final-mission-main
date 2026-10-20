/** H5: server-issued screen handoffs, never tool calls or Commerce mutations. */
import type {RankingResult} from "./contracts.ts";
import type {WishlistView} from "./wishlist-task.ts";
import type {AgentObservation} from "./hermes-agent-step.ts";

export type ShoppingHandoff=
 |{kind:"PRODUCT_DETAIL";productId:string;variantId?:string;label:string}
 |{kind:"CART_REVIEW";label:string}
 |{kind:"CHECKOUT_REVIEW";label:string}
 |{kind:"ORDER_LIST";label:string}
 |{kind:"ORDER_DETAIL";orderId:string;label:string};

/** A handoff contains only a verified ID or a fixed application route; never URLs or write payloads. */
const validId=(s:unknown):s is string=>typeof s==="string"&&s.length>0&&s.length<=128&&
 !/[\u0000-\u001f]/.test(s);
export function validatedShoppingHandoffs(input:{
 ranking?:RankingResult;wishlist?:WishlistView;
 observations?:readonly AgentObservation[];
 /** Only a server-owned route that has the actor-scoped orders capability. */
 showOrdersForCancellation?:boolean;
}):ShoppingHandoff[]{
 const actions:ShoppingHandoff[]=[];
 const seen=new Set<string>();
 const add=(a:ShoppingHandoff)=>{
  const key=a.kind+("productId" in a?":"+a.productId:"orderId" in a?":"+a.orderId:"");
  if(!seen.has(key)&&actions.length<5){seen.add(key);actions.push(a);}
 };
 // Recommendations only from verified Commerce ranking, never model text or reference-only candidates.
 for(const row of (input.ranking?.ranked??[]).slice(0,3)){
  const p=row.candidate;
  if(p.commerceVerified===true&&validId(p.productId)&&validId(p.variantId)){
   add({kind:"PRODUCT_DETAIL",productId:p.productId,variantId:p.variantId,label:"상품 옵션 확인"});
  }
 }
 // A wishlist ordinal is first reverified against the current authenticated wishlist.
 const chosen=input.wishlist?.selectedProductId;
 const current=chosen&&input.wishlist?.items.find(x=>x.productId===chosen);
 if(current&&current.active&&current.minPriceWon!==null&&validId(current.productId))
  add({kind:"PRODUCT_DETAIL",productId:current.productId,label:"선택한 상품 옵션 확인"});
 for(const observation of input.observations??[]){
  if(!observation.ok||!observation.data||typeof observation.data!=="object")continue;
  const data=observation.data as Record<string,unknown>;
  if(observation.tool==="get_product_detail"){
   const product=data.product as {productId?:unknown;active?:boolean}|undefined;
   if(product?.active&&validId(product.productId))add({kind:"PRODUCT_DETAIL",productId:product.productId,label:"상품 옵션 확인"});
  }
  if(observation.tool==="get_cart"){
   const cart=data.cart as {items?:unknown[];canCheckout?:boolean}|undefined;
   if(cart){add({kind:"CART_REVIEW",label:"장바구니 확인"});
    // Checkout loads a fresh server-owned quote and still needs a separate user confirmation.
    if(cart.canCheckout===true&&Array.isArray(cart.items)&&cart.items.length>0)
     add({kind:"CHECKOUT_REVIEW",label:"주문서 확인"});
   }
  }
  if(observation.tool==="get_orders"){
   const orders=data.orders as {orders?:Array<{orderId:unknown}>}|undefined;
   if(orders){add({kind:"ORDER_LIST",label:"내 주문 목록 확인"});
    for(const item of (orders.orders??[]).slice(0,2))
     if(validId(item.orderId))add({kind:"ORDER_DETAIL",orderId:item.orderId,label:"주문 상세 확인"});
   }
  }
  if(observation.tool==="get_order"){
   const item=data.order as {orderId?:unknown}|undefined;
   if(validId(item?.orderId))add({kind:"ORDER_DETAIL",orderId:item.orderId,label:"주문 상세 확인"});
  }
  if(observation.tool==="get_shipping_status"){
   const shipping=data.shipping as {orderId?:unknown}|undefined;
   if(validId(shipping?.orderId))add({kind:"ORDER_DETAIL",orderId:shipping.orderId,label:"배송·주문 상세 확인"});
  }
 }
 if(input.showOrdersForCancellation)add({kind:"ORDER_LIST",label:"주문 내역에서 취소 확인"});
 return actions;
}
