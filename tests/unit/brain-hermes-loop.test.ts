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
