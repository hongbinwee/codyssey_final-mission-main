/**
 * Brain persistence must use a physically separate, explicitly named database.
 * This rejects the historical Commerce databases even when a role has permission.
 */
export function parseBrainDatabaseUrl(brainUrl:unknown,commerceUrl?:string):{url:string;dbName:string}{
 if(typeof brainUrl!=="string"||!brainUrl.trim())throw new Error("BRAIN_DATABASE_URL required");
 let u:URL;try{u=new URL(brainUrl);}catch{throw new Error("invalid Brain database URL");}
 const dbName=decodeURIComponent(u.pathname.slice(1));
 if(!["postgresql:","postgres:"].includes(u.protocol)||!u.hostname||
   !/^brain_[a-z0-9_]{2,50}$/.test(dbName)||!u.username||!u.password)
   throw new Error("Brain needs a distinct brain_* PostgreSQL database");
 if(commerceUrl){
   let c:URL;try{c=new URL(commerceUrl);}catch{throw new Error("invalid Commerce connection");}
   if(c.hostname.toLowerCase()===u.hostname.toLowerCase()&&
     (c.port||"5432")===(u.port||"5432")&&decodeURIComponent(c.pathname)===decodeURIComponent(u.pathname))
     throw new Error("Brain and Commerce target the same database");
 }
 return {url:brainUrl,dbName};
}
