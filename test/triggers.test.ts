import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { addedPackagesFromCommand, applyEdits, dependencyNames, isMigration, registerTriggers, toRelative } from "../src/triggers.ts";
import { readTask, writeTask, type Task } from "../src/task-state.ts";
import { fakePi, fakeUI, tempProject } from "./helpers.ts";

test("addedPackagesFromCommand", () => {
  assert.deepEqual(addedPackagesFromCommand("npm install"), []);
  assert.deepEqual(addedPackagesFromCommand("npm i -D zod@3 @types/node"), ["zod", "@types/node"]);
  assert.deepEqual(addedPackagesFromCommand("cd x && pnpm add lodash; yarn add react"), ["lodash", "react"]);
  assert.deepEqual(addedPackagesFromCommand("pip install -r requirements.txt"), []);
  assert.deepEqual(addedPackagesFromCommand("pip install requests==2.0 flask"), ["requests", "flask"]);
  assert.deepEqual(addedPackagesFromCommand("cargo add serde"), ["serde"]);
  assert.deepEqual(addedPackagesFromCommand("go get github.com/a/b"), ["github.com/a/b"]);
  assert.deepEqual(addedPackagesFromCommand("ls -la"), []);
});

test("dependencyNames", () => {
  assert.deepEqual([...dependencyNames("package.json", '{"dependencies":{"a":"1"},"devDependencies":{"b":"1"}}')!], ["a", "b"]);
  assert.equal(dependencyNames("package.json", "{bad"), undefined);
  assert.deepEqual([...dependencyNames("requirements.txt", "Flask>=2\n# c\nrequests\n")!], ["flask", "requests"]);
  assert.deepEqual([...dependencyNames("go.mod", "module x\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n")!], ["github.com/a/b"]);
  assert.deepEqual([...dependencyNames("Cargo.toml", '[package]\nname="x"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies.foo]\nversion="1"\n')!].sort(), ["foo", "serde", "tokio"]);
  const py = '[project]\nname = "x"\ndependencies = [\n  "requests>=2",\n  "flask",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n';
  assert.deepEqual([...dependencyNames("pyproject.toml", py)!].sort(), ["flask", "pytest", "requests"]);
});

test("isMigration, toRelative, applyEdits", () => {
  for (const p of ["db/migrate/1.rb", "src/migrations/a.ts", "alembic/versions/x.py", "prisma/schema.prisma", "q.sql"]) assert.ok(isMigration(p), p);
  assert.ok(!isMigration("src/app.ts"));
  assert.equal(toRelative("/r", "/r/src/a.ts"), "src/a.ts");
  assert.equal(toRelative("/r", "src/a.ts"), "src/a.ts");
  assert.equal(applyEdits("a b", [{ oldText: "b", newText: "c" }]), "a c");
  assert.equal(applyEdits("b b", [{ oldText: "b", newText: "c" }]), undefined);
});

const task = (over: Partial<Task> = {}): Task => ({
  id: "1", title: "Add thing", status: "implementing", allowedExtra: [], startedAt: "now",
  plan: { summary: "", steps: [], files: ["src/a.ts"], decisions: [], interface: [], seams: [] }, ...over,
});

async function setup(files: Record<string, string>, answers: unknown[], t: Task | null = task()) {
  const root = await tempProject(files);
  if (t) await writeTask(root, t);
  const ui = fakeUI(answers);
  const { pi, emit } = fakePi();
  registerTriggers(pi);
  const ctx: any = { cwd: root, hasUI: true, ui };
  return { root, ui, run: (toolName: string, input: any) => emit("tool_call", { toolName, input }, ctx) };
}

test("no task or planning task: no prompts", async () => {
  const a = await setup({}, [], null);
  assert.equal(await a.run("write", { path: "x.ts", content: "" }), undefined);
  const b = await setup({}, [], task({ status: "planning" }));
  assert.equal(await b.run("bash", { command: "npm add x" }), undefined);
});

test("in-scope write and ignored paths: no prompt", async () => {
  const s = await setup({}, []);
  assert.equal(await s.run("write", { path: "src/a.ts", content: "" }), undefined);
  assert.equal(await s.run("write", { path: path.join(s.root, "docs/adr/0001-x.md"), content: "" }), undefined);
  assert.equal(await s.run("edit", { path: ".pi/task.json", edits: [] }), undefined);
});

