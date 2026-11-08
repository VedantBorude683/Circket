import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replay } from "@voicescore/engine";
import { convertCricsheetMatch, type SkipRecord } from "./index.js";

const directory = process.env.CRICSHEET_DIR ?? "evals/cricsheet";
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".json"))
  .sort();
const skips: SkipRecord[] = [];
const stages = [5, 10, 20];

for (const stage of stages) {
  const selected = files.slice(0, stage);
  let included = 0;
  let exact = 0;
  for (const file of selected) {
    const matchId = file.slice(0, -5);
    const conversion = convertCricsheetMatch(
      matchId,
      JSON.parse(await readFile(join(directory, file), "utf8")) as unknown
    );
    if ("reason" in conversion) {
      skips.push(conversion);
      continue;
    }
    included += 1;
    const state = replay(conversion.events);
    const innings = state.innings[0];
    if (
      innings.runs === conversion.expected.runs &&
      innings.wickets === conversion.expected.wickets &&
      innings.legalBalls === conversion.expected.legalBalls
    ) {
      exact += 1;
    } else {
      skips.push({
        match: matchId,
        reason: `mismatch: expected ${conversion.expected.runs}/${conversion.expected.wickets}/${conversion.expected.legalBalls}, got ${innings.runs}/${innings.wickets}/${innings.legalBalls}`
      });
    }
  }
  console.log(
    `stage=${stage} selected=${selected.length} included=${included} exact=${exact}`
  );
}

console.log("skipped_matches:");
for (const skip of skips) console.log(`- ${skip.match}: ${skip.reason}`);
if (skips.length > 0) process.exitCode = 1;
