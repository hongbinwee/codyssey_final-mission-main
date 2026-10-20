import test from "node:test";
import assert from "node:assert/strict";
import {nextTask,ownedTask,retainTask,taskForWishlistSelection,resetTaskRequested} from "../../src/brain/task-state.ts";
import {wishlistIntent,wishlistReply} from "../../src/brain/wishlist-task.ts";
const scope={actorUserId:"owner-1",conversationId:"thread-1",datasetVersion:"v6"};
const list=[
 {productId:"p-a",name:"A",active:true,minPriceWon:10000},
 {productId:"p-b",name:"B",active:true,minPriceWon:20000},
 {productId:"p-c",name:"C",active:true,minPriceWon:30000},
];

test("saved list → social interruption → ordinal reference stays bound to owned displayed order",()=>{
 const ask=wishlistIntent("하트 눌렀던 상품 보여줘");
 assert.deepEqual(ask,{kind:"LIST"});
 const first=wishlistReply(ask!,list);
 const initial=nextTask(scope,"WISHLIST",null,{displayedProductIds:first.view.items.map(x=>x.productId)});
 const resumed=retainTask(initial,scope)!;
 const follow=wishlistIntent("두 번째 상품 살게",taskForWishlistSelection(resumed));
 assert.deepEqual(follow,{kind:"SELECT",index:1});
 const reply=wishlistReply(follow!,[list[2],list[0],list[1]],taskForWishlistSelection(resumed));
 assert.equal(reply.view.selectedProductId,"p-b");
 const state=nextTask(scope,"WISHLIST",resumed,{displayedProductIds:reply.view.items.map(x=>x.productId),selectedProductId:reply.view.selectedProductId});
 assert.equal(state.selectedProductId,"p-b");
 assert.equal(state.revision,2);
});
test("task switch to discovery/order never applies an old wishlist ordinal",()=>{
 const saved=nextTask(scope,"WISHLIST",null,{displayedProductIds:["p-a","p-b"]});
 const search=nextTask(scope,"DISCOVERY",saved,{displayedProductIds:["new-product"]});
 assert.equal(wishlistIntent("두 번째 상품 살게",taskForWishlistSelection(search)),null);
 const order=nextTask(scope,"ORDER",search,{phase:"UNAVAILABLE"});
 assert.equal(taskForWishlistSelection(order),undefined);
});
test("rejected, stale or foreign state cannot resolve selected products",()=>{
 const initial=nextTask(scope,"WISHLIST",null,{displayedProductIds:["p-a","p-b"]});
 const otherUser=ownedTask(initial,{...scope,actorUserId:"other"});
 const oldDataset=ownedTask(initial,{...scope,datasetVersion:"v7"});
 assert.equal(otherUser,null);assert.equal(oldDataset,null);
 assert.equal(wishlistIntent("두 번째 상품 살게",taskForWishlistSelection(otherUser)),null);
 assert.equal(wishlistIntent("두 번째 상품 살게",taskForWishlistSelection(oldDataset)),null);
 const selected=wishlistReply({kind:"SELECT",index:1},[list[0]],taskForWishlistSelection(initial));
 assert.equal(selected.view.selectedProductId,undefined);
});
test("context-free answer only inherits the active task; restart is an explicit reset",()=>{
 const active=nextTask(scope,"WISHLIST",null,{displayedProductIds:["p-a"]});
 assert.deepEqual(wishlistIntent("상관없어요",taskForWishlistSelection(active)),{kind:"LIST"});
 assert.equal(resetTaskRequested("처음부터 다시 시작해줘"),true);
 assert.equal(resetTaskRequested("새 쇼핑 시작"),true);
 assert.equal(resetTaskRequested("기존 추천 조건을 유지해"),false);
 assert.equal(resetTaskRequested("내 주문 기록 삭제해 줘"),false);
});
test("bounded wishlist handoff cannot select an item no longer displayed in the current top 20",()=>{
 const earlier=[{productId:"old",name:"old",active:true,minPriceWon:1234}];
 const prior=nextTask(scope,"WISHLIST",null,{displayedProductIds:["old"]});
 const latest=[...Array.from({length:20},(_,i)=>({productId:"new-"+i,name:"new",active:true,minPriceWon:2000})),earlier[0]];
 const answer=wishlistReply({kind:"SELECT",index:0},latest,taskForWishlistSelection(prior));
 assert.equal(answer.view.selectedProductId,undefined);
 assert.match(answer.text,/표시 범위를 벗어났어요/);
});
