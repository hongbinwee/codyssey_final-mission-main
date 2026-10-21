import test from "node:test";
import assert from "node:assert/strict";
import {qaCommerceEnabled,qaCommerceIdentity,QA_COMMERCE_DATABASE,QA_COMMERCE_ROLE} from "../../src/qa-commerce.ts";

const systemPromptEnv={
  QA_ENVIRONMENT:"system-prompt",
  QA_AUTH_ENABLED:"1",
  QA_COMMERCE_ENABLED:"1",
  COMMERCE_CATALOG_SOURCE:"test_items2",
  DATABASE_URL:"postgres://commerce_prompt_qa:fixture@127.0.0.1:15441/toss_prompt_qa_20261019",
  BRAIN_ENABLED:"1",
  BRAIN_DATABASE_URL:"postgres://brain_prompt_qa:fixture@127.0.0.1:15441/brain_prompt_qa_20261019",
};

test("system-prompt QA uses its dedicated Commerce and Brain identities on port 15441",()=>{
  assert.deepEqual(qaCommerceIdentity(systemPromptEnv),{
    port:15441,
    database:"toss_prompt_qa_20261019",
    role:"commerce_prompt_qa",
    brainDatabase:"brain_prompt_qa_20261019",
    brainRole:"brain_prompt_qa",
  });
  assert.equal(qaCommerceEnabled(systemPromptEnv),true);
});

test("system-prompt rejects unknown, incomplete, reused, or test_items profiles",()=>{
  assert.throws(()=>qaCommerceIdentity({...systemPromptEnv,QA_ENVIRONMENT:"staging"}),/QA_ENVIRONMENT/);
  assert.throws(()=>qaCommerceEnabled({...systemPromptEnv,COMMERCE_CATALOG_SOURCE:"test_items"}),/system-prompt/);
  assert.throws(()=>qaCommerceEnabled({...systemPromptEnv,QA_AUTH_ENABLED:"0"}),/system-prompt/);
  assert.throws(()=>qaCommerceEnabled({...systemPromptEnv,QA_COMMERCE_ENABLED:"0"}),/system-prompt/);
  assert.throws(()=>qaCommerceEnabled({...systemPromptEnv,QA_REUSE_EXISTING_BRAIN:"1"}),/system-prompt/);
});

test("default QA commerce identity and endpoint stay on port 15440",()=>{
  const env={QA_AUTH_ENABLED:"1",QA_COMMERCE_ENABLED:"1",COMMERCE_CATALOG_SOURCE:"test_items",
    DATABASE_URL:`postgres://${QA_COMMERCE_ROLE}:fixture@127.0.0.1:15440/${QA_COMMERCE_DATABASE}`};
  assert.deepEqual(qaCommerceIdentity(env),{
    port:15440,
    database:QA_COMMERCE_DATABASE,
    role:QA_COMMERCE_ROLE,
    brainDatabase:"brain_shopping_v4_20261018_w01",
    brainRole:"brain_v4_service",
  });
  assert.equal(qaCommerceEnabled(env),true);
});

test("system-prompt rejects Commerce URLs on the default QA port",()=>{
  assert.throws(()=>qaCommerceEnabled({...systemPromptEnv,
    DATABASE_URL:systemPromptEnv.DATABASE_URL.replace(":15441/",":15440/")}));
});

test("connected Commerce identity must match profile port, database, role, and read-only mode",async()=>{
  const commerce=await import("../../src/qa-commerce.ts") as typeof import("../../src/qa-commerce.ts") & {
    qaCommerceConnectedIdentityMatches?:(env:Record<string,string|undefined>,
      connection:{db?:unknown;role?:unknown;port?:unknown;read_only?:unknown},commerceEnabled:boolean)=>boolean;
  };
  const actual={db:"toss_prompt_qa_20261019",role:"commerce_prompt_qa",port:15441,read_only:"off"};
  assert.equal(commerce.qaCommerceConnectedIdentityMatches?.(systemPromptEnv,actual,true),true);
  for(const patch of [{port:15440},{db:"toss_test_items2_qa_20261019"},{role:"commerce_t2_qa"},{read_only:"on"}])
    assert.equal(commerce.qaCommerceConnectedIdentityMatches?.(systemPromptEnv,{...actual,...patch},true),false);
  const defaultEnv={QA_AUTH_ENABLED:"1",QA_COMMERCE_ENABLED:"1",COMMERCE_CATALOG_SOURCE:"test_items",
    DATABASE_URL:`postgres://${QA_COMMERCE_ROLE}:fixture@127.0.0.1:15440/${QA_COMMERCE_DATABASE}`};
  assert.equal(commerce.qaCommerceConnectedIdentityMatches?.(defaultEnv,
    {db:QA_COMMERCE_DATABASE,role:QA_COMMERCE_ROLE,port:15440,read_only:"off"},true),true);
});

test("Brain commerce-activity gating follows the explicitly supplied QA profile port",async()=>{
  const runtime=await import("../../src/brain/runtime.ts") as typeof import("../../src/brain/runtime.ts") & {
    qaCommerceActivityAllowed?:(options:{catalogSource?:string;commerceDatabaseUrl?:string;qaEnvironment?:string})=>boolean;
  };
  const options={catalogSource:"test_items2",qaEnvironment:"system-prompt"};
  assert.equal(runtime.qaCommerceActivityAllowed?.({...options,
    commerceDatabaseUrl:systemPromptEnv.DATABASE_URL}),true);
  assert.equal(runtime.qaCommerceActivityAllowed?.({...options,
    commerceDatabaseUrl:systemPromptEnv.DATABASE_URL.replace(":15441/",":15440/")}),false);
});


test("disabled QA does not interpret QA profile names in the ordinary runtime",async()=>{
 assert.equal(qaCommerceEnabled({QA_ENVIRONMENT:"staging"}),false);
 assert.equal(qaCommerceEnabled({QA_ENVIRONMENT:"staging",QA_COMMERCE_ENABLED:"0"}),false);
 const {qaCommerceActivityAllowed}=await import("../../src/brain/runtime.ts");
 assert.equal(qaCommerceActivityAllowed({catalogSource:"public",qaEnvironment:"staging"}),false);
});
