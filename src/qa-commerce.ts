// Explicitly scoped QA cart/wishlist capability. Catalog provenance stays simulated.
export const QA_COMMERCE_DATABASE = "toss_v4_qa_commerce_20261019";
export const QA_COMMERCE_ROLE = "commerce_v4_qa";

const SYSTEM_PROMPT_IDENTITY = {
  port: 15441,
  database: "toss_prompt_qa_20261019",
  role: "commerce_prompt_qa",
  brainDatabase: "brain_prompt_qa_20261019",
  brainRole: "brain_prompt_qa",
} as const;

export function qaCommerceIdentity(env:Record<string,string|undefined>) {
  const profile=env.QA_ENVIRONMENT;
  if(profile!==undefined&&profile!=="system-prompt")throw Error("invalid QA_ENVIRONMENT");
  if(profile==="system-prompt"){
    if(env.COMMERCE_CATALOG_SOURCE!=="test_items2")throw Error("invalid system-prompt QA profile");
    return SYSTEM_PROMPT_IDENTITY;
  }
  return {
    port:15440,
    database:env.COMMERCE_CATALOG_SOURCE==="test_items2"?"toss_test_items2_qa_20261019":QA_COMMERCE_DATABASE,
    role:env.COMMERCE_CATALOG_SOURCE==="test_items2"?"commerce_t2_qa":QA_COMMERCE_ROLE,
    brainDatabase:env.COMMERCE_CATALOG_SOURCE==="test_items2"
      ?env.QA_REUSE_EXISTING_BRAIN==="1"?"brain_shopping_v4_20261018_w01":"brain_test_items2_qa_20261019"
      :"brain_shopping_v4_20261018_w01",
    brainRole:env.COMMERCE_CATALOG_SOURCE==="test_items2"
      ?env.QA_REUSE_EXISTING_BRAIN==="1"?"brain_v4_service":"brain_t2_qa"
      :"brain_v4_service",
  };
}

export function qaCommerceDatabaseIdentityMatches(
  env:Record<string,string|undefined>,databaseUrl:string|undefined,
):boolean {
  if(!["test_items","test_items2"].includes(env.COMMERCE_CATALOG_SOURCE??""))return false;
  const identity=qaCommerceIdentity(env);
  let url:URL;
  try{url=new URL(databaseUrl??"");}catch{return false;}
  return url.hostname==="127.0.0.1"&&url.port===String(identity.port)&&
    url.pathname==="/"+identity.database&&decodeURIComponent(url.username)===identity.role&&!url.search;
}

export function qaCommerceConnectedIdentityMatches(
  env:Record<string,string|undefined>,
  connection:{db?:unknown;role?:unknown;port?:unknown;read_only?:unknown},
  commerceEnabled:boolean,
):boolean {
  const identity=qaCommerceIdentity(env);
  return connection.db===(commerceEnabled?identity.database:"toss_v4_test_items_20261018_w01")&&
    connection.role===(commerceEnabled?identity.role:"commerce_v4_reader")&&
    Number(connection.port)===identity.port&&connection.read_only===(commerceEnabled?"off":"on");
}

export function qaCommerceEnabled(env: Record<string, string | undefined>): boolean {
  if(env.QA_ENVIRONMENT!=="system-prompt"&&(env.QA_COMMERCE_ENABLED===undefined||env.QA_COMMERCE_ENABLED==="0"))return false;
  const identity=qaCommerceIdentity(env);
  if(env.QA_ENVIRONMENT==="system-prompt"&&
      (env.QA_AUTH_ENABLED!=="1"||env.QA_COMMERCE_ENABLED!=="1"||
       env.COMMERCE_CATALOG_SOURCE!=="test_items2"||env.QA_REUSE_EXISTING_BRAIN!==undefined))
    throw Error("invalid system-prompt QA profile");
  if (env.QA_COMMERCE_ENABLED === undefined || env.QA_COMMERCE_ENABLED === "0") return false;
  if (env.QA_COMMERCE_ENABLED !== "1" || env.QA_AUTH_ENABLED !== "1" ||
      !["test_items", "test_items2"].includes(env.COMMERCE_CATALOG_SOURCE??""))
    throw Error("invalid QA Commerce configuration");
  if(!qaCommerceDatabaseIdentityMatches(env,env.DATABASE_URL))
    throw Error(`QA Commerce requires the dedicated local database, role, and port ${identity.port}`);
  return true;
}

export function qaCommerceRequestAllowed(method: string, path: string): boolean {
  return (method === "GET" && ["/api/cart", "/api/wishlist", "/api/actions"].includes(path)) ||
    (method === "GET" && /^\/api\/actions\/[^/]+$/.test(path)) ||
    (method === "POST" && path === "/api/cart/items") ||
    (["PATCH", "DELETE"].includes(method) && /^\/api\/cart\/items\/[^/]+$/.test(path)) ||
    (method === "PUT" && /^\/api\/wishlist\/[^/]+$/.test(path));
}

/** Only enabled by HERMES_QA_ENABLED on an already verified isolated QA database. */
export function hermesQaRequestAllowed(method:string,path:string):boolean {
 return (method==="GET"&&(/^\/api\/orders(?:\/[^/]+(?:\/shipping|\/cancel\/(?:eligibility|quote))?)?$/.test(path)||
   path==="/api/checkout/quote"))||
  (method==="POST"&&(path==="/api/checkout/quote"||path==="/api/checkout/confirm"));
}
