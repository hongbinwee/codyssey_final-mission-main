import test from "node:test";
import assert from "node:assert/strict";
import {hermesQaRequestAllowed,qaCommerceRequestAllowed} from "../../src/qa-commerce.ts";
import {isCheckoutEnabled} from "../../src/web/commerce-ui.ts";

test("Hermes QA permits checkout and own orders without unlocking sensitive mutations",()=>{
 assert.equal(hermesQaRequestAllowed("POST","/api/checkout/confirm"),true);
 assert.equal(hermesQaRequestAllowed("POST","/api/checkout/quote"),true);
 assert.equal(hermesQaRequestAllowed("GET","/api/orders"),true);
 assert.equal(hermesQaRequestAllowed("GET","/api/orders/order-a"),true);
 assert.equal(hermesQaRequestAllowed("POST","/api/orders/order-a/cancel/execute"),false);
 assert.equal(hermesQaRequestAllowed("POST","/api/session"),false);
 assert.equal(qaCommerceRequestAllowed("POST","/api/checkout/confirm"),false);
});
test("Explicit checkout capability overrides external read-only source only in QA",()=>{
 assert.equal(isCheckoutEnabled({read_only:true,is_simulated:true,checkout_enabled:true}),true);
 assert.equal(isCheckoutEnabled({read_only:true,is_simulated:true,checkout_enabled:false}),false);
 assert.equal(isCheckoutEnabled(null),false);
});
