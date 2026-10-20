import test from "node:test";
import assert from "node:assert/strict";
import {nextTask,ownedTask,retainTask,taskForWishlistSelection,type TaskScope} from "../../src/brain/task-state.ts";

const owner:TaskScope={actorUserId:"alice",conversationId:"conversation-a",datasetVersion:"v6"};
const begin=()=>nextTask(owner,"WISHLIST",null,{displayedProductIds:["p-2","p-1","p-3"]});

test("server-issued task preserves order, selected entity and increases revision",()=>{
 const initial=begin();
 assert.deepEqual(initial.displayedProductIds,["p-2","p-1","p-3"]);
 assert.equal(initial.revision,1);
 const selection=nextTask(owner,"WISHLIST",initial,{displayedProductIds:["p-2","p-1","p-3"],selectedProductId:"p-1"});
 assert.equal(selection.selectedProductId,"p-1");assert.equal(selection.revision,2);
 assert.equal(taskForWishlistSelection(selection)?.items[1].productId,"p-1");
});
test("task identity never grants data from another user, conversation or dataset",()=>{
 const task=begin();
 assert.equal(ownedTask(task,{...owner,actorUserId:"bob"}),null);
 assert.equal(ownedTask(task,{...owner,conversationId:"conversation-b"}),null);
 assert.equal(ownedTask(task,{...owner,datasetVersion:"v7"}),null);
 assert.equal(retainTask(task,{...owner,datasetVersion:"v7"}),undefined);
});
test("task switch clears stale selected entity, list, and question",()=>{
 const selected=nextTask(owner,"WISHLIST",begin(),{displayedProductIds:["p-2","p-1"],selectedProductId:"p-1"});
 const newQuery=nextTask(owner,"DISCOVERY",selected,{displayedProductIds:["item-new"]});
 assert.deepEqual(newQuery.displayedProductIds,["item-new"]);
 assert.equal(newQuery.selectedProductId,undefined);assert.equal(newQuery.pendingQuestion,undefined);
 assert.equal(taskForWishlistSelection(newQuery),undefined);
 assert.equal(newQuery.revision,3);
});
test("an interruption keeps the current task until a new task is started",()=>{
 const old=begin(),paused=retainTask(old,owner)!;
 assert.equal(paused.kind,"WISHLIST");
 assert.deepEqual(taskForWishlistSelection(paused)?.items.map(x=>x.productId),["p-2","p-1","p-3"]);
 assert.notStrictEqual(paused.displayedProductIds,old.displayedProductIds);
});
test("question state is scoped and cleared after the answer",()=>{
 const draft=nextTask(owner,"DISCOVERY",null,{phase:"AWAITING_INPUT",pendingQuestion:"product_type"});
 assert.equal(draft.pendingQuestion,"product_type");
 assert.equal(taskForWishlistSelection(draft),undefined);
 const resolved=nextTask(owner,"DISCOVERY",draft,{displayedProductIds:["p4"]});
 assert.equal(resolved.phase,"ACTIVE");
 assert.equal(resolved.pendingQuestion,undefined);
 assert.equal(resolved.revision,2);
});
test("unavailable order is never treated as an active shopping selection",()=>{
 const old=begin();
 const blocked=nextTask(owner,"ORDER",old,{phase:"UNAVAILABLE"});
 assert.deepEqual(blocked.displayedProductIds,[]);
 assert.equal(taskForWishlistSelection(blocked),undefined);
});
test("reject malformed checkpoints and do not trust arbitrary LLM task ids",()=>{
 const task=begin();
 for(const corrupt of [
  {...task,actorUserId:"bob"}, {...task,schemaVersion:3},
  {...task,revision:0},{...task,displayedProductIds:["p-1","p-1"]},
  {...task,displayedProductIds:["p-1"],selectedProductId:"p-2"},
  {...task,phase:"AWAITING_INPUT"},
  {...task,phase:"ACTIVE",pendingQuestion:"budget"},
  {...task,displayedProductIds:new Array(21).fill("x")},
 ]){
  assert.equal(ownedTask(corrupt,owner),null);
 }
 const cleaned=nextTask(owner,"WISHLIST",task,{displayedProductIds:["p1","p1","p2"],selectedProductId:"forged"});
 assert.deepEqual(cleaned.displayedProductIds,["p1","p2"]);
 assert.equal(cleaned.selectedProductId,undefined);
});

test("cart task is scoped and cannot inherit previous wishlist selections",()=>{
 const old=begin();const cart=nextTask(owner,"CART",old);
 assert.equal(cart.kind,"CART");assert.deepEqual(cart.displayedProductIds,[]);
 assert.equal(taskForWishlistSelection(cart),undefined);
 assert.equal(ownedTask(cart,owner)?.kind,"CART");
});
