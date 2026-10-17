import {readFileSync} from "node:fs";
import {auditIntentDataset,suggestCrossSplitNearDuplicates} from "../src/brain/eval-audit.ts";
const file=JSON.parse(readFileSync(new URL("../eval/brain/intent-v2.json",import.meta.url),"utf8"));
if(file.version!=="brain-intent-eval-v2"||!Array.isArray(file.cases))
 throw Error("unexpected Brain v2 evaluation data");
const report={dataset:file.version,mode:"metadata_only_not_live",
 ...auditIntentDataset(file.cases),nearDuplicateReview:suggestCrossSplitNearDuplicates(file.cases)};
process.stdout.write(JSON.stringify(report,null,2)+"\n");
// A provisional, AI-authored holdout is NOT a verified blind benchmark.
// Missing independent approval is reported, not silently upgraded to PASS.
if(report.invalidCases||report.crossSplitDuplicateGroups)process.exitCode=1;
