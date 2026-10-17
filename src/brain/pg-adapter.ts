import type {BrainSqlDatabase,BrainSqlRunner} from './persistent-store.ts';
interface PgDriver {unsafe(sql:string,args:unknown[]):Promise<Record<string,unknown>[]>;begin<T>(fn:(tx:PgDriver)=>Promise<T>):Promise<T>}
/** Wraps the established postgres.js client; call with a SEPARATE AI-owned DB connection. */
export function brainDatabaseFromPostgres(sql:unknown):BrainSqlDatabase{
  const root=sql as PgDriver;
  const runner=(c:PgDriver):BrainSqlRunner=>({
    async query<T extends Record<string,unknown>>(q:string,args:unknown[]):Promise<T[]>{return await c.unsafe(q,args) as T[];}
  });
  return {...runner(root),transaction:<T>(fn:(tx:BrainSqlRunner)=>Promise<T>)=>root.begin(tx=>fn(runner(tx)))};
}
