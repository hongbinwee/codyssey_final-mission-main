import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extname, isAbsolute, join, normalize, sep } from "node:path";
import { build } from "esbuild";
import { config } from "./config.ts";
import { assertServiceRole, connectDb, sql, type Q } from "./db.ts";
import { ensureDevDb } from "./devdb.ts";
import { contextFromRequest, signSession } from "./session.ts";
import {createQaAuth,readQaAuthFile} from "./qa-auth.ts";
import {qaCommerceEnabled, qaCommerceRequestAllowed, qaCommerceIdentity, qaCommerceConnectedIdentityMatches,hermesQaRequestAllowed} from "./qa-commerce.ts";
import { catalogRequestAllowed, catalogSource, createCatalog } from "./catalog.ts";
import {openExternalCatalog} from './external-catalog.ts';
import {createHermesQaCatalog} from "./hermes-qa-catalog.ts";
import { addToCart, getCart, removeCartItem, updateCartQuantity } from "./cart.ts";
import { getWishlist, parseWishlistPut, setWishlist } from "./wishlist.ts";
import { checkoutQuote, confirmCheckout } from "./checkout.ts";
import { getOrder, getShippingStatus, listOrders } from "./orders.ts";
import {
  approveCancel, checkCancelEligibility, getCancelQuote, requestCancelOrder,
} from "./cancellation.ts";
import { getActionResult } from "./actions.ts";
import { runAgentTurn } from "./agent.ts";
import { getProvider,liveProvider } from "./llm.ts";
import { createAiDemoGate } from "./ai-demo-access.ts";
import {brainMutationAllowed} from "./brain/csrf.ts";
import {
  isolatedEnvTouched,
  planIsolatedConnect,
  verifyOwnedTransaction,
  type IsolatedContract,
} from "../tests/helpers/isolated-db.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/web/app.js": "web/app.js",
  "/web/styles.css": "src/web/styles.css",
};

export function isolatedStartContract(
  env: Record<string, string | undefined> = process.env,
): IsolatedContract | null {
  if (!isolatedEnvTouched(env)) return null;
  const plan = planIsolatedConnect(env);
  if (!plan.ok) throw new Error("isolated API startup 거부: " + plan.reason);
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== plan.contract.dbUrl)
    throw new Error("isolated API startup 거부: DATABASE_URL이 contract와 다름");
  return plan.contract;
}

export async function health(exec: Q = sql, isolated: IsolatedContract | null = null) {
  try {
    if (isolated) {
      // 실제 업무 pool의 한 연결에서 identity와 marker를 함께 확인한다.
      // URL/암호는 응답에 포함하지 않는다.
      if (!("begin" in exec) || typeof exec.begin !== "function")
        throw new Error("isolated health requires a transaction");
      const owned = await verifyOwnedTransaction(
        exec as unknown as Parameters<typeof verifyOwnedTransaction>[0], isolated,
      );
      if (!owned.ok) throw new Error("isolated health identity mismatch");
    } else {
      await exec.unsafe("select 1");
    }
    return { code: 200, body: JSON.stringify({
      ok: true, db: "connected",
      ...(isolated ? { isolated: {
        dbName: isolated.dbName, dbOid: isolated.dbOid,
        dbOwner: isolated.dbOwner, runId: isolated.runId,
      } } : {}),
    }) };
  } catch {
    return { code: 503, body: JSON.stringify({ ok: false, db: "down" }) };
  }
}

const json = (res: ServerResponse, code: number, body: unknown, headers?: Record<string, string>) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 65536) throw new Error("body too large");
  }
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : {};
}

// ToolResult -> HTTP 변환. 비즈니스 판정은 서비스가 내렸고 여기선 매핑만 한다.
const send = (res: ServerResponse, r: { ok: boolean; error?: { code: string } }) => {
  if (r.ok) return json(res, 200, r);
  const code = r.error?.code === "NOT_FOUND" ? 404 : r.error?.code === "VALIDATION" ? 400 : 409;
  json(res, code, r);
};

