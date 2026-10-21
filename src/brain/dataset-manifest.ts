import {readFile} from "node:fs/promises";
import {isAbsolute} from "node:path";

/** Deployment-owned metadata, never accepted from a shopping request. */
export interface SearchDatasetManifest {
 schemaVersion:1;datasetId:string;datasetVersion:string;
 dataClass:"SYNTHETIC_PRODUCT"|"AUDITED_REAL"|"CANDIDATE";
 catalogSource:"public"|"test_items"|"test_items2";categories:string[];
 embedding:{model:string;dimensions:number;queryRevision:string;documentRevision:string|null};
 files:{evidenceSha256:string;indexedProductsSha256:string};
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==="string"&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
export function parseDatasetManifest(raw:unknown):SearchDatasetManifest {
 if(!object(raw)||raw.schemaVersion!==1||!text(raw.datasetId,100)||!text(raw.datasetVersion,128)||
   !["SYNTHETIC_PRODUCT","AUDITED_REAL","CANDIDATE"].includes(String(raw.dataClass))||
   !["public","test_items","test_items2"].includes(String(raw.catalogSource))||
   !Array.isArray(raw.categories)||!raw.categories.length||raw.categories.length>100||
   !raw.categories.every(v=>text(v,80))||new Set(raw.categories).size!==raw.categories.length||
   !object(raw.embedding)||!object(raw.files))throw Error("invalid search dataset manifest");
 const embedding=raw.embedding,files=raw.files;
 if(!text(embedding.model,160)||!/^[-\w.]+\/[-\w.]+$/.test(embedding.model)||
   !Number.isSafeInteger(embedding.dimensions)||Number(embedding.dimensions)<1||Number(embedding.dimensions)>4096||
   typeof embedding.queryRevision!=="string"||!/^[a-f0-9]{40}$/.test(embedding.queryRevision)||
   !(embedding.documentRevision===null||embedding.documentRevision===embedding.queryRevision)||
   typeof files.evidenceSha256!=="string"||!/^[a-f0-9]{64}$/.test(files.evidenceSha256)||
   typeof files.indexedProductsSha256!=="string"||!/^[a-f0-9]{64}$/.test(files.indexedProductsSha256))
   throw Error("invalid search dataset manifest encoder or corpus identity");
 return structuredClone(raw) as unknown as SearchDatasetManifest;
}
export async function loadDatasetManifest(path:string):Promise<SearchDatasetManifest>{
 if(!isAbsolute(path))throw Error("dataset manifest requires an absolute path");
 const buffer=await readFile(path);
 if(buffer.length>64_000)throw Error("dataset manifest is too large");
 try{return parseDatasetManifest(JSON.parse(buffer.toString("utf8")));}
 catch{throw Error("invalid search dataset manifest");}
}
export function verifyDatasetManifest(manifest:SearchDatasetManifest,actual:{
 datasetVersion:string;category:string;catalogSource:string;embeddingModel:string;vectorDimensions:number;
 queryRevision:string;evidenceSha256:string;indexedProductsSha256:string;
}):void {
 if(manifest.datasetVersion!==actual.datasetVersion||!manifest.categories.includes(actual.category)||
   manifest.catalogSource!==actual.catalogSource||manifest.embedding.model!==actual.embeddingModel||
   manifest.embedding.dimensions!==actual.vectorDimensions||manifest.embedding.queryRevision!==actual.queryRevision||
   manifest.files.evidenceSha256!==actual.evidenceSha256||
   manifest.files.indexedProductsSha256!==actual.indexedProductsSha256)
   throw Error("dataset manifest does not match active catalog, encoder or corpus");
}
