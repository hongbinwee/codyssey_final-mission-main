import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import type {ResearchDeps} from "../../src/brain/read-flow.ts";
import type {ProductCandidate} from "../../src/brain/contracts.ts";

const request=(userMessage:string,conversationId=crypto.randomUUID())=>({
 actorUserId:"actor-1",conversationId,requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage
});
const base=()=>({conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},
 memory:{list:async()=>[]},intent:{extract:async()=>({query:"무선 이어폰",context:{category:"audio",
  maxTotalWon:50000,requiredConditions:[],currentPreferences:{}}})},
 retriever:{search:async()=>({candidates:[],evidence:[]})}});
const provider={chat:async(messages:Array<{content?:string|null}>)=>{
 const data=JSON.parse(messages.at(-1)?.content??"{}");
 const obs=data.observed_tools??[];
 if(!obs.length)return {content:null,tool_calls:[{id:"read",name:data.user_message.includes("장바구니")?"get_cart":"get_orders",arguments:"{}"}]};
 return {content:"완료"};
}};
test("H5 actual LangGraph cart handoff never mutates cart or executes checkout",async()=>{
 let cartRead=0,retrieval=0;
 const b=base();b.retriever.search=async()=>{retrieval++;return {candidates:[],evidence:[]};};
 const deps={...b,hermes:{provider,history:async()=>[],reviewCount:async()=>null,
  toolPorts:()=>({cart:async()=>{cartRead++;return {items:[{productId:"p1",productName:"이어폰",variantId:"v1",quantity:1,
   unitPriceWon:10000,availability:"AVAILABLE"}],itemCount:1,itemsTotalWon:10000,shippingFeeWon:3000,
   totalWon:13000,canCheckout:true};}})}} as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke(request("내 장바구니 보여줘"));
 assert.equal(cartRead,1);assert.equal(retrieval,0);
 assert.deepEqual(result.shoppingHandoffs?.map(x=>x.kind),["CART_REVIEW","CHECKOUT_REVIEW"]);
 assert.equal(result.explanation?.kind,"CONVERSATION");
 assert.equal(result.ranking.ranked.length,0);
});
test("H5 guarded order cancellation offers owned order screen, never fires model or cancel endpoint",async()=>{
 let modelCalls=0;
 const deps={...base(),hermes:{provider:{chat:async()=>{modelCalls++;throw Error("must not run");}},
  history:async()=>[],reviewCount:async()=>null,toolPorts:()=>({orders:async()=>({orders:[],hasMore:false})})}} as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke(request("내 주문 취소해줘"));
 assert.equal(modelCalls,0);
 assert.deepEqual(result.shoppingHandoffs,[{kind:"ORDER_LIST",label:"주문 내역에서 취소 확인"}]);
 assert.equal(result.ranking.ranked.length,0);
});
test("H5 selected item from authenticated wishlist becomes a product-detail handoff only",async()=>{
 const wishlist=[{productId:"p1",name:"상품1",active:true,minPriceWon:11000},
  {productId:"p2",name:"상품2",active:true,minPriceWon:22000}];
 const deps={...base(),wishlist:async()=>wishlist} as unknown as ResearchDeps;
 const graph=createPersistentResearchGraph(deps,new MemorySaver() as never);
 const conversation=crypto.randomUUID();
 const first=await graph.invoke(request("내가 찜했던 상품 보여줘",conversation));
 assert.equal(first.agentUi?.items.length,2);
 const chosen=await graph.invoke(request("두 번째 상품 장바구니에 담아줘",conversation));
 assert.deepEqual(chosen.shoppingHandoffs,[{kind:"PRODUCT_DETAIL",productId:"p2",label:"선택한 상품 옵션 확인"}]);
 assert.equal(chosen.agentUi?.selectedProductId,"p2");
});
test("H5 actual graph recommendation only issues confirmed product detail, no direct purchase",async()=>{
 let retrieval=0;
 const c:ProductCandidate={productId:"p1",variantId:"v1",productName:"이어폰",unitPriceWon:10000,shippingFeeWon:0,
  rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,conditions:{},facets:{},
  sourceKind:"REAL",commerceVerified:true};
 const deps={...base(),retriever:{search:async()=>{retrieval++;return {candidates:[c],evidence:[]};}},
 hermes:{provider:{chat:async()=>({content:"완료"})},history:async()=>[],reviewCount:async()=>null}} as unknown as ResearchDeps;
 const result=await createPersistentResearchGraph(deps,new MemorySaver() as never).invoke(request("무선 이어폰 추천해줘"));
 assert.equal(retrieval,1);
 assert.deepEqual(result.shoppingHandoffs?.map(x=>x.kind),["PRODUCT_DETAIL"]);
 assert.equal(result.shoppingHandoffs?.[0].kind==="PRODUCT_DETAIL"&&result.shoppingHandoffs?.[0].productId,"p1");
});
