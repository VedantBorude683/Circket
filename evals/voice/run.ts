import { readFile } from "node:fs/promises";
import { fastParse } from "../../apps/parser/dist/parser.js";

type Case = {
  transcript: string;
  expected: unknown;
};

const lines = (
  await readFile(new URL("./cases.jsonl", import.meta.url), "utf8")
)
  .trim()
  .split("\n");
const cases = lines.map((line) => JSON.parse(line) as Case);
let exact = 0;
for (const item of cases) {
  if (
    JSON.stringify(fastParse(item.transcript)) === JSON.stringify(item.expected)
  )
    exact += 1;
}
console.log(
  `cases=${cases.length} fast_path_exact=${exact} accuracy=${((exact / cases.length) * 100).toFixed(2)}%`
);
