import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { writeAdr } from "../src/adr.ts";
import { inFiles, inScope, oneLine, readTask, resolveInside, updateTask, writeTask, type Task } from "../src/task-state.ts";
import { tempProject } from "./helpers.ts";

const task = (files: string[]): Task => ({ id: "t1", title: "x", status: "implementing", plan: { summary: "", steps: [], files, decisions: [], interface: [], seams: [] }, allowedExtra: [], startedAt: "" });

test("task state round-trips and clears", async () => {
  const root = await tempProject({});
  assert.equal(await readTask(root), undefined);
  await writeTask(root, task(["a.ts"]));
  await updateTask(root, (t) => void t.allowedExtra.push("b.ts"));
  assert.deepEqual((await readTask(root))?.allowedExtra, ["b.ts"]);
  await writeTask(root, undefined);
  assert.equal(await readTask(root), undefined);
});

test("inScope matches exact files and directory prefixes", () => {
  const t = task(["src/a.ts", "src/billing/"]);
  assert.equal(inScope(t, "src/a.ts"), true);
  assert.equal(inScope(t, "src/billing/x.ts"), true);
  assert.equal(inScope(t, "src/other.ts"), false);
});

test("ADRs are numbered after the highest existing one", async () => {
  const root = await tempProject({ "docs/adr/0007-old.md": "" });
  const file = await writeAdr(root, { title: "Usar Postgres para pagos", context: "c", decision: "d" }, new Date("2026-10-21"));
  assert.equal(file, "docs/adr/0008-usar-postgres-para-pagos.md");
  assert.match(await fs.readFile(path.join(root, file), "utf8"), /^# 0008\. Usar Postgres[\s\S]*Date: 2026-10-21/);
});

test("inFiles matches exact files and directory prefixes", () => {
  assert.equal(inFiles(["src/a.ts", "docs/"], "docs/x.md"), true);
  assert.equal(inFiles(["src/a.ts"], "src/a.tsx"), false);
});

test("resolveInside keeps paths in the project root", () => {
  assert.equal(resolveInside("/p/root", "src/a.md"), "/p/root/src/a.md");
  assert.equal(resolveInside("/p/root", "../x.md"), undefined);
  assert.equal(resolveInside("/p/root", "/etc/hosts"), undefined);
  assert.equal(resolveInside("/p/root", "a/../../b"), undefined);
});

test("oneLine takes the first line without markdown marks and cuts it", () => {
  assert.equal(oneLine("# Superconduct shred is missing\n\nlong body"), "Superconduct shred is missing");
  assert.equal(oneLine("\n\n  > quoted first\nsecond"), "quoted first");
  assert.equal(oneLine("x".repeat(100), 72), `${"x".repeat(71)}…`);
  assert.equal(oneLine(""), "");
});
