import test from 'node:test';import assert from 'node:assert/strict';import {MemorySaver} from '@langchain/langgraph';import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
function setup(memories=[]){let searches=0;const graph=createPersistentResearchGraph({clarifyBeforeSearch:true,conversations:{assertOwned:async()=>{},appendUserMessage:async(_a,_c,action)=>action},memory:{list:async()=>memories},route:async()=>({kind:'SHOPPING_SEARCH',search:true}),intent:{extract:async(message,_m,previous)=>{const query=previous?.query??(message.includes('다이어트식품')?'다이어트식품':message.includes('식품')?'식품':message.includes('이어폰')?'무선 이어폰':'마스크팩');const budget=message.includes('5만원')?50000:previous?.maxTotalWon??null;return {query,queryMode:previous?'KEEP':'SET',budgetMode:message.includes('5만원')?'SET':previous?'KEEP':'CLEAR',context:{maxTotalWon:budget,requiredConditions:message.includes('통화용')?['통화용']:message.includes('선물용')?['선물용']:[],currentPreferences:{}}};}},retriever:{search:async()=>{searches++;return {candidates:[],evidence:[]};}}},new MemorySaver());return {graph,get searches(){return searches;},turn:message=>graph.invoke({actorUserId:'test',conversationId:'c',requestId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),userMessage:message})};}
test('bare named product asks one optional budget question; broad food skip does not repeat its type question',async()=>{
 const named=setup(),first=await named.turn('마스크팩 추천해줘');
 assert.equal(first.explanation.kind,'CLARIFICATION');
 assert.deepEqual(first.explanation.clarification.questions.map(q=>q.key),['budget']);
 assert.equal(named.searches,0);
 const skipped=await named.turn('상관없어요');
 assert.notEqual(skipped.explanation.kind,'CLARIFICATION');
 assert.equal(skipped.shoppingPlan.query,'마스크팩');
 assert.equal(named.searches,1);
 const broad=setup(),broadFirst=await broad.turn('다이어트식품 추천해줘');
 assert.deepEqual(broadFirst.explanation.clarification.questions.map(q=>q.key),['product_type']);
 assert.equal(broad.searches,0);
 const typeSkipped=await broad.turn('상관없어요');
 assert.notEqual(typeSkipped.explanation.kind,'CLARIFICATION');
 assert.equal(broad.searches,1);
 const next=await broad.turn('다른 상품 보기');
 assert.notEqual(next.explanation.kind,'CLARIFICATION');
 assert.equal(broad.searches,2);
});
test('choosing the optional budget keeps the named product plan and retrieves once',async()=>{
 const s=setup(),first=await s.turn('마스크팩 추천해줘');
 assert.deepEqual(first.explanation.clarification.questions.map(q=>q.key),['budget']);
 const answered=await s.turn('예산은 5만원 이하');
 assert.notEqual(answered.explanation.kind,'CLARIFICATION');
 assert.equal(answered.shoppingPlan.query,'마스크팩');
 assert.equal(answered.shoppingPlan.maxTotalWon,50000);
 assert.equal(s.searches,1);
});
test('specific budget and use request goes straight to retrieval',async()=>{const s=setup();await s.turn('5만원 이하 통화용 무선 이어폰 추천');assert.equal(s.searches,1);});
test('relevant price memory skips optional budget; unrelated memory does not',async()=>{
 const price=setup([{userId:'test',key:'price_priority',value:'value',sourceConversationId:'c',sourceMessageId:'m',updatedAt:'2026-10-20T00:00:00.000Z'}]);
 const priceResult=await price.turn('마스크팩 추천해줘');
 assert.notEqual(priceResult.explanation.kind,'CLARIFICATION');
 assert.equal(price.searches,1);
 const eye=setup([{userId:'test',key:'eye_comfort',value:'important',sourceConversationId:'c',sourceMessageId:'m',updatedAt:'2026-10-20T00:00:00.000Z'}]);
 const eyeResult=await eye.turn('마스크팩 추천해줘');
 assert.equal(eyeResult.explanation.kind,'CLARIFICATION');
 assert.deepEqual(eyeResult.explanation.clarification.questions.map(q=>q.key),['budget']);
 assert.equal(eye.searches,0);
 const condition=setup(),conditionResult=await condition.turn('통화용 무선 이어폰 추천해줘');
 assert.notEqual(conditionResult.explanation.kind,'CLARIFICATION');
 assert.equal(condition.searches,1);
 const purpose=setup(),purposeResult=await purpose.turn('선물용 마스크팩 추천해줘');
 assert.notEqual(purposeResult.explanation.kind,'CLARIFICATION');
 assert.equal(purpose.searches,1);
});
test('product type free input keeps its budget; condition change asks only the budget without retrieval',async()=>{const s=setup(),first=await s.turn('5만원 이하 다이어트식품 추천해줘');assert.deepEqual(first.explanation.clarification.questions.map(q=>q.key),['product_type']);assert.equal(s.searches,0);const type=await s.turn('두유쉐이크로');assert.equal(type.shoppingPlan.query,'두유쉐이크');assert.equal(type.shoppingPlan.maxTotalWon,50000);assert.equal(s.searches,1);const change=await s.turn('조건 바꾸기');assert.equal(change.explanation.kind,'CLARIFICATION');assert.deepEqual(change.explanation.clarification.questions.map(q=>q.key),['budget']);assert.equal(change.shoppingPlan.maxTotalWon,50000);assert.equal(s.searches,1);});

test('checkpoint replay preserves a pending broad-product question without retrieval',async()=>{const s=setup();const request={actorUserId:'test',conversationId:'c',requestId:'r',clientActionId:'same-action',userMessage:'다이어트식품 추천해줘'};const first=await s.graph.invoke(request),replay=await s.graph.invoke(request);assert.deepEqual(replay.explanation,first.explanation);assert.equal(s.searches,0);const saved=await s.graph.getOwnedState('test','c');assert.deepEqual(saved.values.researchResult.shoppingPlan.interview.pending,['product_type']);});

test('product-type skip cannot erase an existing explicit budget',async()=>{const s=setup();const first=await s.turn('5만원 이하 식품 추천해줘');assert.equal(first.shoppingPlan.maxTotalWon,50000);assert.equal(s.searches,0);const next=await s.turn('상관없어요');assert.equal(next.shoppingPlan.maxTotalWon,50000);assert.equal(s.searches,1);});
