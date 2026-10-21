import test from "node:test";
import assert from "node:assert/strict";
import {requireDatasetIsolation,validateBatchIsolation} from "../../src/brain/data-isolation.ts";

const synthetic={dataset_id:"shopping-v5-synth",version:"v5",
 data_class:"SYNTHETIC_PRODUCT" as const,schema_version:"product-v5",records:180,
 sha256:"a".repeat(64),source_kind:"synthesized"};
const real={dataset_id:"genuine-source",version:"v1",data_class:"AUDITED_REAL" as const,
 schema_version:"product-v1",records:500,sha256:"b".repeat(64),
 source_kind:"verified-external-manifest"};
test("synthetic v4/v5 cannot be inserted into real ingest batches",()=>{
 assert.doesNotThrow(()=>requireDatasetIsolation(synthetic,"synthetic"));
 assert.throws(()=>requireDatasetIsolation(synthetic,"real"),/isolation/);
 assert.throws(()=>validateBatchIsolation([real,synthetic],"real"),/isolation/);
});
test("a fake real audit string is not proof and cannot be ingested",()=>{
 assert.throws(()=>requireDatasetIsolation({...real,source_kind:"REAL"},"real"),/external audit/);
 assert.throws(()=>requireDatasetIsolation({...synthetic,source_kind:"verified-external-manifest"},"synthetic"),/must not claim/);
});
test("evaluation labels and CI fixtures are never real shopping records",()=>{
 const evalManifest={...synthetic,dataset_id:"brain-intent-v2",data_class:"EVALUATION_ONLY" as const,records:60,source_kind:"hand-authored"};
 assert.doesNotThrow(()=>requireDatasetIsolation(evalManifest,"evaluation"));
 for(const target of ["real","ci","synthetic"] as const)
   assert.throws(()=>requireDatasetIsolation(evalManifest,target),/isolation/);
});
test("duplicate dataset versions, absent checksums and unknown targets fail closed",()=>{
 assert.throws(()=>validateBatchIsolation([synthetic,synthetic],"synthetic"),/duplicate/);
 assert.throws(()=>requireDatasetIsolation({...synthetic,sha256:"fake"},"synthetic"),/manifest/);
 assert.throws(()=>validateBatchIsolation([],"synthetic"),/empty/);
});
