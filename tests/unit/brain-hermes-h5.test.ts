import test from "node:test";
import assert from "node:assert/strict";
import {validatedShoppingHandoffs} from "../../src/brain/shopping-handoff.ts";
import {currentDatasetResult} from "../../src/brain/dataset-state.ts";

const ranked=(items:Array<{id:string;variant:string;verified:boolean}>)=>({
 ranked:items.map(x=>({candidate:{productId:x.id,variantId:x.variant,commerceVerified:x.verified},score:1,evidenceCoverage:0})),
 referenceOnly:[{candidate:{productId:"reference",variantId:"vr",commerceVerified:true},reasons:["unverified"]}],
 rejected:[],evaluatedCount:items.length
});
const observe=(tool:string,data:unknown,ok=true)=>({tool,ok,data});

test("ranking handoff only includes Commerce-verified selectable results, never references",()=>{
 const actions=validatedShoppingHandoffs({ranking:ranked([{id:"p1",variant:"v1",verified:true},
  {id:"p2",variant:"v2",verified:false},{id:"p3",variant:"v3",verified:true}]) as never});
 assert.deepEqual(actions.map(x=>x.kind),["PRODUCT_DETAIL","PRODUCT_DETAIL"]);
 assert.deepEqual(actions.map(x=>x.kind==="PRODUCT_DETAIL"?x.productId:null),["p1","p3"]);
 assert.equal(actions.some(x=>x.kind==="CHECKOUT_REVIEW"),false);
});
test("wishlist select action requires active, present and priced item",()=>{
 const items=[{productId:"a",name:"A",active:true,minPriceWon:10000},{productId:"b",name:"B",active:false,minPriceWon:null}];
 const chosen=validatedShoppingHandoffs({wishlist:{kind:"WISHLIST",items,selectedProductId:"a"}});
 assert.deepEqual(chosen,[{kind:"PRODUCT_DETAIL",productId:"a",label:"선택한 상품 옵션 확인"}]);
 assert.deepEqual(validatedShoppingHandoffs({wishlist:{kind:"WISHLIST",items,selectedProductId:"b"}}),[]);
 assert.deepEqual(validatedShoppingHandoffs({wishlist:{kind:"WISHLIST",items,selectedProductId:"forged"}}),[]);
});
test("cart handoffs show checkout review only when server confirms checkout eligibility",()=>{
 const cart=(canCheckout:boolean,items:unknown[])=>[observe("get_cart",{cart:{canCheckout,items}})] as never;
 const available=validatedShoppingHandoffs({observations:cart(true,[{productId:"p1"}])});
 assert.deepEqual(available.map(x=>x.kind),["CART_REVIEW","CHECKOUT_REVIEW"]);
 for(const c of [cart(false,[{productId:"p1"}]),cart(true,[])]){
  const actions=validatedShoppingHandoffs({observations:c});
  assert.deepEqual(actions.map(x=>x.kind),["CART_REVIEW"]);
 }
});
test("order handoffs use only server-read order IDs and never expose sensitive write actions",()=>{
 const obs=[observe("get_orders",{orders:{orders:[
  {orderId:"order-1",cancelEligible:true},{orderId:"order-2",cancelEligible:false},{orderId:"order-3",cancelEligible:true}]}})] as never;
 const actions=validatedShoppingHandoffs({observations:obs});
 assert.deepEqual(actions.map(x=>x.kind),["ORDER_LIST","ORDER_DETAIL","ORDER_DETAIL"]);
 assert.deepEqual(actions.filter(x=>x.kind==="ORDER_DETAIL").map(x=>"orderId" in x?x.orderId:null),["order-1","order-2"]);
 assert.doesNotMatch(JSON.stringify(actions),/cancelEligible|payment|execute|mutation/i);
});
test("shipping detail navigation is provided only for actually observed owned shipping response",()=>{
 const observations=[observe("get_shipping_status",{shipping:{orderId:"owned-order",status:"IN_TRANSIT"}})] as never;
 assert.deepEqual(validatedShoppingHandoffs({observations}),[{kind:"ORDER_DETAIL",orderId:"owned-order",label:"배송·주문 상세 확인"}]);
 assert.deepEqual(validatedShoppingHandoffs({observations:[observe("get_shipping_status",{shipping:null})] as never}),[]);
});
test("explicit cancellation offers owned order-screen handoff, never immediate cancel",()=>{
 assert.deepEqual(validatedShoppingHandoffs({showOrdersForCancellation:true}),
  [{kind:"ORDER_LIST",label:"주문 내역에서 취소 확인"}]);
});
test("repeated observations dedupe routes, invalid IDs rejected, response bounded",()=>{
 const obs=[observe("get_orders",{orders:{orders:[{orderId:"good",status:"PAID"},{orderId:"bad\nvalue",status:"PAID"}]}}),
  observe("get_order",{order:{orderId:"good"}})] as never;
 const actions=validatedShoppingHandoffs({observations:obs});
 assert.deepEqual(actions.map(x=>x.kind),["ORDER_LIST","ORDER_DETAIL"]);
 assert.equal(actions.length,2);
});
test("historical dataset handoff cannot keep pointing to stale product or order",()=>{
 const old={datasetVersion:"old",ranking:ranked([{id:"p",variant:"v",verified:true}]),
  shoppingHandoffs:[{kind:"PRODUCT_DETAIL",productId:"p",variantId:"v",label:"상품 옵션 확인"}],
  conversationId:"c",messageId:"m",trace:{totalMs:1}} as never;
 const current=currentDatasetResult(old,"new");
 assert.deepEqual(current.shoppingHandoffs,[]);
 assert.deepEqual(current.ranking.ranked,[]);
});
