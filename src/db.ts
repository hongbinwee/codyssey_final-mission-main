import postgres from "postgres";
import { readFileSync } from "node:fs";
import tls from "node:tls";

// connectDb() 호출 전에는 미초기화 상태. server/scripts가 ensureDevDb() 후에 연다.
export let sql: postgres.Sql;

export function connectDb(url: string, options: {readOnly?: boolean} = {}): postgres.Sql {
  const caFile = process.env.DATABASE_SSL_CA_FILE;
  const readOnly = process.env.AI_LIVE_DEMO === "1" || options.readOnly
    ? { connection: { default_transaction_read_only: true } } : {};
  sql = caFile
    ? postgres(url, {
        ...readOnly,
        ssl: {
          ca: readFileSync(caFile),
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname: string, cert: Parameters<typeof tls.checkServerIdentity>[1]) =>
            tls.checkServerIdentity(new URL(url).hostname, cert),
        },
      })
    : postgres(url, readOnly);
  return sql;
}

// 모든 업무 변경은 이 트랜잭션 헬퍼 하나로 묶는다.
export const tx = <T>(fn: (q: postgres.Sql) => Promise<T>): Promise<T> =>
  sql.begin(fn as never) as Promise<T>;

// 트랜잭션 q와 전역 sql 모두에 맞는 최소 쿼리 인터페이스
export type Q = Pick<postgres.ISql, "unsafe">;

/** SELECT-only role check: never grants privileges or changes DB settings. */
export async function assertServiceRole(db: Q, readOnly: boolean): Promise<void> {
  const rows = await db.unsafe("SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, " +
    "current_setting('transaction_read_only') AS read_only FROM pg_roles WHERE rolname = current_user");
  const row = rows[0];
  if (rows.length !== 1 || !row ||
      ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls"].some(key => row[key] !== false))
    throw new Error("an unprivileged service role is required");
  if (readOnly && row.read_only !== "on") throw new Error("read-only catalog connection required");
}
