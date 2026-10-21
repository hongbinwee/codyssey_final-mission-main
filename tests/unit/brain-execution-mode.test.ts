import test from "node:test";
import assert from "node:assert/strict";
import {snapshotMatches,executionMode} from "../../src/brain/execution-mode.ts";
test("Deep handoff requires the same owner, request, plan revision, evidence snapshot and fencing generation",()=>{
 const snapshot={actorUserId:"one",conversationId:"c",requestId:"r",planRevision:2,evidenceSnapshotId:"hash",fenceGeneration:4};
 assert.equal(snapshotMatches(snapshot,{...snapshot}),true);
 for(const delta of [{actorUserId:"two"},{conversationId:"other"},{requestId:"old"},{planRevision:1},{evidenceSnapshotId:"stale"},{fenceGeneration:3}])
  assert.equal(snapshotMatches(snapshot,{...snapshot,...delta}),false);
 assert.equal(executionMode(undefined),"FAST");assert.equal(executionMode("DEEP"),"DEEP");
 assert.throws(()=>executionMode("unknown"));
});
