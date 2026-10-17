// Explicitly opt-in; do not use the Commerce migration runner or protected DB.
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {parseBrainDatabaseUrl} from "../src/brain/database-isolation.ts";
if(process.env.BRAIN_MIGRATE_APPROVED!=="1")
 throw new Error("BRAIN_MIGRATE_APPROVED=1 required to create AI schema");
const {url,dbName}=parseBrainDatabaseUrl(process.env.BRAIN_DATABASE_URL,process.env.DATABASE_URL);
const db=postgres(url,{max:1,connect_timeout:5});
try{
 const [row]=await db.unsafe<{name:string}[]>("SELECT current_database() AS name");
 if(!row||row.name!==dbName)throw new Error("Brain database identity mismatch");
 // File contains its own BEGIN/COMMIT and never touches Commerce tables.
 await db.unsafe(readFileSync(new URL("../db/brain/001_brain_memory.sql",import.meta.url),"utf8"));
 await db.unsafe(readFileSync(new URL("../db/brain/002_brain_fencing.sql",import.meta.url),"utf8"));
 await db.unsafe(readFileSync(new URL("../db/brain/003_brain_rate_windows.sql",import.meta.url),"utf8"));
 await db.unsafe(readFileSync(new URL("../db/brain/004_brain_attempt_history.sql",import.meta.url),"utf8"));
 console.log("brain schema ready:",dbName);
}finally{await db.end();}
