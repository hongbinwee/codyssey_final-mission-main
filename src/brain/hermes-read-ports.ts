/** H3 reusable read adapters. These observations are context, never permission to mutate Commerce. */
import type {CartView,OrderView,OrderListItem,ShippingStatusResult,ProductDetail,ReviewsResult} from "../contracts.ts";
import type {createCatalog} from "../catalog.ts";
import {cartView} from "../cart.ts";
import {sql,type Q} from "../db.ts";

export type CartFacts={items:{productId:string;variantId:string;productName:string;quantity:number;unitPriceWon:number;availability:string}[];
 itemCount:number;itemsTotalWon:number;shippingFeeWon:number;totalWon:number;canCheckout:boolean};
export type ProductFacts={productId:string;name:string;brand:string;category:string;active:boolean;availability:string;shippingFeeWon:number;
 variants:{variantId:string;priceWon:number;availability:string;optionValues:Record<string,string>}[];variantCount:number};
export type ReviewFacts={productId:string;query:string;totalMatching:number;reviews:{id:string;rating:number;body:string;sourceKind:"REAL"|"SYNTHETIC";variantId:string|null}[]};
export type OrdersFacts={orders:{orderId:string;createdAt:string;itemSummary:string;totalWon:number;status:string;shippingStatus:string|null;cancelEligible:boolean}[];hasMore:boolean};
export type OrderFacts={orderId:string;status:string;createdAt:string;totalWon:number;shippingStatus:string|null;cancelEligible:boolean;
 items:{productId:string|null;productName:string;quantity:number;unitPriceWon:number}[]};
export type ShippingFacts={orderId:string;information:"AVAILABLE"|"NO_INFORMATION";status:string|null;estimatedArrivalAt:string|null;
 events:{status:string;occurredAt:string}[]};

export function summarizeCart(view:CartView):CartFacts{
 return {items:view.items.slice(0,20).map(x=>({productId:x.product_id,variantId:x.variant_id,productName:x.product_name,
  quantity:x.quantity,unitPriceWon:x.unit_price_won,availability:x.availability})),
  itemCount:view.items.length,itemsTotalWon:view.items_total_won,shippingFeeWon:view.shipping_fee_won,
  totalWon:view.total_won,canCheckout:view.can_checkout};
}
export function summarizeProduct(view:ProductDetail):ProductFacts{
 return {productId:view.product.id,name:view.product.name,brand:view.product.brand,category:view.product.category,
  active:view.product.active,availability:view.product.availability,shippingFeeWon:view.shipping_fee_won,
  variants:view.variants.slice(0,8).map(x=>({variantId:x.variant_id,priceWon:x.unit_price_won,availability:x.availability,
   optionValues:x.option_values})),variantCount:view.variants.length};
}
export function summarizeReviews(productId:string,query:string,view:ReviewsResult):ReviewFacts{
 return {productId,query,totalMatching:view.total_matching,
  reviews:view.reviews.slice(0,5).map(x=>({id:x.id,rating:x.rating,body:x.body.slice(0,320),sourceKind:x.source_kind,
    variantId:x.variant_id}))};
}
export function summarizeOrders(orders:OrderListItem[],hasMore:boolean):OrdersFacts{
 return {orders:orders.slice(0,10).map(o=>({orderId:o.id,createdAt:o.created_at,itemSummary:o.item_summary,
  totalWon:o.total_won,status:o.order_status,shippingStatus:o.shipping_status,cancelEligible:o.cancel_eligible===true})),hasMore};
}
export function summarizeOrder(order:OrderView):OrderFacts{
 return {orderId:order.id,status:order.status,createdAt:order.created_at,totalWon:order.total_won,
  shippingStatus:order.shipping?.status??null,cancelEligible:order.cancel_eligible,
  items:order.items.slice(0,20).map(x=>({productId:x.product_id,productName:x.product_name,
   quantity:x.quantity,unitPriceWon:x.unit_price_won}))};
}
export function summarizeShipping(ship:ShippingStatusResult):ShippingFacts{
 return {orderId:ship.order_id,information:ship.information,status:ship.status,
  estimatedArrivalAt:ship.estimated_arrival_at,
  events:ship.events.slice(0,20).map(x=>({status:x.status,occurredAt:x.occurred_at}))};
}
/** The regular getCart creates a cart on GET; Agent reads must NEVER create one. */
export async function readExistingCart(actorUserId:string,db:Q=sql):Promise<CartFacts>{
 if(!actorUserId||actorUserId.length>256)throw Error("invalid actor");
 const rows=await db.unsafe<{id:string;version:number}[]>(
  "SELECT id,version FROM carts WHERE user_id=$1 LIMIT 1",[actorUserId]);
 if(!rows.length)return {items:[],itemCount:0,itemsTotalWon:0,shippingFeeWon:0,totalWon:0,canCheckout:false};
 return summarizeCart(await cartView(db,rows[0]));
}
type CatalogReader=Pick<ReturnType<typeof createCatalog>,"getProduct"|"getReviews">;
export interface HermesReadSources {
 actorUserId:string;catalog:CatalogReader;
 /** Only enabled for explicitly matching QA Commerce DB + catalog identity. */
 ownedCommerce:boolean;
 cart?:()=>Promise<CartFacts>;
 orders?:()=>Promise<{orders:OrderListItem[];hasMore:boolean}>;
 order?:(orderId:string)=>Promise<OrderView|null>;
 shipping?:(orderId:string)=>Promise<ShippingStatusResult|null>;
}
/** Returns only allowlisted, bounded observations; address/payment records are never sent to the model. */
export function createHermesReadPorts(src:HermesReadSources){
 if(!src.actorUserId||src.actorUserId.length>256)throw Error("invalid actor");
 const publicReads={
  product:async(productId:string):Promise<ProductFacts|null>=>{
   const res=await src.catalog.getProduct({product_id:productId});
   return res.ok?summarizeProduct(res.data):null;
  },
  reviews:async(productId:string,query=""):Promise<ReviewFacts|null>=>{
   const res=await src.catalog.getReviews({product_id:productId,query,limit:5,sort:"LATEST"});
   return res.ok?summarizeReviews(productId,query,res.data):null;
  }
 };
 if(!src.ownedCommerce)return publicReads;
 return {...publicReads,
  cart:src.cart??(()=>readExistingCart(src.actorUserId)),
  orders:async():Promise<OrdersFacts>=>{
   if(!src.orders)throw Error("orders unavailable");
   const result=await src.orders();
   return summarizeOrders(result.orders,result.hasMore);
  },
  order:async(orderId:string):Promise<OrderFacts|null>=>src.order?summarizeNullableOrder(await src.order(orderId)):null,
  shipping:async(orderId:string):Promise<ShippingFacts|null>=>src.shipping?summarizeNullableShipping(await src.shipping(orderId)):null
 };
}
function summarizeNullableOrder(value:OrderView|null):OrderFacts|null{return value?summarizeOrder(value):null;}
function summarizeNullableShipping(value:ShippingStatusResult|null):ShippingFacts|null{return value?summarizeShipping(value):null;}
