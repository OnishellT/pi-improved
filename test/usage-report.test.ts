import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts/usage-report.mjs");
const run = (root: string, ...args: string[]) => execFileSync("node", [script, "--root", root, ...args], { encoding: "utf8" });

test("usage report: day, model, subagent, context buckets, warnings", async () => {
  const root = await tempDir("usage-");
  cpSync(path.join(repo, "test/fixtures/usage"), root, { recursive: true });
  const meta = path.join(root, "subagents/run1/metadata.json");
  writeFileSync(meta, readFileSync(meta, "utf8").replace("SUBFILE", path.join(root, "sub.jsonl")));
  const all = run(root);
  assert.match(all, /4 assistant turns .*: \$4\.25/);
  assert.match(all, /\$\s+2\.00 .*turns=\s+2\s+2026-10-01/);
  assert.match(all, /\$\s+2\.25 .*turns=\s+2\s+m2/);
  assert.match(all, /\$\s+0\.25 .*turns=\s+1\s+reviewer-1/);
  assert.match(all, /200K\+: .*turns=1/);
  assert.match(all, /warning: s\.jsonl: 1 unparseable/);
  assert.match(all, /warning: s\.jsonl: assistant message without usage\.cost\.total/);
  assert.match(run(root, "--since", "2026-10-02"), /2 assistant turns/);
});

test("usage report: missing root warns instead of failing", () => {
  assert.match(run(path.join(tmpdir(), "nope-usage")), /warning: no priced assistant turns/);
});

test("usage report: a --since that is not YYYY-MM-DD is rejected with a one-line error", () => {
  const r = spawnSync("node", [script, "--root", tmpdir(), "--since", "yesterday"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), '--since must be YYYY-MM-DD, got "yesterday"');
});
