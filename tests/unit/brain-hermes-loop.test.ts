import test from "node:test";
import assert from "node:assert/strict";
import {runHermesReadLoop} from "../../src/brain/hermes-tools.ts";

const plan={query:"무선 이어폰",maxTotalWon:null,requiredConditions:[],currentPreferences:{},revision:1};

test("Hermes invokes actor-owned purchase and product search tools then stops",async()=>{
 const calls:string[]=[];
 let n=0;
 const provider={chat:async()=>{
  n++;
  if(n===1)return {content:null,tool_calls:[{id:"tc1",name:"get_purchase_history",arguments:"{}"}]};
  if(n===2)return {content:null,tool_calls:[{id:"tc2",name:"search_products",arguments:"{}"}]};
  return {content:"완료"};
 }};
 const value=await runHermesReadLoop(provider,"전에 산 것보다 저렴한 이어폰",plan,[],{
  purchases:async()=>{calls.push("history");return[{productId:"p1",variantId:"v1",productName:"이어폰 A",category:"audio",unitPriceWon:50000,purchasedAt:"2026-01-01"}]},
  search:async()=>{calls.push("search");return{products:[]}}
 });
 assert.deepEqual(calls,["history","search"]);
 assert.deepEqual(value.calls,["get_purchase_history","search_products"]);
 assert.equal(value.searched,true);
});
test("Unknown tools are never dispatched",async()=>{
 const value=await runHermesReadLoop({chat:async()=>({content:null,tool_calls:[{id:"bad",name:"place_order",arguments:"{}"}]})},
  "주문해",plan,[],{purchases:async()=>{throw Error("unexpected");},search:async()=>{throw Error("unexpected");}});
 assert.deepEqual(value.calls,[]);
 assert.equal(value.searched,false);
});

test("model chooses another tool only after inspecting real wishlist output",async()=>{
 const called:string[]=[];
 const provider={chat:async(messages:Array<{role:string;content?:string|null;name?:string}>)=>{
  const last=messages.at(-1);
  if(last?.role==="user")return {content:null,tool_calls:[{id:"wish",name:"get_wishlist",arguments:"{}"}]};
  if(last?.name==="get_wishlist"){
   const saved=JSON.parse(last.content??"{}").saved_products;
   return saved.length?{content:null,tool_calls:[{id:"find",name:"search_products",arguments:"{}"}]}:{content:"찜 목록 없음"};
  }
  if(last?.name==="search_products")return {content:"상품 검증 완료"};
  throw Error("unexpected tool transcript");
 }};
 const result=await runHermesReadLoop(provider,"찜한 상품과 다른 후보 비교",plan,[],{
  purchases:async()=>{throw Error("unexpected purchase history");},
  wishlist:async()=>{called.push("wish");return[{productId:"p1",name:"에센스",active:true,minPriceWon:10000}]},
  search:async()=>{called.push("search");return{products:[{productId:"p1",variantId:"v1",totalPriceWon:10000,reviewCount:10}]}}
 });
 assert.deepEqual(called,["wish","search"]);
 assert.deepEqual(result.calls,["get_wishlist","search_products"]);
 assert.equal(result.wishlist[0]?.productId,"p1");
 assert.equal(result.searched,true);
});
test("empty wishlist makes the model stop, not search",async()=>{
 const result=await runHermesReadLoop({chat:async(messages:Array<{role:string;content?:string|null;name?:string}>)=>
  messages.at(-1)?.role==="user"?{content:null,tool_calls:[{id:"w",name:"get_wishlist",arguments:"{}"}]}:{content:"찜 목록 없음"}},
  "찜 목록 확인",plan,[],{
   purchases:async()=>{throw Error("unexpected");},
   wishlist:async()=>[],
   search:async()=>{throw Error("unexpected search");}
  });
 assert.deepEqual(result.calls,["get_wishlist"]);
 assert.equal(result.searched,false);
 assert.deepEqual(result.wishlist,[]);
});
test("parallel model tool calls must dispatch none",async()=>{
 const result=await runHermesReadLoop({chat:async()=>({content:null,tool_calls:[
  {id:"a",name:"get_purchase_history",arguments:"{}"},
  {id:"b",name:"search_products",arguments:"{}"}
 ]})},"비교해줘",plan,[],{
  purchases:async()=>{throw Error("unexpected");},
  search:async()=>{throw Error("unexpected");}
 });
 assert.deepEqual(result.calls,[]);
});
