import test from "node:test";
import assert from "node:assert/strict";
const manifestModule=import("../../src/brain/dataset-manifest.ts").catch(()=>null);
const fixture=()=>({schemaVersion:1,datasetId:"catalog-a",datasetVersion:"catalog-a:v1",
 dataClass:"SYNTHETIC_PRODUCT",catalogSource:"test_items",categories:["audio","household"],
 embedding:{model:"sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",dimensions:384,
   queryRevision:"a".repeat(40),documentRevision:null},
 files:{evidenceSha256:"b".repeat(64),indexedProductsSha256:"c".repeat(64)}});
test("dataset manifest describes arbitrary categories without changing Brain core",async()=>{
 const mod=await manifestModule;assert.ok(mod,"manifest boundary missing");
 const result=mod.parseDatasetManifest(fixture());
 assert.deepEqual(result.categories,["audio","household"]);
 assert.equal(result.embedding.documentRevision,null,"unknown document provenance must remain unknown");
});
test("dataset manifest rejects evaluation mixing, unsafe catalog and incompatible encoder identity",async()=>{
 const mod=await manifestModule;assert.ok(mod);
 for(const patch of [{dataClass:"EVALUATION_ONLY"},{catalogSource:"test_items; DROP SCHEMA public"},
   {categories:[]},{schemaVersion:2},{files:{evidenceSha256:"bad",indexedProductsSha256:"c".repeat(64)}}])
   assert.throws(()=>mod.parseDatasetManifest({...fixture(),...patch}),/manifest/i);
 const descriptor=mod.parseDatasetManifest(fixture());
 assert.throws(()=>mod.verifyDatasetManifest(descriptor,{datasetVersion:"wrong",category:"audio",
   catalogSource:"test_items",embeddingModel:descriptor.embedding.model,vectorDimensions:384,
   queryRevision:"a".repeat(40),evidenceSha256:"b".repeat(64),indexedProductsSha256:"c".repeat(64)}),/manifest/i);
});
test("manifest verification compares exact corpus hashes, category, model, dimension and revision",async()=>{
 const mod=await manifestModule;assert.ok(mod);
 const descriptor=mod.parseDatasetManifest(fixture());
 const actual={datasetVersion:descriptor.datasetVersion,category:"household",catalogSource:"test_items",
   embeddingModel:descriptor.embedding.model,vectorDimensions:384,queryRevision:"a".repeat(40),
   evidenceSha256:"b".repeat(64),indexedProductsSha256:"c".repeat(64)};
 assert.doesNotThrow(()=>mod.verifyDatasetManifest(descriptor,actual));
 for(const patch of [{category:"beauty"},{catalogSource:"public"},{vectorDimensions:383},
   {embeddingModel:"different-encoder"},{queryRevision:"d".repeat(40)},
   {evidenceSha256:"d".repeat(64)},{indexedProductsSha256:"d".repeat(64)}])
   assert.throws(()=>mod.verifyDatasetManifest(descriptor,{...actual,...patch}),/manifest/i);
 assert.throws(()=>mod.parseDatasetManifest({...fixture(),embedding:{...fixture().embedding,
   documentRevision:"d".repeat(40)}}),/manifest/i,"known incompatible document/query revisions cannot pass");
});
