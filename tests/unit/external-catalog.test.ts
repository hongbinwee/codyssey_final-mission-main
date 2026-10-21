import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../../src/external-catalog.ts';

test('external catalog is opt-in and uses a separate read-only pool without replacing business SQL',async()=>{
 const open=store.openExternalCatalog;
 assert.equal(typeof open,'function');
 assert.equal(await open({},'test_items2'),undefined);
 let options:any,ended=false;const statements:string[]=[];
 const pool={unsafe:async(query:string)=>{statements.push(query);if(query.includes('pg_roles'))return [{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:'on'}];if(query.includes('has_schema_privilege'))return [{database:'toss',ready:true}];return [];},end:async()=>{ended=true;}};
 const result=await open({CATALOG_DATABASE_URL:'postgres://catalog:fixture@catalog.example:5432/toss'},'test_items2',((_url:any,settings:any)=>{options=settings;return pool;}) as never);
 assert.equal(options.connection.default_transaction_read_only,true);assert.notEqual(result!.db,pool);assert.equal(result!.source,'test_items2');
 await result!.catalog.getProduct({product_id:'external-p'});assert.ok(statements.some(q=>q.includes('FROM test_items2.products')));
 assert.ok(statements.every(q=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT)/i.test(q)));
 await result!.close();assert.equal(ended,true);
});
test('external catalog rejects privileged accounts, missing privileges and URL/database ambiguity',async()=>{
 for(const flags of [{rolsuper:true,ready:true},{rolsuper:false,ready:false}]){
  let closed=false;const db={unsafe:async(q:string)=>q.includes('pg_roles')?[{rolsuper:flags.rolsuper,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:'on'}]:[{database:'toss',ready:flags.ready}],end:async()=>{closed=true;}};
  await assert.rejects(()=>store.openExternalCatalog({CATALOG_DATABASE_URL:'postgres://reader:fixture@catalog.example/toss'},'test_items2',(()=>db) as never));assert.equal(closed,true);
 }
 for(const url of ['https://catalog.example/toss','postgres://reader:fixture@catalog.example/','postgres://reader:fixture@catalog.example/toss?search_path=public'])await assert.rejects(()=>store.openExternalCatalog({CATALOG_DATABASE_URL:url},'test_items2'));
 await assert.rejects(()=>store.openExternalCatalog({CATALOG_DATABASE_URL:'postgres://reader:fixture@catalog.example/toss'},'public'));
});
test('explicit approved project role remains read-only and cannot execute mutations through catalog pool',async()=>{
 const calls:string[]=[];const pool={unsafe:async(query:string)=>{calls.push(query);return query.includes('pg_roles')?[{rolsuper:true,rolcreatedb:true,rolcreaterole:true,rolbypassrls:false,read_only:'on'}]:[{database:'toss',ready:true}];},end:async()=>{}};
 const result=await store.openExternalCatalog({CATALOG_DATABASE_URL:'postgres://approved:fixture@catalog.example/toss',CATALOG_DATABASE_APPROVED_ADMIN_ROLE:'approved'},'test_items2',(()=>pool) as never);
 assert.ok(result);await assert.rejects(()=>result!.db.unsafe('DELETE FROM test_items2.products'),/SELECT/);assert.equal(calls.some(q=>q.startsWith('DELETE')),false);
 await assert.rejects(()=>store.openExternalCatalog({CATALOG_DATABASE_URL:'postgres://other:fixture@catalog.example/toss',CATALOG_DATABASE_APPROVED_ADMIN_ROLE:'approved'},'test_items2',(()=>pool) as never),/approved role/);
 const writable={...pool,unsafe:async(q:string)=>q.includes('pg_roles')?[{rolsuper:true,read_only:'off'}]:[{database:'toss',ready:true}]};
 await assert.rejects(()=>store.openExternalCatalog({CATALOG_DATABASE_URL:'postgres://approved:fixture@catalog.example/toss',CATALOG_DATABASE_APPROVED_ADMIN_ROLE:'approved'},'test_items2',(()=>writable) as never),/read-only/);
});
