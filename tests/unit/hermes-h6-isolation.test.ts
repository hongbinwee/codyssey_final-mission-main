import test from 'node:test';import assert from 'node:assert/strict';
import {qaCommerceIdentity,qaCommerceEnabled,qaCommerceDatabaseIdentityMatches} from '../../src/qa-commerce.ts';
const env={QA_ENVIRONMENT:'hermes-h6',QA_AUTH_ENABLED:'1',QA_COMMERCE_ENABLED:'1',HERMES_QA_ENABLED:'1',HERMES_AGENT_ENABLED:'1',COMMERCE_CATALOG_SOURCE:'test_items2',DATABASE_URL:'postgres://commerce_hermes_h6:fixture@127.0.0.1:15442/toss_hermes_h6_20261020'};
test('H6 QA has separate fixed cluster, database and roles',()=>{
 assert.deepEqual(qaCommerceIdentity(env),{port:15442,database:'toss_hermes_h6_20261020',role:'commerce_hermes_h6',brainDatabase:'brain_hermes_h6_20261020',brainRole:'brain_hermes_h6'});assert.equal(qaCommerceEnabled(env),true);
});
test('H6 never accepts existing QA targets or reused Brain state',()=>{
 for(const DATABASE_URL of ['postgres://commerce_t2_qa:fixture@127.0.0.1:15440/toss_test_items2_qa_20261019',env.DATABASE_URL.replace(':15442',':15440'),env.DATABASE_URL.replace('127.0.0.1','dgx.invalid')])assert.equal(qaCommerceDatabaseIdentityMatches(env,DATABASE_URL),false);
 for(const changes of [{QA_REUSE_EXISTING_BRAIN:'1'},{HERMES_QA_ENABLED:'0'},{QA_AUTH_ENABLED:'0'},{COMMERCE_CATALOG_SOURCE:'public'}])assert.throws(()=>qaCommerceEnabled({...env,...changes}));
});
import {hermesQaRequestAllowed} from '../../src/qa-commerce.ts';
test('H6 permits only explicit UI cancellation approval and execution, without changing existing QA',()=>{
 for(const suffix of ['approve','execute']){
  const path='/api/orders/qa-order/cancel/'+suffix;
  assert.equal(hermesQaRequestAllowed('POST',path,{...env,HERMES_QA_ENABLED:'1'}),true);
  assert.equal(hermesQaRequestAllowed('POST',path),false);
  assert.equal(hermesQaRequestAllowed('POST',path,{...env,QA_ENVIRONMENT:undefined}),false);
 }
 assert.equal(hermesQaRequestAllowed('DELETE','/api/orders/qa-order',env),false);
});
