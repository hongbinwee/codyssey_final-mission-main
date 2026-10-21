import test from "node:test";
import assert from "node:assert/strict";
import {brainMutationAllowed} from "../../src/brain/csrf.ts";
const local="http://127.0.0.1:3217";
const headers={host:"127.0.0.1:3217",cookie:"session=fake"};
test("M15 cookie mutation CSRF requires same-origin Origin/Referer and rejects cross-site",()=>{
 assert.equal(brainMutationAllowed({...headers,origin:local}),true);
 assert.equal(brainMutationAllowed({...headers,referer:local+"/app"}),true);
 assert.equal(brainMutationAllowed(headers),false);
 assert.equal(brainMutationAllowed({...headers,origin:"https://evil.example"}),false);
 assert.equal(brainMutationAllowed({...headers,origin:local+"/malicious"}),false);
 assert.equal(brainMutationAllowed({...headers,origin:"null"}),false);
 assert.equal(brainMutationAllowed({...headers,origin:local,"sec-fetch-site":"cross-site"}),false);
 assert.equal(brainMutationAllowed({...headers,origin:local,"sec-fetch-site":"same-site"}),false);
 assert.equal(brainMutationAllowed({...headers,origin:local,"sec-fetch-site":"same-origin"}),true);
 assert.equal(brainMutationAllowed({...headers,origin:local,host:"evil.example"}),false);
});
test("M15 deployment origin must be explicitly configured for non-loopback hosts",()=>{
 const publicUrl="https://shopping.example";
 const prod={host:"shopping.example",cookie:"session=fake"};
 assert.equal(brainMutationAllowed({...prod,origin:publicUrl}),false);
 assert.equal(brainMutationAllowed({...prod,origin:publicUrl},publicUrl),true);
 assert.equal(brainMutationAllowed({...prod,origin:publicUrl,host:"bad.example"},publicUrl),false);
 assert.equal(brainMutationAllowed({...prod,origin:"http://shopping.example"},publicUrl),false);
 assert.equal(brainMutationAllowed({...prod,origin:publicUrl},"http://shopping.example"),false);
});
test("M15 bearer-only nonbrowser callers can omit Origin but cannot bypass browser cookies",()=>{
 assert.equal(brainMutationAllowed({host:"127.0.0.1:3217",authorization:"Bearer token"}),true);
 assert.equal(brainMutationAllowed({...headers,authorization:"Bearer token"}),false);
 assert.equal(brainMutationAllowed({host:"127.0.0.1:3217",authorization:"Bearer token","sec-fetch-site":"cross-site"}),false);
});
