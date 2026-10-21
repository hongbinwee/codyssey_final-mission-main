import test from "node:test";
import assert from "node:assert/strict";
import {parseKrwTenThousandBand} from "../../src/brain/price-band.ts";
test("만원대 chips translate to exact inclusive intervals",()=>{
 assert.deepEqual(parseKrwTenThousandBand("에센스를 2만원대에서 찾고 있어요."),{minTotalWon:20000,maxTotalWon:29999});
 assert.deepEqual(parseKrwTenThousandBand("15만원대"),{minTotalWon:150000,maxTotalWon:159999});
 assert.deepEqual(parseKrwTenThousandBand("10만원대"),{minTotalWon:100000,maxTotalWon:199999});
 assert.deepEqual(parseKrwTenThousandBand("20만원대"),{minTotalWon:200000,maxTotalWon:299999});
 assert.equal(parseKrwTenThousandBand("2만원대 이하"),null);
 assert.equal(parseKrwTenThousandBand("2만원대 3만원대"),null);
 assert.equal(parseKrwTenThousandBand("2만원 정도"),null);
});
