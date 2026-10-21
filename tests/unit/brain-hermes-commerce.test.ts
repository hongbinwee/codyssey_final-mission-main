import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeCommerceAction,createHermesCommercePorts} from '../../src/brain/hermes-commerce.ts';
import {decideHermesAction,summarizeAgentObservations} from '../../src/brain/hermes-agent-step.ts';
import {hermesToolDefinitions,parseHermesToolArgs} from '../../src/brain/hermes-tools.ts';
import {MemorySaver} from '@langchain/langgraph';
import {createPersistentResearchGraph} from '../../src/brain/graph.ts';
import type {ResearchDeps} from '../../src/brain/read-flow.ts';
const displayed=[{displayIndex:1,productId:'p1',variantId:'v1',name:'더마팩토리 세럼 30ml',commerceVerified:true},
 {displayIndex:2,productId:'p2',variantId:'v2',name:'보습 크림',commerceVerified:true}];
test('Commerce write authority binds explicit current requests to the exact server-displayed target',()=>{
 const wish={productId:'p1',targetText:'1순위',query:''};
 assert.ok(authorizeCommerceAction('save_to_wishlist',wish,'이 중에 1순위 상품 찜해줘',displayed,[]));
 for(const message of ['1순위 상품 추천해줘','1순위 찜하지 말아줘','1순위 찜한 거 보여줘','1순위 찜할 수 있어?','예시: 1순위 찜해줘'])
  assert.equal(authorizeCommerceAction('save_to_wishlist',wish,message,displayed,[]),false,message);
 assert.equal(authorizeCommerceAction('save_to_wishlist',{...wish,productId:'p2'},'1순위 찜해줘',displayed,[]),false);
 assert.equal(authorizeCommerceAction('save_to_wishlist',wish,'1순위 찜해줘',displayed.map(p=>({...p,commerceVerified:false})),[]),false);
 assert.ok(authorizeCommerceAction('add_to_cart',{productId:'p1',targetText:'더마팩토리 세럼 30m',quantity:1},'더마팩토리 세럼 30m 장바구니에 담아줘',displayed,[]));
 assert.equal(authorizeCommerceAction('add_to_cart',{productId:'p1',targetText:'이거',quantity:1},'이거 장바구니에 담아줘',displayed,[]),false);
 assert.equal(authorizeCommerceAction('add_to_cart',{productId:'p1',targetText:'1순위',quantity:4},'1순위 장바구니에 담아줘',displayed,[]),false);
});
function fixture(multiple=false){
 let calls=0,projected=0;const records=new Map<string,any>();
 const product={id:'p1',name:'세럼',active:true};
 const variants=[{variant_id:'v1',availability:'AVAILABLE',version:1,option_values:{size:'30ml'}}];
 if(multiple)variants.push({variant_id:'v2',availability:'AVAILABLE',version:1,option_values:{size:'50ml'}});
 const db={unsafe:async(query:string,params:unknown[])=>query.includes('action_requests')?(records.has(String(params[2]))?[records.get(String(params[2]))]:[]):query.includes('FROM carts')?[{version:7}]:[]};
 const services={wishlist:async(_input:any,_ctx:any,key:string)=>{calls++;return {ok:true,data:{saved:true},operation_id:key};},
  cart:async(input:any,_ctx:any,key:string)=>{calls++;const old=records.get(key);if(!old)records.set(key,{payload_json:input});else assert.deepEqual(input,old.payload_json);return {ok:true,data:{added_quantity:input.quantity},operation_id:key,replayed:!!old};}};
 const ports=createHermesCommercePorts({actorUserId:'tester',conversationId:'conv',clientActionId:'turn',db:db as never,
  bridge:{ensureProduct:async()=>{projected++;},ensureVariant:async()=>{projected++;return 3;}},
  catalog:{getProduct:async()=>({ok:true,data:{product,variants}})} as never,services:services as never});
 return {ports,calls:()=>calls,projected:()=>projected};
}
test('cart writes reuse the original versioned payload and action key on a retry',async()=>{
 const f=fixture(),args={productId:'p1',quantity:1};
 const first=await f.ports.addCart!(args),second=await f.ports.addCart!(args);
 assert.equal(first.status,'SUCCEEDED');assert.equal(second.status,'SUCCEEDED');assert.equal(second.replayed,true);
 assert.equal(first.operationId,second.operationId);assert.equal(f.projected(),1);
});
test('ambiguous options ask for a choice without projecting or writing',async()=>{
 const f=fixture(true);
 assert.equal((await f.ports.addCart!({productId:'p1',quantity:1})).status,'NEEDS_INPUT');
 assert.equal(f.calls(),0);assert.equal(f.projected(),0);
 assert.equal((await f.ports.addCart!({productId:'p1',quantity:1,optionText:'50ml'})).status,'SUCCEEDED');
});
test('write tools are gated to V2 capabilities and strict argument schemas',()=>{
 const tools={purchases:async()=>[],search:async()=>({products:[]}),saveWishlist:async()=>({status:'SUCCEEDED' as const,productId:'p1'})};
 assert.ok(!hermesToolDefinitions(tools,true,false).some(t=>t.function.name==='save_to_wishlist'));
 assert.ok(hermesToolDefinitions(tools,true,true).some(t=>t.function.name==='save_to_wishlist'));
 assert.equal(parseHermesToolArgs('save_to_wishlist',JSON.stringify({product_id:'p1',target_text:'1순위',actorUserId:'other'})),null);
 assert.equal(parseHermesToolArgs('add_to_cart',JSON.stringify({product_id:'p1',target_text:'1순위',quantity:-1})),null);
});
test('Agent may select the displayed ordinal but cannot report an unexecuted write',async()=>{
 const input={provider:{chat:async()=>({content:null,tool_calls:[{id:'w',name:'save_to_wishlist',arguments:'{"product_id":"p1","target_text":"1순위"}'}]})},
  message:'1순위 상품 찜해줘',memories:[],task:null,observations:[],tools:{purchases:async()=>[],search:async()=>({products:[]}),saveWishlist:async()=>({status:'SUCCEEDED' as const,productId:'p1'})},
  offerSearch:true,startedAt:Date.now(),agentPlanning:true,displayedProducts:displayed};
 assert.equal((await decideHermesAction(input)).kind,'CALL');
 assert.equal((await decideHermesAction({...input,message:'1순위 상품 찜하지 말아줘'})).kind,'ASK_USER');
 assert.equal((await decideHermesAction({...input,provider:{chat:async()=>({content:'찜에 저장했어요.'})}})).kind,'FINISH');
 const text=summarizeAgentObservations([{tool:'add_to_cart',ok:false,data:{mutation:{status:'UNKNOWN',productId:'p1',message:'결과를 확인하지 못했어요.'}}}]);
 assert.doesNotMatch(text,/담았어요|저장했어요/);
});
test('real LangGraph dynamically reads and revalidates a product before one actor-bound write; replay adds nothing',async()=>{
 let writes=0,searches=0;
 const deps={agentPlanning:true,conversations:{assertOwned:async()=>{},appendUserMessage:async()=>crypto.randomUUID()},memory:{list:async()=>[]},
  intent:{extract:async()=>{throw Error('no legacy intent');}},retriever:{search:async()=>{searches++;throw Error('no RAG');}},
  wishlist:async()=>[{productId:'p1',name:'세럼',active:true,minPriceWon:12000}],
  hermes:{history:async()=>[],reviewCount:async()=>null,
   provider:{chat:async(messages:any[])=>{
    const tools=messages.filter(m=>m.role==='tool');
    const name=tools.length===0?'get_wishlist':tools.length===1?'get_product_detail':tools.length===2?'save_to_wishlist':'respond_to_user';
    const args=name==='get_wishlist'?{}:name==='get_product_detail'?{product_id:'p1'}:name==='save_to_wishlist'?{product_id:'p1',target_text:'더마팩토리 세럼'}:{text:'done'};
    return {content:null,tool_calls:[{id:'t'+tools.length,name,arguments:JSON.stringify(args)}]};
   }},
   toolPorts:()=>({product:async()=>({productId:'p1',name:'더마팩토리 세럼',active:true,variants:[]})}),
   mutationPorts:(actor:string,conversation:string,action:string)=>({saveWishlist:async()=>{assert.equal(actor,'tester');assert.ok(conversation&&action);writes++;return {status:'SUCCEEDED',productId:'p1',productName:'더마팩토리 세럼'};}}),
  }} as unknown as ResearchDeps;
 const graph=createPersistentResearchGraph(deps,new MemorySaver() as never);
 const request={actorUserId:'tester',conversationId:crypto.randomUUID(),clientActionId:crypto.randomUUID(),requestId:crypto.randomUUID(),userMessage:'더마팩토리 세럼 찜해줘'};
 const result=await graph.invoke(request);assert.match(result.explanation!.text,/찜에 저장했어요/);
 assert.equal(result.trace.hermesWishlistSaved,1);assert.equal(result.trace.hermesCartAdded,0);
 await graph.invoke(request);assert.equal(writes,1);assert.equal(searches,0);assert.equal(result.trace.hermesToolCalls,3);
});
