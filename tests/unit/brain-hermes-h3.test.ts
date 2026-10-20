import test from "node:test";
import assert from "node:assert/strict";
import {readExistingCart,createHermesReadPorts,summarizeOrder,summarizeReviews} from "../../src/brain/hermes-read-ports.ts";
import {runHermesReadLoop} from "../../src/brain/hermes-tools.ts";

const plan={query:"에센스",maxTotalWon:null,requiredConditions:[],currentPreferences:{},revision:1};
const item={productId:"p1",name:"에센스",active:true,minPriceWon:10000};
const mockCatalog={
 getProduct:async({product_id}:{product_id:string})=>({ok:true,data:{
  product:{id:product_id,name:"에센스",brand:"A",category:"beauty",active:true,availability:"AVAILABLE",
   description:"untrusted full text",images:[],specs:{},version:1},
  shipping_fee_won:3000,variants:[{variant_id:"v1",unit_price_won:10000,availability:"AVAILABLE",option_values:{size:"30ml"}}]
 }}),
 getReviews:async({product_id,query}:{product_id:string;query?:string})=>({ok:true,data:{
  reviews:[{id:"r1",rating:4,body:"촉촉하고 좋았어요",source_kind:"SYNTHETIC",variant_id:null,product_id}],
  total_matching:1,returned_count:1
 }})
};
function providerFrom(sequence:(messages:{role:string;content?:string|null;name?:string}[],tools:unknown[])=>{content:string|null;tool_calls?:{id:string;name:string;arguments:string}[]}){
 return {chat:async(messages:never,tools:never)=>sequence(messages,tools)};
}
test("readExistingCart does not INSERT or create an empty cart",async()=>{
 const queries:string[]=[];
 const db={unsafe:async(query:string,params:unknown[])=>{queries.push(query);assert.deepEqual(params,["owner-a"]);return []}};
 const result=await readExistingCart("owner-a",db as never);
 assert.deepEqual(result.items,[]);assert.equal(result.totalWon,undefined); // intentionally not camel variant
 assert.equal(result.totalWon,0);
 assert.equal(queries.length,1);assert.match(queries[0],/^SELECT /);
 assert.doesNotMatch(queries[0],/INSERT|UPDATE|DELETE/i);
});
test("public read ports are bounded and cannot access another actor's cart/orders",async()=>{
 const ports=createHermesReadPorts({actorUserId:"alice",catalog:mockCatalog as never,ownedCommerce:false});
 assert.equal("cart" in ports,false);assert.equal("orders" in ports,false);
 const product=await ports.product("p1");assert.equal(product?.variants[0].priceWon,10000);
 assert.equal("description" in (product??{}),false);
 const reviews=await ports.reviews("p1","촉촉");
 assert.equal(reviews?.reviews[0].sourceKind,"SYNTHETIC");
 assert.equal(reviews?.totalMatching,1);
});
test("order facts redact address, payment and sensitive details",()=>{
 const facts=summarizeOrder({id:"order-a",status:"CONFIRMED",created_at:"2026-10-20",total_won:12500,
  cancel_eligible:false,address_snapshot:{recipient:"PRIVATE",phone:"PRIVATE"},payment:{card:"secret"},
  shipping:{status:"IN_TRANSIT",events:[{status:"IN_TRANSIT",occurred_at:"today"}]},
  items:[{product_id:"p1",product_name:"이어폰",quantity:1,unit_price_won:9500,option_values:{}}]} as never);
 assert.equal(facts.orderId,"order-a");
 assert.equal(facts.shippingStatus,"IN_TRANSIT");
 assert.doesNotMatch(JSON.stringify(facts),/PRIVATE|secret|recipient|phone|address_snapshot|payment/);
});
test("review text and sample sizes remain bounded, counts preserve source meaning",()=>{
 const facts=summarizeReviews("p1","보습",{
  reviews:[{id:"a",rating:3,body:"x".repeat(1000),source_kind:"REAL",variant_id:null}],
  total_matching:998
 } as never);
 assert.equal(facts.reviews[0].body.length,320);
 assert.equal(facts.totalMatching,998);
 assert.equal(facts.reviews.length,1);
});
test("model reads cart then chooses product detail and review evidence after real observations",async()=>{
 const events:string[]=[];
 const ports=createHermesReadPorts({actorUserId:"alice",catalog:mockCatalog as never,ownedCommerce:true,
  cart:async()=>({items:[{productId:"p1",variantId:"v1",productName:"에센스",quantity:1,unitPriceWon:10000,availability:"AVAILABLE"}],
   itemCount:1,itemsTotalWon:10000,shippingFeeWon:3000,totalWon:13000,canCheckout:true}),
  orders:async()=>({orders:[],hasMore:false})
 });
 const p=providerFrom((messages)=>{
  const last=messages.at(-1);
  if(last?.role==="user")return {content:null,tool_calls:[{id:"cart",name:"get_cart",arguments:"{}"}]};
  if(last?.name==="get_cart"){events.push("cart");return {content:null,tool_calls:[{id:"product",name:"get_product_detail",arguments:'{"product_id":"p1"}'}]};}
  if(last?.name==="get_product_detail"){events.push("product");return {content:null,tool_calls:[{id:"review",name:"get_product_reviews",arguments:'{"product_id":"p1","query":"촉촉"}'}]};}
  events.push("reviews");return {content:"review checked"};
 });
 const out=await runHermesReadLoop(p,"장바구니에 있는 상품 리뷰는 어때?",plan,[],{
  purchases:async()=>[],search:async()=>{throw Error("do not search")},...ports
 });
 assert.deepEqual(out.calls,["get_cart","get_product_detail","get_product_reviews"]);
 assert.deepEqual(events,["cart","product","reviews"]);
 assert.equal(out.searched,false);
});
test("unknown product and order IDs are rejected before any Commerce call",async()=>{
 let executed=0;
 const ports=createHermesReadPorts({actorUserId:"alice",catalog:mockCatalog as never,ownedCommerce:true,
  cart:async()=>{executed++;throw Error("no");},
  orders:async()=>({orders:[],hasMore:false}),
  order:async()=>{executed++;throw Error("forbidden order")}
 });
 for(const [name,args] of [["get_product_detail",'{"product_id":"made-up"}'],["get_order",'{"order_id":"someone-else"}'],["get_shipping_status",'{"order_id":"someone-else"}']]){
  const got=await runHermesReadLoop(providerFrom(()=>({content:null,tool_calls:[{id:"bad",name,arguments:args}]})),
   "조회",plan,[],{purchases:async()=>[],search:async()=>({products:[]}),...ports});
  assert.deepEqual(got.calls,[],name);
 }
 assert.equal(executed,0);
});
test("model-injected extra keys and parallel Tool calls are rejected",async()=>{
 const ports=createHermesReadPorts({actorUserId:"alice",catalog:mockCatalog as never,ownedCommerce:false});
 for(const args of ['{"product_id":"p1","user_id":"other"}','{"product_id":"p1","query":"%"}']){
  const got=await runHermesReadLoop(providerFrom(()=>({content:null,tool_calls:[{id:"i",name:"get_product_reviews",arguments:args}]})),
   "리뷰",plan,[],{purchases:async()=>[],search:async()=>({products:[]}),...ports});
  assert.deepEqual(got.calls,[]);
 }
});
test("registered actor-owned order IDs support order and shipping follow-ups",async()=>{
 let observed=0;
 const ports=createHermesReadPorts({actorUserId:"alice",catalog:mockCatalog as never,ownedCommerce:true,
  orders:async()=>({orders:[{id:"order-a",created_at:"2026-10-20",item_summary:"이어폰",total_won:30000,
   order_status:"CONFIRMED",shipping_status:"IN_TRANSIT",cancel_eligible:false}],hasMore:false}),
  order:async(id)=>{assert.equal(id,"order-a");observed++;return {id,status:"CONFIRMED",created_at:"2026-10-20",total_won:30000,
   cancel_eligible:false,shipping:{status:"IN_TRANSIT"},items:[],address_snapshot:{phone:"private"}} as never;},
  shipping:async(id)=>{assert.equal(id,"order-a");observed++;return {order_id:id,information:"AVAILABLE",status:"IN_TRANSIT",
   estimated_arrival_at:null,events:[]} as never;}
 });
 const p=providerFrom(messages=>{
  const last=messages.at(-1);
  if(last?.role==="user")return {content:null,tool_calls:[{id:"l",name:"get_orders",arguments:"{}"}]};
  if(last?.name==="get_orders")return {content:null,tool_calls:[{id:"d",name:"get_order",arguments:'{"order_id":"order-a"}'}]};
  if(last?.name==="get_order")return {content:null,tool_calls:[{id:"s",name:"get_shipping_status",arguments:'{"order_id":"order-a"}'}]};
  return {content:"확인"};
 });
 const got=await runHermesReadLoop(p,"내 주문과 배송 상황",plan,[],{purchases:async()=>[],search:async()=>({products:[]}),...ports});
 assert.deepEqual(got.calls,["get_orders","get_order","get_shipping_status"]);
 assert.equal(observed,2);
});
