import test from "node:test";
import assert from "node:assert/strict";
import {wishlistIntent,wishlistReply} from "../../src/brain/wishlist-task.ts";
const items=[{productId:"a",name:"상품 A",active:true,minPriceWon:10000},{productId:"b",name:"상품 B",active:true,minPriceWon:20000}];
test("wishlist purchase requests stay out of recommendation retrieval",()=>{
 assert.deepEqual(wishlistIntent("내가 찜했던 상품 사고 싶어"),{kind:"LIST"});
 assert.equal(wishlistIntent("찜 해제해 줘"),null);
 assert.equal(wishlistIntent("이어폰 추천해 줘"),null);
});
test("ordinal refers to prior displayed product and re-verifies ownership",()=>{
 const prior=wishlistReply({kind:"LIST"},items).view;
 assert.deepEqual(wishlistIntent("두 번째 상품 살게",prior),{kind:"SELECT",index:1});
 assert.equal(wishlistReply({kind:"SELECT",index:1},[items[1],items[0]],prior).view.selectedProductId,"b");
 assert.equal(wishlistReply({kind:"SELECT",index:1},[items[0]],prior).view.selectedProductId,undefined);
});
test("empty, unavailable and continuation",()=>{
 const prior=wishlistReply({kind:"LIST"},items).view;
 assert.deepEqual(wishlistIntent("상관없어요",prior),{kind:"LIST"});
 assert.equal(wishlistReply({kind:"LIST"},[]).view.items.length,0);
 assert.equal(wishlistReply({kind:"SELECT",index:1},[{...items[1],active:false}],prior).view.selectedProductId,undefined);
});
