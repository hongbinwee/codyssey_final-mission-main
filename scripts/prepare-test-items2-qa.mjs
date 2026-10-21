// One-shot, fail-closed preparation of the explicitly isolated test_items2 QA databases.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import postgres from 'postgres';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import {fingerprintRows,normalizeV4ReviewTimestamps} from './import-v4-local.ts';
import {BRAIN_SERVICE_RIGHTS} from '../src/brain/runtime.ts';
const root='C:/문서/codyssey_final',data=root+'/.local-data/test-items2-20261019';
const folder=resolve('.local-data/runtime'),commerceName='toss_test_items2_qa_20261019',brainName='brain_test_items2_qa_20261019';
const commerceRole='commerce_t2_qa',brainRole='brain_t2_qa';
const original=root+'/.local-data/v4-20261018-w01-20261018-190515-6435eb82';
const parse=t=>Object.fromEntries(t.split(/\r?\n/).flatMap(line=>{const m=line.match(/^([A-Z_]+)=(.*)$/);return m?[[m[1],m[2].replace(/^["']|["']$/g,'')]]:[]}));
const vars=parse(await readFile(original+'/.secrets/local-v4.env','utf8'));
const url=new URL(vars.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.port!=='15440'||decodeURIComponent(url.username)!=='v4_bootstrap')throw Error('unapproved local owner');
url.pathname='/postgres';const admin=postgres(url.toString(),{max:1,onnotice:()=>{}});let shop,brain;
try{
 const [identity]=await admin`SELECT current_user AS role,current_setting('data_directory') AS dir,inet_server_port() AS port`;
 if(identity.role!=='v4_bootstrap'||Number(identity.port)!==15440||identity.dir!=='C:/Users/proje/AppData/Local/Temp/codex-v4-pg18-e0239a1913d94e84a2775ef54a00f7c7/pgdata-ascii')throw Error('local cluster ownership mismatch');
 if((await admin`SELECT datname FROM pg_database WHERE datname IN (${commerceName},${brainName})`).length||
    (await admin`SELECT rolname FROM pg_roles WHERE rolname IN (${commerceRole},${brainRole})`).length)throw Error('isolated target exists; never overwrite');
 const integrity=JSON.parse(await readFile(data+'/local-integrity-results.json','utf8'));
 if(integrity.status!=='PASS'||integrity.products!==1500||integrity.chunks!==114106)throw Error('dataset must pass local integrity first');
 const rows=async t=>(await readFile(data+'/database_exports/toss/test_items2/'+t+'.jsonl','utf8')).trim().split(/\r?\n/).map(JSON.parse);
 const tables={products:await rows('products'),product_variants:await rows('product_variants'),reviews:await rows('reviews')};
 const auth=JSON.parse(await readFile(root+'/.worktrees/W01/.secrets/qa-auth-20261018-e69e651e8422458c951d09f58b7a81c7/qa-auth-records.json','utf8'));
 if(auth.records.length!==6||auth.records.some(r=>!/^tester_0[1-6]$/.test(r.userId)))throw Error('QA identity mismatch');
 for(const name of [commerceName,brainName])await admin.unsafe('CREATE DATABASE '+name);
 url.pathname='/'+commerceName;shop=postgres(url.toString(),{max:1,onnotice:()=>{}});
 for(const file of ['001_catalog_cart_actions.sql','002_orders_payments_shipments.sql','003_cancel_requests.sql','004_wishlist_items.sql'])await shop.unsafe(await readFile('db/migrations/'+file,'utf8'));
 await shop.unsafe('ALTER TABLE public.reviews ADD COLUMN source_option_label text');
 await shop.begin(async tx=>{
  for(const r of auth.records)await tx`INSERT INTO users(id,auth_subject,display_name,test_address_json) VALUES(${r.userId},${r.userId},${'QA '+r.userId},'{}')`;
  for(const [table,rows]of Object.entries(tables)){
   const keys=Object.keys(rows[0]);for(let i=0;i<rows.length;i+=200){const values=[];
    const tuples=rows.slice(i,i+200).map(row=>'('+keys.map(key=>{const isJson=['image_urls','specs_json','option_values_json','spec_overrides_json'].includes(key);values.push(isJson?tx.json(row[key]):row[key]);return '$'+values.length+(isJson?'::jsonb':'');}).join(',')+')');
    await tx.unsafe('INSERT INTO public.'+table+'('+keys.join(',')+') VALUES '+tuples.join(','),values);
   }
  }
  await tx.unsafe('CREATE SCHEMA test_items2');
  for(const table of Object.keys(tables))await tx.unsafe('CREATE VIEW test_items2.'+table+' WITH(security_invoker=true) AS SELECT * FROM public.'+table);
 });
 for(const [table,expected]of Object.entries(tables)){
  const actual=await shop.unsafe('SELECT * FROM public.'+table);
  if(fingerprintRows(table==='reviews'?normalizeV4ReviewTimestamps(actual):actual)!==fingerprintRows(table==='reviews'?normalizeV4ReviewTimestamps(expected):expected))throw Error('restored source fingerprint mismatch: '+table);
 }
 const fingerprint=async()=>{const result={};for(const table of ['users','products','product_variants']){const [r]=await shop.unsafe(`SELECT md5(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text)) AS hash FROM public.${table} t`);result[table]=r.hash;}return result;};
 const before=await fingerprint();
 url.pathname='/'+brainName;brain=postgres(url.toString(),{max:1,onnotice:()=>{}});
 for(const file of ['001_brain_memory.sql','002_brain_fencing.sql','003_brain_rate_windows.sql','004_brain_attempt_history.sql'])await brain.unsafe(await readFile('db/brain/'+file,'utf8'));
 const saver=PostgresSaver.fromConnString(url.toString(),{schema:'shopping_brain'});await saver.setup();await saver.end();
 const credentials={};
 for(const [name,role]of [[commerceName,commerceRole],[brainName,brainRole]]){
  const password=randomBytes(40).toString('base64url');
  await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
  await admin.unsafe('REVOKE CONNECT ON DATABASE '+name+' FROM PUBLIC');await admin.unsafe('GRANT CONNECT ON DATABASE '+name+' TO '+role);
  const u=new URL(url);u.pathname='/'+name;u.username=role;u.password=password;credentials[name]=u.toString();
 }
 await shop.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
 await shop.unsafe(`GRANT USAGE ON SCHEMA public,test_items2 TO ${commerceRole}`);
 await shop.unsafe(`GRANT SELECT ON public.users,public.products,public.product_variants,public.reviews,test_items2.products,test_items2.product_variants,test_items2.reviews TO ${commerceRole}`);
 await shop.unsafe(`GRANT SELECT,INSERT,UPDATE ON public.carts,public.action_requests TO ${commerceRole}`);
 await shop.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.cart_items TO ${commerceRole}`);
 await shop.unsafe(`GRANT SELECT,INSERT,DELETE ON public.wishlist_items TO ${commerceRole}`);
 await shop.unsafe(`GRANT UPDATE(display_name) ON public.users TO ${commerceRole}`);
 await shop.unsafe(`GRANT UPDATE(active) ON public.products TO ${commerceRole}`);
 await shop.unsafe(`GRANT UPDATE(stock_qty) ON public.product_variants TO ${commerceRole}`);
 await brain.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await brain.unsafe(`GRANT USAGE ON SCHEMA shopping_brain TO ${brainRole}`);
 for(const [table,rights]of Object.entries(BRAIN_SERVICE_RIGHTS))await brain.unsafe(`GRANT ${rights.join(',')} ON shopping_brain.${table} TO ${brainRole}`);
 const after=await fingerprint();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('data changed during grants');
 await writeFile(folder+'/.secrets/services.env','DATABASE_URL='+credentials[commerceName]+'\nBRAIN_DATABASE_URL='+credentials[brainName]+'\n',{flag:'wx',mode:0o600});
 const result={status:'PASS',commerceDatabase:commerceName,brainDatabase:brainName,commerceRole,brainRole,counts:{products:1500,variants:1917,reviews:46100,users:6},protectedFingerprints:{before,after,identical:true},datasetVersion:integrity.version,originalDatabasesUnchanged:true};
 await writeFile(folder+'/database-results.json',JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}catch(error){console.error('Isolated test_items2 preparation failed: '+(error.code??error.message));process.exitCode=1;}
finally{await Promise.allSettled([shop?.end(),brain?.end(),admin.end()]);}
