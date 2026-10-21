import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShoppingIntent, createIntentPort } from '../../src/brain/intent.ts';
import { providerIntentModel } from '../../src/brain/provider-intent.ts';
import { rankProducts } from '../../src/brain/personalization.ts';

const good={query:'모니터',maxTotalWon:null,requiredConditions:[],currentPreferences:{price_priority:'performance'}};
test('intent rejects injection-like extra keys, unknown values and false budgets',()=>{
 assert.equal(parseShoppingIntent(JSON.stringify(good)).context.currentPreferences.price_priority,'performance');
 assert.throws(()=>parseShoppingIntent(JSON.stringify({...good,system_override:true})),/unexpected/);
 assert.throws(()=>parseShoppingIntent(JSON.stringify({...good,maxTotalWon:-1})),/budget/);
 assert.throws(()=>parseShoppingIntent(JSON.stringify({...good,currentPreferences:{price_priority:'ADMIN'}})),/preference/);
});
test('planning is tool-free and existing provider contract is reused',async()=>{
 let called=0;
 const provider={chat:async(messages,tools,options)=>{called++;assert.equal(messages[0].role,'system');assert.equal(tools.length,0);assert.ok(options.signal);return {content:JSON.stringify(good)};}};
 const port=createIntentPort(providerIntentModel(provider));
 assert.equal((await port.extract('가성비보다는 성능',[])).query,'모니터');
 assert.equal(called,1);
});
test('model planning tool calls are rejected without side effects',async()=>{
 const port=createIntentPort(providerIntentModel({chat:async()=>({content:JSON.stringify(good),tool_calls:[{id:'1',name:'add_to_cart',arguments:'{}'}]})}));
 await assert.rejects(()=>port.extract('모니터',[]),/invalid planning response/);
});
test('no numeric budget does not remove price dimension for value-oriented candidates',()=>{
 const candidate=(id,price)=>({productId:'p-'+id,variantId:'v-'+id,unitPriceWon:price,shippingFeeWon:5000,rating:4.5,ratingScale:5,
   wholeReviewCount:20,wholeReviewCountVerified:true,conditions:{},facets:{performance:{score:.7,evidenceIds:['perf-'+id]},eye_comfort:{score:.7,evidenceIds:['eye-'+id]},noise:{score:.7,evidenceIds:['noise-'+id]}}});
 const evidence=['perf','eye','noise'].flatMap(prefix=>['a','b'].map(id=>({id:prefix+'-'+id,productId:'p-'+id,variantId:null,kind:'REVIEW',sourceKind:'REAL'})));
 const ranked=rankProducts([candidate('a',100000),candidate('b',400000)],evidence,{maxTotalWon:null,requiredConditions:[],currentPreferences:{price_priority:'value'}},[]);
 assert.equal(ranked.ranked.length,2);assert.equal(ranked.ranked[0].candidate.productId,'p-a');
});
