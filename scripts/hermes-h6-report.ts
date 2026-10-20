/**
 * H6 offline/connected QA aggregator.
 * Input is a local metadata-only JSON array of HermesEvalCase rows.
 * Never prints raw prompts, reviews, actor IDs, credentials or individual cases.
 */
import {readFileSync} from "node:fs";
import {summarizeHermesEvaluation,evaluateHermesGate,type HermesEvalCase} from "../src/brain/hermes-evaluation.ts";

const path=process.argv[2];
if(!path){console.error("usage: node scripts/hermes-h6-report.ts <local-metadata-json-file>");process.exit(2);}
try{
 const raw:unknown=JSON.parse(readFileSync(path,"utf8"));
 if(!Array.isArray(raw))throw Error("expected array of evaluation metadata");
 const fields=new Set(["caseId","mode","expectedTools","actualTools","searchRequired",
  "outcomeExpected","outcomeActual","grounded","actorIsolated","writeWithoutApproval","durationMs"]);
 if(raw.some(x=>!x||typeof x!=="object"||Array.isArray(x)||
  Object.keys(x).some(k=>!fields.has(k))))throw Error("unexpected personal or unsupported fields");
 const summary=summarizeHermesEvaluation(raw as HermesEvalCase[]);
 const gate=evaluateHermesGate(summary,{minExactToolRate:.9,maxUnnecessarySearchRate:.05,
  maxP95Ms:60000,requireLiveModel:true,requireConnectedE2e:true});
 console.log(JSON.stringify({kind:"HERMES_H6_METADATA_REPORT",version:1,summary,gate},null,2));
 if(!gate.passed)process.exitCode=1;
}catch{console.error("invalid or unreadable metadata-only H6 evaluation file");process.exitCode=2;}
