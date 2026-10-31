import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { checkContract, formatContract, missingNames, relatesTo, stemTokens } from "../src/contract.ts";
import { fifo, tempProject } from "./helpers.ts";

const plan = (iface: any[]) => ({ summary: "", steps: [], files: [], decisions: [], interface: iface, seams: [] });

test("stemTokens splits kebab, snake and camel case stems", () => {
  assert.deepEqual(stemTokens("src/lib/entry-sizing.ts"), ["entry", "sizing"]);
  assert.deepEqual(stemTokens("order_guards.py"), ["order", "guards"]);
  assert.deepEqual(stemTokens("ScaleOutSteps.test.ts"), ["Scale", "Out", "Steps"]);
});

test("missingNames: exports must be whole words in the evidence, case-insensitive", () => {
  const ticket = "## Scope\n- `computeEntryQty({ size, ask })` returning a quantity\n- `validateSizeChange(current, next)`";
  assert.deepEqual(missingNames({ file: "src/sizing.ts", exports: ["computeEntryQty", "validateSizeChange"] }, ticket, false), []);
  assert.deepEqual(missingNames({ file: "src/sizing.ts", exports: ["computeEntryQty", "parseMicros"] }, ticket, false), ["parseMicros"]);
  // `size` is a word in the ticket, `sizeChange` is not
  assert.deepEqual(missingNames({ file: "src/x.ts", exports: ["sizeChange"] }, ticket, false), ["sizeChange"]);
  assert.deepEqual(missingNames({ file: "src/x.ts", exports: ["COMPUTEENTRYQTY"] }, ticket, false), []);
});

test("missingNames: a new file's stem needs every token in the evidence; existing files are not checked", () => {
  const ticket = "# Stop and trailing levels\nPure functions for the initial stop.";
  assert.deepEqual(missingNames({ file: "src/lib/domain/protection.ts", exports: [] }, ticket, true), ["protection.ts"]);
  assert.deepEqual(missingNames({ file: "src/lib/domain/stop.ts", exports: [] }, ticket, true), []);
  assert.deepEqual(missingNames({ file: "src/lib/domain/trailing-stop.ts", exports: [] }, ticket, true), []);
  assert.deepEqual(missingNames({ file: "src/lib/domain/protection.ts", exports: [] }, ticket, false), []);
});

test("checkContract reports missing files and names not present in their file", async () => {
  const root = await tempProject({ "src/fee.ts": "export function fee(n: number) { return n; }\nexport const feeRate = 1;\n" });
  assert.deepEqual(await checkContract(root, plan([{ file: "src/fee.ts", exports: ["fee", "feeRate"] }])), []);
  const problems = await checkContract(root, plan([{ file: "src/fee.ts", exports: ["fee", "formatFee"] }, { file: "src/money.ts", exports: ["parseMicros"] }]));
  assert.deepEqual(problems, ["src/fee.ts: missing formatFee", "src/money.ts: the file does not exist"]);
  assert.match(formatContract(problems), /Interface contract not met[\s\S]*- src\/fee\.ts: missing formatFee/);
  // `fee` alone must not satisfy `feeRate2`
  assert.deepEqual(await checkContract(root, plan([{ file: "src/fee.ts", exports: ["feeRate2"] }])), ["src/fee.ts: missing feeRate2"]);
});

test("checkContract reads a symlinked source file but never blocks on a FIFO, through a link or not", { timeout: 10_000 }, async (t) => {
  const root = await tempProject({ "src/a.ts": "export const a = 1;" });
  fifo(t, path.join(root, "src/pipe.ts"));
  await fs.symlink("a.ts", path.join(root, "src/link.ts"));
  await fs.symlink("pipe.ts", path.join(root, "src/to-pipe.ts"));
  const problems = await checkContract(root, plan(["link.ts", "pipe.ts", "to-pipe.ts", "gone.ts"].map((f) => ({ file: `src/${f}`, exports: ["a"] }))));
  assert.deepEqual(problems, ["src/pipe.ts: not a readable regular file", "src/to-pipe.ts: not a readable regular file", "src/gone.ts: the file does not exist"]);
});

test("relatesTo: the source shares a word of the question; short words and other topics do not count", () => {
  assert.equal(relatesTo("Money type?", "# Money\nuse cents"), true);
  assert.equal(relatesTo("Fee unit?", "name: pkg\nversion: 1"), false);
  assert.equal(relatesTo("Is it ok?", "is it ok"), false);
});

test("checkContract flags an interface file that does not exist even when only a test file", async () => {
  const root = await tempProject({ "src/a.ts": "export const a = 1;" });
  const problems = await checkContract(root, plan([{ file: "src/a.ts", exports: ["a"] }, { file: "test/a.test.ts", exports: ["t"] }]));
  assert.deepEqual(problems, ["test/a.test.ts: the file does not exist"]);
});

test("checkContract looks at the exports only: a usage line is plan text, not a gate", async () => {
  const root = await tempProject({ "src/fee.ts": "export function fee(n: number) { return n; }\n" });
  const usage = 'fee("a").toUpperCase(); expect(parseInt(fee(1)))';
  assert.deepEqual(await checkContract(root, plan([{ file: "src/fee.ts", exports: ["fee"], usage }])), []);
  assert.deepEqual(await checkContract(root, plan([{ file: "src/fee.ts", exports: ["gone"], usage: "fee(1)" }])), ["src/fee.ts: missing gone"]);
});

test("a qualified name counts as present when each segment is a word, whatever the separator", async () => {
  const root = await tempProject({ "src/name.rs": "pub enum BuffName {\n    ResMinus,\n    Superconduct,\n}\n", "src/other.rs": "pub enum BuffName { ResMinus }\n" });
  for (const name of ["BuffName::Superconduct", "BuffName.Superconduct", "BuffName#Superconduct", "BuffName/Superconduct"]) {
    assert.deepEqual(await checkContract(root, plan([{ file: "src/name.rs", exports: [name] }])), [], name);
    assert.deepEqual(await checkContract(root, plan([{ file: "src/other.rs", exports: [name] }])), [`src/other.rs: missing ${name}`], name);
  }
  // evidence side: the ticket says "Superconduct buff" and names BuffName, never the joined string
  assert.deepEqual(missingNames({ file: "src/name.rs", exports: ["BuffName::Superconduct"] }, "Add a Superconduct entry to BuffName", false), []);
  assert.deepEqual(missingNames({ file: "src/name.rs", exports: ["BuffName::Superconduct"] }, "Add a Superconduct entry", false), ["BuffName::Superconduct"]);
});

test("relatesTo: a shared question word (should, which, about) is not a shared topic", () => {
  assert.equal(relatesTo("Should we use Redis or Memcached for sessions?", "the build should be fast"), false);
  assert.equal(relatesTo("Which store holds sessions?", "# Sessions\nkept in Redis"), true);
  assert.equal(relatesTo("Should we use Make?", "Make is the build tool."), true);
});
