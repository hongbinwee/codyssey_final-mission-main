/** Read-only startup guard. Never initializes or migrates any database. */
export interface SchemaProbe {
  unsafe<T extends Record<string,unknown>[]>(sql:string,args?:unknown[]):Promise<T>;
}
export async function requireBrainV9Schema(db:SchemaProbe,expectedDbName:string):Promise<void>{
  const rows=await db.unsafe<Array<{db_name:string;conversations:string|null;messages:string|null;
    preferences:string|null;fence:string|null;receipts:string|null;rateWindows:string|null;attempts:string|null}>>(
    `SELECT current_database() AS db_name,
       to_regclass('shopping_brain.conversations')::text AS conversations,
       to_regclass('shopping_brain.messages')::text AS messages,
       to_regclass('shopping_brain.user_preferences')::text AS preferences,
       to_regclass('shopping_brain.turn_fence')::text AS fence,
       to_regclass('shopping_brain.turn_receipts')::text AS receipts,
       to_regclass('shopping_brain.rate_limit_windows')::text AS "rateWindows",
       to_regclass('shopping_brain.turn_attempts')::text AS attempts`);
  const row=rows[0];
  if(rows.length!==1||row.db_name!==expectedDbName||
     !row.conversations||!row.messages||!row.preferences||!row.fence||!row.receipts||!row.rateWindows||!row.attempts)
    throw Error("Brain v9 AI database migration required");
  // Fail closed when an older or incompatible schema reuses the same table names.
  const columns=await db.unsafe<Array<{table_name:string;column_name:string;data_type:string}>>(
    `SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='shopping_brain'
      AND ((table_name='turn_fence' AND column_name IN ('generation','active_attempt_id','published_action_id'))
        OR (table_name='rate_limit_windows' AND column_name IN ('scope','subject_digest','window_start','hits'))
        OR (table_name='turn_attempts' AND column_name IN ('attempt_id','conversation_id','generation','status'))
        OR (table_name='turn_receipts' AND column_name IN ('input_digest','generation',
          'attempt_id','status','checkpoint_thread_id','completed_result')))`);
  const expected=[
    ["turn_attempts","attempt_id","uuid"],
    ["turn_attempts","conversation_id","uuid"],
    ["turn_attempts","generation","bigint"],
    ["turn_attempts","status","text"],
    ["rate_limit_windows","scope","text"],
    ["rate_limit_windows","subject_digest","text"],
    ["rate_limit_windows","window_start","timestamp with time zone"],
    ["rate_limit_windows","hits","integer"],
    ["turn_fence","generation","bigint"],
    ["turn_fence","active_attempt_id","uuid"],
    ["turn_fence","published_action_id","text"],
    ["turn_receipts","input_digest","text"],
    ["turn_receipts","generation","bigint"],
    ["turn_receipts","attempt_id","uuid"],
    ["turn_receipts","status","text"],
    ["turn_receipts","checkpoint_thread_id","uuid"],
    ["turn_receipts","completed_result","jsonb"]
  ];
  if(!expected.every(([table,col,kind])=>columns.some(row=>
      row.table_name===table&&row.column_name===col&&row.data_type===kind)))
    throw Error("Brain v9 AI database schema incompatible");
}