test("out-of-scope: allow file, allow folder, block", async () => {
  const s = await setup({}, ["Allow this file", "Allow the whole folder", "Block"]);
  assert.equal(await s.run("write", { path: "src/b.ts", content: "" }), undefined);
  assert.deepEqual((await readTask(s.root))!.allowedExtra, ["src/b.ts"]);
  assert.equal(await s.run("write", { path: path.join(s.root, "lib/c.ts"), content: "" }), undefined);
  assert.deepEqual((await readTask(s.root))!.allowedExtra, ["src/b.ts", "lib/"]);
  const r: any = await s.run("edit", { path: "other/d.ts", edits: [] });
  assert.equal(r.block, true);
  assert.match(r.reason, /plan/);
});

test("a file in the project root is offered no whole-folder option; a nested one is", async () => {
  const s = await setup({}, []);
  const offered: string[][] = [];
  (s.ui as any).select = async (_title: string, options: string[]) => (offered.push(options), "Allow this file");
  assert.equal(await s.run("write", { path: "CHANGELOG.md", content: "" }), undefined);
  assert.equal(await s.run("write", { path: "src/b.ts", content: "" }), undefined);
  assert.deepEqual(offered, [["Allow this file", "Block"], ["Allow this file", "Allow the whole folder", "Block"]]);
});

test("npm add: ADR on approve, block otherwise", async () => {
  const s = await setup({}, ["Approve and record ADR", "Block"]);
  assert.equal(await s.run("bash", { command: "npm add zod" }), undefined);
  const adr = (await fs.readdir(path.join(s.root, "docs/adr")))[0];
  assert.match(await fs.readFile(path.join(s.root, "docs/adr", adr), "utf8"), /Add dependency zod[\s\S]*Add thing[\s\S]*npm add zod/);
  assert.equal(((await s.run("bash", { command: "pip install flask" })) as any).block, true);
  assert.equal(await s.run("bash", { command: "npm install" }), undefined);
});

test("a migration approved in one task is asked again in another", async () => {
  const s = await setup({}, ["Allow this file", "Approve", "Allow this file", "Approve"]);
  assert.equal(await s.run("write", { path: "db/migrate/1.rb", content: "" }), undefined);
  await writeTask(s.root, task({ id: "2" }));
  assert.equal(await s.run("write", { path: "db/migrate/1.rb", content: "" }), undefined);
  assert.equal(s.ui.asked.length, 4);
});

test("an unparsable manifest edit asks for approval but writes no ADR", async () => {
  const s = await setup({ "package.json": "{}" }, ["Allow this file", "Approve and record ADR"]);
  const r = await s.run("edit", { path: "package.json", edits: [{ oldText: "nope", newText: "x" }] });
  assert.equal(r, undefined);
  assert.equal(await fs.readdir(path.join(s.root, "docs/adr")).catch(() => []).then((f) => f.length), 0);
});

test("package.json edits: new dep prompts, unchanged deps do not", async () => {
  const pkg = JSON.stringify({ dependencies: { a: "1" } });
  const s = await setup({ "package.json": pkg }, ["Allow this file", "Approve and record ADR", "Block"]);
  const write = (deps: object) => s.run("write", { path: "package.json", content: JSON.stringify({ dependencies: deps }) });
  assert.equal(await write({ a: "1", b: "2" }), undefined);
  assert.equal((await fs.readdir(path.join(s.root, "docs/adr"))).length, 1);
  assert.equal(s.ui.asked.length, 2);
  assert.equal(await write({ a: "2" }), undefined);
  assert.equal(s.ui.asked.length, 2);
  const r: any = await s.run("edit", { path: "package.json", edits: [{ oldText: '"a":"1"', newText: '"a":"1","c":"1"' }] });
  assert.equal(r.block, true);
  assert.match(s.ui.asked.at(-1)!, /c/);
});

test("migration asks once per file", async () => {
  const s = await setup({}, ["Allow this file", "Approve", "Allow this file", "Block"]);
  assert.equal(await s.run("write", { path: "db/migrate/1.rb", content: "" }), undefined);
  assert.equal(await s.run("write", { path: "db/migrate/1.rb", content: "x" }), undefined);
  assert.equal(s.ui.asked.length, 2);
  assert.equal(((await s.run("write", { path: "q.sql", content: "" })) as any).block, true);
});
