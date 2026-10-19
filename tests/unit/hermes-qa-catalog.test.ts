import test from 'node:test';
import assert from 'node:assert/strict';
import {createHermesQaCatalog} from '../../src/hermes-qa-catalog.ts';

function fixture(overrides:Record<string,unknown>={}) {
 const product={id:'p-qa',name:'QA product',brand:'brand',category:'fashion',description:'',images:[],active:true,version:1,
  specs:{source_product_id:'source-1',source_platform:'qa-source',catalog_data_version:'v6.1-review-refined'}};
 const variant={variant_id:'v-qa',option_values:{size:'M',color:'black'},effective_specs:{},unit_price_won:10000,stock_qty:10,availability:'AVAILABLE',version:1};
 const saved={id:product.id,name:product.name,brand:product.brand,category:product.category,specs_json:product.specs,...overrides};
 let localVariant={product_id:product.id,version:3,stock_qty:8,unit_price_won:10000,active:true,option_values_json:{color:'black',size:'M'}};
 const writes:string[]=[];
 const q={unsafe:async(query:string,params:unknown[])=>{
  if(query.startsWith('SELECT')&&query.includes('FROM products'))return [saved];
  if(query.startsWith('SELECT product_id,version'))return [localVariant];
  if(query.startsWith('UPDATE product_variants')){writes.push(query);localVariant={...localVariant,version:localVariant.version+1,unit_price_won:Number(params[1]),stock_qty:Math.min(localVariant.stock_qty,Number(params[2])),active:Boolean(params[3])};return [];}
  if(query.startsWith('SELECT version FROM product_variants'))return [{version:localVariant.version}];
  throw Error('unexpected local SQL: '+query);
 }};
 const remote={unsafe:async(query:string)=>{assert.match(query,/^SELECT /);return [{product_id:product.id}];}};
 const local={begin:async(fn:(q:unknown)=>Promise<unknown>)=>fn(q)};
 const bridge=createHermesQaCatalog(remote as never,{getProduct:async()=>({ok:true,data:{product,variants:[variant]}})} as never,local as never);
 return {bridge,product,variant,writes};
}

test('Hermes reuses identical preloaded QA source products without replenishing local stock',async()=>{
 const f=fixture();assert.equal(await f.bridge.ensureVariant('v-qa',1),3);assert.equal(f.writes.length,0);
});
test('Hermes rejects unrelated products that collide with a DGX product ID',async()=>{
 for(const overrides of [{name:'unrelated'}, {specs_json:{}}, {specs_json:{source_product_id:'other',source_platform:'qa-source'}}]){
  const f=fixture(overrides);await assert.rejects(()=>f.bridge.ensureVariant('v-qa',1),/local catalog collision/);assert.equal(f.writes.length,0);
 }
});
test('Hermes price refresh returns local version while keeping simulated stock reductions',async()=>{
 const f=fixture();f.variant.unit_price_won=9000;assert.equal(await f.bridge.ensureVariant('v-qa',1),4);assert.equal(f.writes.length,1);
});
test('Hermes rejects stale DGX versions before any local projection',async()=>{
 const f=fixture();await assert.rejects(()=>f.bridge.ensureVariant('v-qa',9),/external variant version changed/);assert.equal(f.writes.length,0);
});