const reqCtx = (req: IncomingMessage) =>
  contextFromRequest(
    new Request("http://x", {
      headers: {
        cookie: String(req.headers.cookie ?? ""),
        authorization: String(req.headers.authorization ?? ""),
      },
    }),
    config.sessionSecret,
  );

export type ServerStartDeps = {
  openExternalCatalog?:typeof openExternalCatalog;
  webBundlePath?: string;
  localRagSearch?:import("./brain/rag-adapter.ts").LocalRagSearch;
  embedQuery?:(query:string)=>Promise<number[]>;
  env?: Record<string, string | undefined>;
  ensureDevDb?: typeof ensureDevDb;
  connectDb?: typeof connectDb;
  build?: typeof build;
  createServer?: typeof createServer;
};

type BrainRagContract = "brain-rag-v1" | "v4";
type BrainRagConnection = {
  profile?:string;
  endpoint: string;
  mode?:"remote"|"local";
  dataDir?:string;
  pythonPath?:string;
  modelRevision?:string;
  modelCache?:string;
  manifestPath?:string;
  auditId: string;
  token?: string;
  contract: BrainRagContract;
  datasetVersion?: string;
  category: string;
  categories?:string[];
};

export function brainRagConnectionFromEnv(
  env: Record<string, string | undefined>,
): BrainRagConnection | undefined {
  const mode=env.BRAIN_RAG_MODE?.trim()||"remote";
  if(mode!=="remote"&&mode!=="local")throw new Error("BRAIN_RAG_MODE must be remote or local");
  const dataDir=mode==="local"?env.BRAIN_RAG_DATA_DIR:undefined;
  if(mode==="local"&&(!dataDir||!isAbsolute(dataDir)))
    throw new Error("local RAG requires absolute BRAIN_RAG_DATA_DIR");
  const manifestPath=env.BRAIN_RAG_MANIFEST_PATH?.trim();
  if(manifestPath&&(mode!=="local"||!isAbsolute(manifestPath)))
    throw new Error("BRAIN_RAG_MANIFEST_PATH requires local mode and an absolute path");
  // Local mode never connects to this sentinel URL; only an in-process fetcher is allowed.
  const endpoint = mode==="local"?"http://127.0.0.1/v4-local":env.BRAIN_RAG_URL;
  if (!endpoint) return undefined;

  const configuredContract = env.BRAIN_RAG_CONTRACT?.trim() || (mode==="local"?"v4":"legacy");
  const contract = configuredContract === "legacy" ? "brain-rag-v1" : configuredContract;
  if (contract !== "brain-rag-v1" && contract !== "v4")
    throw new Error("BRAIN_RAG_CONTRACT must be v4 or legacy");
  if(mode==="local"&&contract!=="v4")throw new Error("local RAG requires v4 contract");

  const datasetVersion = env.BRAIN_RAG_DATASET_VERSION;
  if (contract === "v4" && !datasetVersion?.trim())
    throw new Error("BRAIN_RAG_DATASET_VERSION is required for v4 RAG");

  const categories=env.BRAIN_RAG_CATEGORIES?.split(",").map(c=>c.trim());
  if(categories&&(!categories.length||categories.some(c=>!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(c))||new Set(categories).size!==categories.length))throw Error("invalid BRAIN_RAG_CATEGORIES");
  return {
    endpoint,
    ...(env.BRAIN_RAG_PROFILE?.trim()?{profile:env.BRAIN_RAG_PROFILE.trim()}:{}),
    ...(mode==="local"?{mode,dataDir,pythonPath:env.BRAIN_RAG_PYTHON,
      modelRevision:env.BRAIN_RAG_MODEL_REVISION,modelCache:env.BRAIN_RAG_MODEL_CACHE,manifestPath}:{}),
    auditId: env.BRAIN_RAG_AUDIT_ID ?? "",
    token: env.BRAIN_RAG_TOKEN,
    contract,
    datasetVersion,
    category: env.BRAIN_RAG_CATEGORY?.trim() || (categories?"":"beauty"),
    ...(categories?{categories}:{}),
  };
}

