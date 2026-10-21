import test from "node:test";
import assert from "node:assert/strict";
import {qaCommerceEnabled,qaCommerceRequestAllowed,QA_COMMERCE_DATABASE,QA_COMMERCE_ROLE} from "../../src/qa-commerce.ts";
import {isCommerceEnabled,isCheckoutEnabled} from "../../src/web/commerce-ui.ts";
const env={QA_AUTH_ENABLED:"1",QA_COMMERCE_ENABLED:"1",COMMERCE_CATALOG_SOURCE:"test_items",
  DATABASE_URL:`postgres://`+QA_COMMERCE_ROLE+`:fixture@127.0.0.1:15440/`+QA_COMMERCE_DATABASE};

test("test_items2 storage is restricted to its own dedicated role and database",()=>{
 const t2={...env,COMMERCE_CATALOG_SOURCE:"test_items2",DATABASE_URL:"postgres://commerce_t2_qa:fixture@127.0.0.1:15440/toss_test_items2_qa_20261019"};
 assert.equal(qaCommerceEnabled(t2),true);
 assert.throws(()=>qaCommerceEnabled({...t2,DATABASE_URL:env.DATABASE_URL}));
 assert.throws(()=>qaCommerceEnabled({...env,DATABASE_URL:t2.DATABASE_URL}));
});
test("QA Commerce enables only the dedicated authenticated local DB, never the original catalog",()=>{
  assert.equal(qaCommerceEnabled(env),true);
  assert.equal(qaCommerceEnabled({}),false);
  for(const patch of [{QA_AUTH_ENABLED:"0"},{QA_COMMERCE_ENABLED:"true"},{COMMERCE_CATALOG_SOURCE:"public"},
    {DATABASE_URL:env.DATABASE_URL.replace(QA_COMMERCE_DATABASE,"toss_v4_test_items_20261018_w01")},
    {DATABASE_URL:env.DATABASE_URL.replace(QA_COMMERCE_ROLE,"v4_bootstrap")},
    {DATABASE_URL:env.DATABASE_URL.replace("127.0.0.1","remote.example")},
    {DATABASE_URL:env.DATABASE_URL+"?options=-csearch_path%3Dtest_items"}])assert.throws(()=>qaCommerceEnabled({...env,...patch}));
});
test("QA allows only existing cart/wishlist/idempotency routes and keeps purchases blocked",()=>{
  for(const [method,path] of [["GET","/api/cart"],["POST","/api/cart/items"],["PATCH","/api/cart/items/a"],
    ["DELETE","/api/cart/items/a"],["GET","/api/wishlist"],["PUT","/api/wishlist/p"],["GET","/api/actions/a"],["GET","/api/actions"]])
    assert.equal(qaCommerceRequestAllowed(method,path),true,method+path);
  for(const [method,path] of [["POST","/api/cart"],["POST","/api/wishlist/p"],["PUT","/api/cart/items/a"],
    ["POST","/api/checkout/confirm"],["POST","/api/payments"],["GET","/api/orders"],
    ["POST","/api/agent/turn"],["PUT","/api/products/p"],["PATCH","/api/cart/items/a/extra"]])
    assert.equal(qaCommerceRequestAllowed(method,path),false,method+path);
});
test("simulated read-only catalog provenance can support QA storage without checkout",()=>{
  const context={read_only:true,is_simulated:true,cart_enabled:true,wishlist_enabled:true,checkout_enabled:false};
  assert.equal(isCommerceEnabled(context),true);
  assert.equal(isCheckoutEnabled(context),false);
  assert.equal(isCheckoutEnabled({read_only:false,is_simulated:false}),true);
  assert.equal(isCommerceEnabled({read_only:true,is_simulated:true}),false);
});
