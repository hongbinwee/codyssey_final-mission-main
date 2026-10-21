import postgres from 'postgres';
import {readFileSync} from 'node:fs';
import {createCatalog,type CatalogSource} from './catalog.ts';
import {assertServiceRole} from './db.ts';
import {databaseUrlWithPasswordFile} from './db-url.ts';
import {X509Certificate} from 'node:crypto';
import tls from 'node:tls';

/** Separate, SELECT-only source. Never assigns the global business sql pool. */
export async function openExternalCatalog(env:Record<string,string|undefined>,source:CatalogSource,connect:typeof postgres=postgres){
 if(!env.CATALOG_DATABASE_URL){
  if(env.CATALOG_DATABASE_PASSWORD_FILE||env.CATALOG_DATABASE_SSL_CA_FILE)throw Error('external catalog URL required');
  return undefined;
 }
 if(source==='public')throw Error('external catalog requires an explicit test dataset schema');
 const value=env.CATALOG_DATABASE_PASSWORD_FILE?databaseUrlWithPasswordFile(env.CATALOG_DATABASE_URL,env.CATALOG_DATABASE_PASSWORD_FILE):env.CATALOG_DATABASE_URL;
 let url:URL;try{url=new URL(value);}catch{throw Error('invalid external catalog database URL');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||
    !/^\/[a-zA-Z0-9_]+$/.test(url.pathname)||url.search||url.hash)throw Error('invalid external catalog database target');
 const approvedRole=env.CATALOG_DATABASE_APPROVED_ADMIN_ROLE?.trim();
 if(approvedRole&&decodeURIComponent(url.username)!==approvedRole)throw Error('external catalog approved role mismatch');
 const pinned=env.CATALOG_DATABASE_SERVER_CERT_FILE?new X509Certificate(readFileSync(env.CATALOG_DATABASE_SERVER_CERT_FILE)):undefined;
 if(pinned&&(!pinned.checkHost(url.hostname)||Date.now()<Date.parse(pinned.validFrom)||Date.now()>Date.parse(pinned.validTo)))throw Error('external catalog certificate does not match target or validity');
 const ssl={rejectUnauthorized:true,...(env.CATALOG_DATABASE_SSL_CA_FILE?{ca:readFileSync(env.CATALOG_DATABASE_SSL_CA_FILE)}:{}),
   checkServerIdentity:(host:string,peer:tls.PeerCertificate)=>{
    const error=tls.checkServerIdentity(host,peer);if(error)return error;
    if(pinned&&peer.fingerprint256!==pinned.fingerprint256)return Error('external catalog server certificate mismatch');
   }};
 const db=connect(value,{max:3,connect_timeout:8,ssl,
   connection:{default_transaction_read_only:true},onnotice:()=>{}});
 try{
  if(approvedRole){
   const [state]=await db.unsafe<{read_only:string}[]>("SELECT current_setting('transaction_read_only') AS read_only FROM pg_roles WHERE rolname=current_user");
   if(state?.read_only!=='on')throw Error('external catalog requires read-only session');
  }else await assertServiceRole(db,true);
  const [state]=await db.unsafe<{database:string;ready:boolean}[]>(`SELECT current_database() AS database,
    has_schema_privilege(current_user,$1,'USAGE') AND
    has_table_privilege(current_user,$2,'SELECT') AND
    has_table_privilege(current_user,$3,'SELECT') AND
    has_table_privilege(current_user,$4,'SELECT') AS ready`,
    [source,source+'.products',source+'.product_variants',source+'.reviews']);
  if(!state||state.database!==decodeURIComponent(url.pathname.slice(1))||state.ready!==true)throw Error('external catalog SELECT privileges or database mismatch');
  // The approved administrator credential does not expose an unrestricted query
  // interface to Commerce. Only the existing catalog's fixed SELECTs are allowed.
  const reader={unsafe:((query:string,parameters?:unknown[])=>{
    if(!/^\s*SELECT\b/i.test(query)||/;|--|\/\*/.test(query)||/\b(?:INTO|FOR\s+(?:UPDATE|SHARE))\b/i.test(query))return Promise.reject(Error('external catalog permits SELECT only'));
    return db.unsafe(query,parameters as never);
  }) as typeof db.unsafe};
  return {db:reader,source,catalog:createCatalog(source,reader),close:()=>db.end()};
 }catch(error){await db.end();throw error;}
}