export async function start(port = config.port, deps: ServerStartDeps = {}) {
  const env = deps.env ?? process.env;
  if(env.QA_AUTH_ENABLED&&!["0","1"].includes(env.QA_AUTH_ENABLED))throw new Error("invalid QA_AUTH_ENABLED");
  const qa=env.QA_AUTH_ENABLED==="1";
  const qaCommerce = qaCommerceEnabled(env);
  let qaAuth:ReturnType<typeof createQaAuth>|undefined;
  if(qa){
    const qaIdentity=qaCommerceIdentity(env);
    const url=new URL(env.DATABASE_URL??"");
    if(!["test_items","test_items2"].includes(env.COMMERCE_CATALOG_SOURCE??"")||env.COMMERCE_CATALOG_SOURCE==="test_items2"&&!qaCommerce||url.hostname!=="127.0.0.1"||url.port!==String(qaIdentity.port)||
      url.pathname!=="/"+(qaCommerce?qaIdentity.database:"toss_v4_test_items_20261018_w01")||decodeURIComponent(url.username)!==(qaCommerce?qaIdentity.role:"commerce_v4_reader")||url.search||
      !env.SESSION_SECRET?.trim()||!env.QA_AUTH_FILE)throw new Error("QA auth requires the approved local read-only catalog");
    if(env.BRAIN_ENABLED==="1"){
      const brainUrl=new URL(env.BRAIN_DATABASE_URL??"");
      if(brainUrl.hostname!=="127.0.0.1"||brainUrl.port!==String(qaIdentity.port)||brainUrl.pathname!=="/"+qaIdentity.brainDatabase||
        decodeURIComponent(brainUrl.username)!==qaIdentity.brainRole||brainUrl.search)
        throw new Error("QA auth requires the approved isolated Brain database");
    }
    const publicOrigin=env.BRAIN_PUBLIC_ORIGIN;
    if(publicOrigin){const u=new URL(publicOrigin);if(u.protocol!=="https:"||u.origin!==publicOrigin)throw new Error("invalid QA public origin");}
    await readQaAuthFile(env.QA_AUTH_FILE);
    qaAuth=createQaAuth({secret:env.SESSION_SECRET,load:()=>readQaAuthFile(env.QA_AUTH_FILE!),secure:!!publicOrigin});
  }
  const requestContext=async(req:IncomingMessage)=>{
    if(!qaAuth)return reqCtx(req);
    const actorUserId=await qaAuth.actor(req.headers.cookie);
    return actorUserId?{actorUserId,origin:"UI" as const}:null;
  };
  const ensure = deps.ensureDevDb ?? ensureDevDb;
  const connect = deps.connectDb ?? connectDb;
  const buildBundle = deps.build ?? build;
  const createHttpServer = deps.createServer ?? createServer;
  const isolated = isolatedStartContract(env);
  const source = catalogSource(env.COMMERCE_CATALOG_SOURCE);
  const catalogReadOnly = source !== "public";
  const ragConnection=env.BRAIN_ENABLED==="1"?brainRagConnectionFromEnv(env):undefined;
  if(ragConnection?.mode==="local"&&!catalogReadOnly)
    throw new Error("local RAG requires the read-only test_items catalog");
  let businessDb: ReturnType<typeof connectDb>;
  if (isolated) {
    const pool = connect(isolated.dbUrl, {readOnly: catalogReadOnly && !qaCommerce});
    businessDb = pool;
    const owned = await verifyOwnedTransaction(
      pool as unknown as Parameters<typeof verifyOwnedTransaction>[0],
      isolated,
    );
    if (!owned.ok) {
      await pool.end();
      throw new Error("isolated API startup 소유권 거부: " + owned.reason);
    }
  } else {
    await ensure();
    businessDb = connect(env.DATABASE_URL!, {readOnly: catalogReadOnly && !qaCommerce});
  }
  if (catalogReadOnly) {
    try { await assertServiceRole(businessDb, !qaCommerce); }
    catch (error) { await businessDb.end(); throw error; }
  }
  if(qa){
    const [identity]=await businessDb.unsafe("SELECT current_database() AS db,current_user AS role,inet_server_port() AS port,current_setting('transaction_read_only') AS read_only");
    if(!identity||!qaCommerceConnectedIdentityMatches(env,identity as unknown as {
      db?:unknown;role?:unknown;port?:unknown;read_only?:unknown;
    },qaCommerce)){
      await businessDb.end();throw new Error("QA database identity mismatch");
    }
  }
  let externalCatalog:Awaited<ReturnType<typeof openExternalCatalog>>;
  try{externalCatalog=await (deps.openExternalCatalog??openExternalCatalog)(env,source);}
  catch(error){await businessDb.end();throw error;}
  const catalog = externalCatalog?.catalog??createCatalog(source, businessDb);
  const hermesQa=env.HERMES_QA_ENABLED==="1";
  if(hermesQa&&(!qaCommerce||source!=="test_items2"||!externalCatalog||!qa))
    throw Error("Hermes purchase requires isolated QA Commerce, QA authentication and external test_items2 catalog");
  const hermesBridge=hermesQa&&externalCatalog?createHermesQaCatalog(externalCatalog.db,externalCatalog.catalog,businessDb):null;
  await buildBundle({
    entryPoints: ["src/web/app.tsx"],
    bundle: true,
    outfile: deps.webBundlePath ?? "web/app.js",
    jsx: "automatic",
    format: "esm",
    logLevel: "silent",
  });
  const provider = getProvider();
  const aiDemo = env.AI_LIVE_DEMO === "1";
  if (aiDemo && env.BRAIN_ENABLED === "1")
    throw new Error("new Brain API cannot run in the existing read-only live demo");
  // Never open AI storage unless explicitly enabled. No edits to Commerce DB.
  const brainRuntime = env.BRAIN_ENABLED === "1"
    ? await (await import("./brain/runtime.ts")).createBrainRuntime({
        brainDatabaseUrl: env.BRAIN_DATABASE_URL ?? "",
        commerceDatabaseUrl: env.DATABASE_URL,
        provider,
        rag: ragConnection,
        catalogSource: source,
        catalog,
        qaEnvironment: env.QA_ENVIRONMENT,
        localRagSearch: deps.localRagSearch,
        embedQuery: deps.embedQuery,
      })
    : null;
  const aiGate = createAiDemoGate();
  const aiCalls = createAiDemoGate(30, 15);

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    try {
      if (p === "/health") {
        const h = await health(sql, isolated);
        res.writeHead(h.code, { "content-type": "application/json" });
        return res.end(h.body);
      }

      // 세션: 테스트 접근 코드 -> 서명 쿠키. 코드는 서버 설정에만 존재한다.
      if (p === "/api/session") {
        if (req.method === "POST") {
          const b = (await body(req)) as { code?: string };
          if(qaAuth){
            if(!brainMutationAllowed(req.headers,env.BRAIN_PUBLIC_ORIGIN))
              return json(res,403,{ok:false,error:{code:"CSRF_REJECTED",message:"허용되지 않은 요청 출처"}});
            const result=await qaAuth.login(b.code,req.socket.remoteAddress??"unknown");
            if(!result.ok)return json(res,result.status,{ok:false,error:{code:result.status===503?"LOGIN_BUSY":result.status===429?"LOGIN_RETRY_LATER":"INVALID_CODE",message:result.status===503?"로그인 요청을 처리 중이에요. 잠시 후 다시 시도해 주세요.":"접근 코드를 확인해 주세요. 잘못된 시도가 누적되면 잠시 후 다시 시도해 주세요."}},
              result.retryAfter?{"retry-after":String(result.retryAfter)}:{});
            const [user]=await businessDb.unsafe("SELECT id,display_name FROM users WHERE id=$1 AND auth_subject=$1",[result.userId]);
            if(!user)return json(res,401,{ok:false,error:{code:"INVALID_CODE",message:"사용자를 찾을 수 없습니다"}});
            return json(res,200,{ok:true,user:{id:user.id,display_name:user.display_name}},{"set-cookie":result.cookie});
          }
          const subject = b.code ? config.testUserCodes[b.code] : undefined;
          if (!subject) return json(res, 401, { ok: false, error: { code: "INVALID_CODE", message: "접근 코드가 올바르지 않습니다" } });
          const [u] = await sql.unsafe("SELECT id, display_name FROM users WHERE auth_subject=$1", [subject]);
          if (!u) return json(res, 401, { ok: false, error: { code: "INVALID_CODE", message: "사용자를 찾을 수 없습니다" } });
          const token = signSession(u.id, config.sessionSecret);
          return json(res, 200, { ok: true, user: { id: u.id, display_name: u.display_name } }, {
            "set-cookie": "session=" + encodeURIComponent(token) + "; HttpOnly; Path=/; SameSite=Lax",
          });
        }
        if (req.method === "GET") {
          const ctx = await requestContext(req);
          if (!ctx) return json(res, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다" } });
          const [u] = await (qaAuth?businessDb:sql).unsafe("SELECT id, display_name FROM users WHERE id=$1", [ctx.actorUserId]);
          if (!u) return json(res, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "세션 만료" } });
          return json(res, 200, { ok: true, user: { id: u.id, display_name: u.display_name } });
        }
        if (req.method === "DELETE") {
          if(qaAuth&&!brainMutationAllowed(req.headers,env.BRAIN_PUBLIC_ORIGIN))
            return json(res,403,{ok:false,error:{code:"CSRF_REJECTED",message:"허용되지 않은 요청 출처"}});
          return json(res, 200, { ok: true }, { "set-cookie": qaAuth?qaAuth.clearCookie():"session=; HttpOnly; Path=/; Max-Age=0" });
        }
      }

      // 정적 자산은 인증 없이 서빙한다.
      const file = req.method === "GET" && !p.startsWith("/api/") ?
        (p === "/web/app.js" && deps.webBundlePath ? deps.webBundlePath : STATIC[p]) : undefined;
      if (file) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
        return res.end(await readFile(file));
      }

      // 생성/테스트 에셋(상품 이미지 등)은 web/assets 아래 파일만 서빙한다.
      if (req.method === "GET" && p.startsWith("/assets/")) {
        const rel = decodeURIComponent(p.slice("/assets/".length));
        const filePath = normalize(join("web", "assets", rel));
        const base = normalize(join("web", "assets")) + sep;
        if (!filePath.startsWith(base) || filePath.endsWith(sep)) {
          res.writeHead(404);
          return res.end("Not found");
        }
        try {
          const bytes = await readFile(filePath);
          res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
          return res.end(bytes);
        } catch {
          res.writeHead(404);
          return res.end("Not found");
        }
      }

      // 아래부터는 인증 필요
      const ctx = await requestContext(req);
      if (!ctx) return json(res, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다" } });
      if (!catalogRequestAllowed(source, req.method ?? "", p) && !(qaCommerce && qaCommerceRequestAllowed(req.method ?? "", p)) && !(hermesBridge && hermesQaRequestAllowed(req.method ?? "",p)))
        return json(res, 403, {ok:false,error:{code:"READ_ONLY_CATALOG",
          message:qaCommerce?"v4 QA에서는 찜·장바구니 저장만 지원하며 주문·결제는 제공하지 않습니다.":"v4 테스트 상품은 시연용 가격·재고이며 장바구니·찜·주문·결제를 제공하지 않습니다."}});
      if(externalCatalog&&!hermesBridge&&req.method!=='GET'&&qaCommerceRequestAllowed(req.method??'',p))
        return json(res,403,{ok:false,error:{code:'CATALOG_WRITES_PAUSED',message:'외부 상품과 로컬 저장소의 정합성 확인 전에는 찜·장바구니 변경을 잠시 지원하지 않습니다.'}});
      if (qaCommerce && (qaCommerceRequestAllowed(req.method ?? "", p)||hermesBridge&&hermesQaRequestAllowed(req.method ?? "",p)) && req.method !== "GET" &&
          !brainMutationAllowed(req.headers, env.BRAIN_PUBLIC_ORIGIN))
        return json(res,403,{ok:false,error:{code:"CSRF_REJECTED",message:"허용되지 않은 요청 출처"}});
      if (p === "/api/catalog/context" && req.method === "GET")
        return json(res,200,{ok:true,data:{source,read_only:catalogReadOnly,is_simulated:catalogReadOnly,
          ...(qaCommerce?{cart_enabled:!externalCatalog||!!hermesBridge,wishlist_enabled:!externalCatalog||!!hermesBridge,checkout_enabled:!!hermesBridge}:{})}});
      if (aiDemo && p.startsWith("/api/") && p !== "/api/agent/turn" &&
          !(req.method === "GET" && /^\/api\/products(?:\/[^/]+(?:\/reviews)?)?$/.test(p)))
        return json(res, 403, { ok: false, error: { code: "READ_ONLY_DEMO", message: "이 AI 시연에서는 상품·리뷰 조회만 제공해요. 일반 쇼핑은 기존 3105 앱을 이용해 주세요." } });

      if (p === "/api/brain" || p.startsWith("/api/brain/")) {
        if (!brainRuntime)
          return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "Brain API is disabled" } });
        const mutating = req.method === "POST" || req.method === "DELETE";
        if(mutating&&!brainMutationAllowed(req.headers,env.BRAIN_PUBLIC_ORIGIN))
          return json(res,403,{ok:false,error:{code:"CSRF_REJECTED",message:"허용되지 않은 요청 출처"}});
        const submitted = req.method === "POST" ? await body(req) : {};
        const reply = await brainRuntime.handle(req.method ?? "", p, ctx.actorUserId, submitted);
        return json(res, reply.status, reply.body);
      }

      if (p === "/api/products" && req.method === "GET") {
        return send(res, await catalog.searchProducts({
          query: url.searchParams.get("query") ?? undefined,
          category: url.searchParams.get("category") ?? undefined,
          max_unit_price_won: url.searchParams.get("max_unit_price_won") ? Number(url.searchParams.get("max_unit_price_won")) : undefined,
          sort: (url.searchParams.get("sort") as "RELEVANCE" | "PRICE_ASC") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));
      }
      let m = p.match(/^\/api\/products\/([^/]+)$/);
      if (m && req.method === "GET") return send(res, await catalog.getProduct({ product_id: decodeURIComponent(m[1]) }));
      m = p.match(/^\/api\/products\/([^/]+)\/reviews$/);
      if (m && req.method === "GET")
        return send(res, await catalog.getReviews({
          product_id: decodeURIComponent(m[1]),
          variant_id: url.searchParams.get("variant_id") ?? undefined,
          query: url.searchParams.get("query") ?? undefined,
          sort: url.searchParams.get("sort") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));

      if (p === "/api/cart" && req.method === "GET") {if(hermesBridge)await hermesBridge.refreshCart(ctx.actorUserId);return send(res, await getCart(ctx));}
      if (p === "/api/cart/items" && req.method === "POST") {
        const b = (await body(req)) as { variant_id?: string; quantity?: number; expected_cart_version?: number; expected_variant_version?: number; idempotency_key?: string };
        if (!b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "idempotency_key가 필요합니다" } });
        const localVariantVersion=hermesBridge?await hermesBridge.ensureVariant(String(b.variant_id??""),Number(b.expected_variant_version)):undefined;
        return send(res, await addToCart({
          variant_id: String(b.variant_id ?? ""),
          quantity: Number(b.quantity),
          expected_cart_version: Number(b.expected_cart_version),
          expected_variant_version: localVariantVersion??Number(b.expected_variant_version),
        }, ctx, "ui-" + b.idempotency_key));
      }

      // 카트 항목 수량 변경·삭제 (W03). 화면과 Agent Tool이 같은 서비스를 쓴다.
      m = p.match(/^\/api\/cart\/items\/([^/]+)$/);
      if (m && req.method === "PATCH") {
        const b = (await body(req)) as { quantity?: number; expected_cart_version?: number; expected_variant_version?: number; idempotency_key?: string };
        if (!b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "idempotency_key가 필요합니다" } });
        return send(res, await updateCartQuantity({
          cart_item_id: decodeURIComponent(m[1]),
          quantity: Number(b.quantity),
          expected_cart_version: Number(b.expected_cart_version),
          expected_variant_version: Number(b.expected_variant_version),
        }, ctx, "ui-" + b.idempotency_key));
      }
      if (m && req.method === "DELETE") {
        const b = (await body(req)) as { expected_cart_version?: number; idempotency_key?: string };
        if (!b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "idempotency_key가 필요합니다" } });
        return send(res, await removeCartItem({
          cart_item_id: decodeURIComponent(m[1]),
          expected_cart_version: Number(b.expected_cart_version),
        }, ctx, "ui-" + b.idempotency_key));
      }

      // 찜 — UI 전용(Agent Tool registry에 없다). GET은 읽기 전용,
      // PUT은 saved 엄격 boolean + idempotency_key 필수. actor는 세션뿐.
      if (p === "/api/wishlist" && req.method === "GET")
        return send(res, await getWishlist(ctx));
      m = p.match(/^\/api\/wishlist\/([^/]+)$/);
      if (m && req.method === "PUT") {
        // strict 검증 — null/array body·비boolean saved·비정상 key 거절.
        // body의 actor 주장 필드는 읽지 않는다(실행 주체는 세션뿐).
        const parsed = parseWishlistPut(await body(req));
        if (!parsed.ok)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: parsed.error } });
        if(hermesBridge)await hermesBridge.ensureProduct(decodeURIComponent(m[1]));
        return send(res, await setWishlist(
          { product_id: decodeURIComponent(m[1]), saved: parsed.saved },
          ctx,
          "ui-" + parsed.idempotency_key,
        ));
      }

      // 실행 요청 결과 조회 (응답 유실 복구용. Agent Tool 아님)
      m = p.match(/^\/api\/actions\/([^/]+)$/);
      if (m && req.method === "GET")
        return send(res, await getActionResult(ctx, { operation_id: decodeURIComponent(m[1]) }));
      if (p === "/api/actions" && req.method === "GET")
        return send(res, await getActionResult(ctx, {
          kind: url.searchParams.get("kind") ?? undefined,
          idempotency_key: url.searchParams.get("idempotency_key") ?? undefined,
        }));

      // W04 견적/확인 — UI 전용. Agent Tool registry에 없으므로 A01이 호출할 수 없다.
      if (p === "/api/checkout/quote" && req.method === "GET") {
        if(hermesBridge)await hermesBridge.refreshCart(ctx.actorUserId);
        return send(res, await checkoutQuote(ctx));
      }
      // 선택 주문/바로 구매 견적 [PMQA-067]. source 필드는 서비스가 검증한다 —
      // 생략·알 수 없는 값은 전체 카트로 추정하지 않고 거절한다.
      if (p === "/api/checkout/quote" && req.method === "POST") {
        const b = (await body(req)) as Record<string, unknown> | null;
        if(hermesBridge){
          if(b?.source==="DIRECT")await hermesBridge.ensureVariant(String(b.variant_id??""));
          else await hermesBridge.refreshCart(ctx.actorUserId);
        }
        return send(res, await checkoutQuote(ctx, {
          kind: b?.source,
          cart_item_ids: b?.cart_item_ids,
          variant_id: b?.variant_id,
          quantity: b?.quantity,
        }));
      }
      if (p === "/api/checkout/confirm" && req.method === "POST") {
        const b = (await body(req)) as { quote_token?: string; idempotency_key?: string };
        if (!b.quote_token || !b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "quote_token과 idempotency_key가 필요합니다" } });
        if(hermesBridge)await hermesBridge.refreshCart(ctx.actorUserId);
        return send(res, await confirmCheckout(b.quote_token, ctx, "ui-" + b.idempotency_key));
      }

      // W05/W06 주문·배송 조회
      if (p === "/api/orders" && req.method === "GET")
        return send(res, await listOrders(ctx, {
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));
      m = p.match(/^\/api\/orders\/([^/]+)\/shipping$/);
      if (m && req.method === "GET")
        return send(res, await getShippingStatus(ctx, decodeURIComponent(m[1])));

      // T3 취소 — 자격/견적은 READ, 승인은 UI 전용, 실행은 화면과 Agent이 같은 로직을 쓴다.
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/eligibility$/);
      if (m && req.method === "GET")
        return send(res, await checkCancelEligibility(ctx, decodeURIComponent(m[1])));
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/quote$/);
      if (m && req.method === "GET")
        return send(res, await getCancelQuote(
          ctx, decodeURIComponent(m[1]), url.searchParams.get("reason_code") ?? "",
        ));
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/approve$/);
      if (m && req.method === "POST") {
        const b = (await body(req)) as { quote_token?: string; reason_code?: string; action_key?: string };
        return send(res, await approveCancel(ctx, decodeURIComponent(m[1]), b));
      }
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/execute$/);
      if (m && req.method === "POST") {
        const b = (await body(req)) as { confirmation_id?: string; reason_code?: string };
        return send(res, await requestCancelOrder(ctx, {
          order_id: decodeURIComponent(m[1]),
          reason_code: b.reason_code,
          confirmation_id: b.confirmation_id,
        }));
      }
      m = p.match(/^\/api\/orders\/([^/]+)$/);
      if (m && req.method === "GET")
        return send(res, await getOrder(ctx, decodeURIComponent(m[1])));

      if (p === "/api/agent/turn" && req.method === "POST") {
        const b = (await body(req)) as { user_message?: string; page_context?: unknown; client_action_id?: string; brain?: "shopping" | "cs" };
        if (!b.user_message || !b.client_action_id)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "user_message와 client_action_id가 필요합니다" } });
        if (aiDemo && (b.brain === "cs" || typeof b.user_message !== "string" || b.user_message.length > 3000))
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "쇼핑 질문을 3,000자 이내로 입력해 주세요." } });
        const ticket = aiDemo ? aiGate.take(ctx.actorUserId) : null;
        if (ticket && !ticket.ok)
          return json(res, 429, { ok: false, error: { code: ticket.code, message: ticket.code === "AI_DEMO_BUSY" ? "진행 중인 AI 응답을 기다려 주세요." : "시연 호출 한도에 도달했어요." } });
        // 이 경로에서 실행되는 Tool의 origin은 AGENT다.
        const agentCtx = { ...ctx, origin: "AGENT" as const };
        try {
          const turnProvider = aiDemo ? {
            name: provider.name,
            async chat(...args: Parameters<typeof provider.chat>) {
              const callTicket = aiCalls.take(ctx.actorUserId);
              if (!callTicket.ok) throw new Error("AI_DEMO_PROVIDER_LIMIT");
              try { return await provider.chat(...args); }
              finally { callTicket.release(); }
            },
          } : provider;
          const result = await runAgentTurn(
            { user_message: b.user_message, page_context: b.page_context as never, client_action_id: b.client_action_id, brain: b.brain },
            agentCtx,
            turnProvider,
          );
          return json(res, 200, { ok: true, data: result });
        } finally { if (ticket?.ok) ticket.release(); }
      }

      res.writeHead(404);
      res.end("Not found");
    } catch {
      // Static asset read failures may happen after writeHead(200). Never send
      // a second header: close the incomplete response instead.
      if (res.headersSent) { res.destroy(); return; }
      json(res, 500, { ok: false, error: { code: "INTERNAL", message: "요청을 처리하지 못했습니다" } });
    }
  });
  const host = env.HOST?.trim();
  await new Promise<void>((resolve) =>
    isolated
      ? server.listen(port, "127.0.0.1", resolve)
      : host
        ? server.listen(port, host, resolve)
        : server.listen(port, resolve),
  );
  if (brainRuntime) server.on("close", () => { void brainRuntime.close(); });
  if (externalCatalog) server.on('close',()=>{void externalCatalog.close();});
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
  console.log("listening on http://localhost:" + config.port);
}
