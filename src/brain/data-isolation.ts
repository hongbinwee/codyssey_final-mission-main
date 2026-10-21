/**
 * Guard for the future dataset loader. These data classes are DISJOINT.
 * This function validates declared provenance/target before ingestion; remote
 * upstream audit of an AUDITED_REAL manifest must happen separately.
 */
export type DatasetClass="SYNTHETIC_PRODUCT"|"EVALUATION_ONLY"|"CI_FIXTURE"|"AUDITED_REAL";
export interface DatasetManifest{
 dataset_id:string;version:string;data_class:DatasetClass;
 schema_version:string;records:number;sha256:string;source_kind:string;
}
export type DatasetTarget="synthetic"|"evaluation"|"ci"|"real";
const classes:Record<DatasetTarget,DatasetClass>={
 synthetic:"SYNTHETIC_PRODUCT",evaluation:"EVALUATION_ONLY",
 ci:"CI_FIXTURE",real:"AUDITED_REAL"
};
const id=/^[a-zA-Z0-9._-]{3,100}$/;
const versionId=/^[a-zA-Z0-9._-]{1,100}$/;
const sha=/^[a-f0-9]{64}$/i;
export function requireDatasetIsolation(manifest:DatasetManifest,target:DatasetTarget):DatasetManifest{
 if(!manifest||typeof manifest!=="object"||!Object.values(classes).includes(manifest.data_class)||
   !id.test(manifest.dataset_id)||!versionId.test(manifest.version)||
   !versionId.test(manifest.schema_version)||!sha.test(manifest.sha256)||
   !Number.isSafeInteger(manifest.records)||manifest.records<0)
   throw new Error("invalid versioned dataset manifest");
 if(manifest.data_class!==classes[target])
   throw new Error("dataset class isolation violation: mixed synthetic, evaluation, CI or real");
 if(manifest.data_class==="AUDITED_REAL"&&manifest.source_kind!=="verified-external-manifest")
   throw new Error("real data requires external audit manifest provenance");
 if(manifest.data_class!=="AUDITED_REAL"&&manifest.source_kind==="verified-external-manifest")
   throw new Error("non-real records must not claim independently audited origin");
 return manifest;
}
export function validateBatchIsolation(manifests:readonly DatasetManifest[],target:DatasetTarget):void{
 if(!manifests.length)throw new Error("empty dataset batch");
 const unique=new Set<string>();
 for(const m of manifests){
   requireDatasetIsolation(m,target);
   const key=m.dataset_id+"@"+m.version;
   if(unique.has(key))throw new Error("duplicate dataset version");
   unique.add(key);
 }
}
