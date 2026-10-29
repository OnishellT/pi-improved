import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { addedPackagesFromCommand, applyEdits, dependencyNames, isMigration, registerTriggers, toRelative } from "../src/triggers.ts";
import { readTask, updateTask, writeTask, type Task } from "../src/task-state.ts";
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
  assert.deepEqual(addedPackagesFromCommand("npm install ./lib"), ["./lib"], "a local path install adds a dependency");
  assert.deepEqual(addedPackagesFromCommand("npm install ./lib=prod file:../x=y"), ["./lib=prod", "file:../x=y"], "a local path is kept whole");
  assert.deepEqual(addedPackagesFromCommand("pip install . && pip install ./"), [], "the project itself");
});

test("dependencyNames", () => {
  assert.deepEqual([...dependencyNames("package.json", '{"dependencies":{"a":"1"},"devDependencies":{"b":"1"}}')!], ["a", "b"]);
  assert.equal(dependencyNames("package.json", "{bad"), undefined);
  assert.deepEqual([...dependencyNames("requirements.txt", "Flask>=2\n# c\nrequests\n")!], ["flask", "requests"]);
  assert.deepEqual([...dependencyNames("go.mod", "module x\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n")!], ["github.com/a/b"]);
  assert.deepEqual([...dependencyNames("Cargo.toml", '[package]\nname="x"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies.foo]\nversion="1"\n')!].sort(), ["foo", "serde", "tokio"]);
  const py = '[project]\nname = "x"\ndependencies = [\n  "requests>=2",\n  "flask",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n';
  assert.deepEqual([...dependencyNames("pyproject.toml", py)!].sort(), ["flask", "pytest", "requests"]);
  assert.deepEqual([...dependencyNames("Cargo.toml", '[dependencies]\n"serde" = "1"\n[dependencies."tokio"]\nversion = "1"\n')!].sort(), ["serde", "tokio"], "quoted keys");
  assert.deepEqual([...dependencyNames("pyproject.toml", '[tool.poetry.dependencies]\n"flask" = "^2"\n[dependency-groups]\n"dev" = ["pytest"]\n')!].sort(), ["flask", "pytest"], "quoted keys");
  assert.deepEqual([...dependencyNames("pyproject.toml", '[project]\n"dependencies" = ["flask"]\n')!], ["flask"], "quoted keys");
  assert.deepEqual([...dependencyNames("Cargo.toml", '["dependencies"]\nserde = "1"\n["dev-dependencies"."foo"]\nversion = "1"\n')!].sort(), ["foo", "serde"], "quoted table headers");
  assert.deepEqual([...dependencyNames("Cargo.toml", '["dependencies" . "serde"]\nversion = "1"\n')!], ["serde"], "spaces around a header's dots");
  assert.deepEqual([...dependencyNames("Cargo.toml", '["dependencies.serde"]\nversion = "1"\n')!], [], "a quoted dotted name is one key, not a table path");
  assert.equal(dependencyNames("Cargo.toml", '["dependenc\\u0069es"]\nserde = "1"\n'), undefined, "an escape in a header cannot be checked");
  assert.equal(dependencyNames("pyproject.toml", '[tool.poetry.dependencies]\n"fl\\u0061sk" = "^2"\n'), undefined, "nor in a key");
  assert.deepEqual([...dependencyNames("requirements.txt", "Flask\n-r Other.txt\n")!], ["flask", "-r Other.txt"], "an include is an entry, its path keeps its case");
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

async function headless(files: Record<string, string>, t: Task | null = task()) {
  const s = await setup(files, [], t);
  const { pi, emit } = fakePi();
  registerTriggers(pi);
  const ctx: any = { cwd: s.root, hasUI: false, ui: fakeUI([]) };
  return (toolName: string, input: any) => emit("tool_call", { toolName, input }, ctx) as Promise<any>;
}

test("headless: a new dependency is denied with a reason, even one the plan's manifest allows; the other gates stay off", async () => {
  const run = await headless({ "package.json": '{"dependencies":{"a":"1"}}', "src/a.ts": "" });
  const bash = await run("bash", { command: "npm install left-pad" });
  assert.equal(bash.block, true);
  assert.match(bash.reason, /left-pad needs approval, and nobody is here to approve it/);
  const edit = await run("write", { path: "package.json", content: '{"dependencies":{"a":"1","b":"2"}}' });
  assert.match(edit.reason, /dependency b needs approval/);
  assert.equal(await run("write", { path: "package.json", content: '{"dependencies":{"a":"2"}}' }), undefined, "no new name");
  assert.match((await run("write", { path: "package.json", content: "{bad" })).reason, /cannot be checked/);
  assert.match((await run("write", { path: "Cargo.toml", content: '["dependenc\\u0069es"]\nserde = "1"\n' })).reason, /cannot be checked/);
  assert.equal(await run("bash", { command: "npm install" }), undefined);
  assert.equal(await run("write", { path: "other/x.ts", content: "" }), undefined, "scope gate is still off");
  assert.equal(await run("write", { path: "db/migrate/1.rb", content: "" }), undefined, "migration gate is still off");
  const planned = await headless({ "package.json": "{}" }, task({ plan: { ...task().plan!, files: ["src/a.ts", "package.json"] } }));
  assert.equal((await planned("bash", { command: "npm install left-pad" })).block, true);
  assert.equal((await planned("write", { path: "package.json", content: '{"dependencies":{"b":"2"}}' })).block, true);
  assert.equal((await run("write", { path: "@package.json", content: '{"dependencies":{"b":"2"}}' })).block, true, "the tool strips a leading @");
  const idle = await headless({}, task({ status: "planning" }));
  assert.equal(await idle("bash", { command: "npm install left-pad" }), undefined);
});

test("a write through a symlink is checked by the link's name and by its target's", async () => {
  const s = await setup({ "package.json": "{}", "config/deps.json": "{}" }, ["Allow this file", "Block", "Allow this file", "Block"]);
  await fs.symlink("package.json", path.join(s.root, "deps.json"));
  const r: any = await s.run("write", { path: "deps.json", content: '{"dependencies":{"b":"2"}}' });
  assert.equal(r.block, true);
  assert.match(s.ui.asked.at(-1)!, /New dependency in package\.json: b/);
  await fs.mkdir(path.join(s.root, "app"));
  await fs.symlink("../config/deps.json", path.join(s.root, "app/package.json"));
  const named: any = await s.run("write", { path: "app/package.json", content: '{"dependencies":{"c":"2"}}' });
  assert.equal(named.block, true);
  assert.match(s.ui.asked.at(-1)!, /New dependency in app\/package\.json: c/);
});

test("a symlink is read as each manifest it is named as, and is exempt only when both names are", async () => {
  const s = await setup({ "requirements.txt": "", "docs/adr/x.json": "{}" }, ["Allow this file", "Block", "Allow this file", "Block"]);
  await fs.symlink("requirements.txt", path.join(s.root, "package.json"));
  const both: any = await s.run("write", { path: "package.json", content: '{"dependencies":{"b":"2"}}' });
  assert.equal(both.block, true);
  assert.match(s.ui.asked.at(-1)!, /New dependency in requirements\.txt, package\.json: b/, "read as package.json too");
  await fs.mkdir(path.join(s.root, "app"));
  await fs.symlink("../docs/adr/x.json", path.join(s.root, "app/package.json"));
  const adr: any = await s.run("write", { path: "app/package.json", content: '{"dependencies":{"c":"2"}}' });
  assert.equal(adr.block, true);
  assert.match(s.ui.asked.at(-1)!, /New dependency in app\/package\.json: c/);
});

test("the approval names a local operand in full", async () => {
  const s = await setup({}, ["Block"]);
  assert.equal(((await s.run("bash", { command: "npm install ./lib=prod" })) as any).block, true);
  assert.match(s.ui.asked[0], /Install new package: \.\/lib=prod$/);
});

test("a symlink in a planned folder does not bring its outside target into scope", async () => {
  const s = await setup({ "config/production.json": "{}" }, ["Block"], task({ plan: { ...task().plan!, files: ["src/"] } }));
  await fs.mkdir(path.join(s.root, "src"));
  await fs.symlink("../config", path.join(s.root, "src/config"));
  const r: any = await s.run("write", { path: "src/config/production.json", content: "{}" });
  assert.equal(r.block, true);
  assert.match(s.ui.asked[0], /outside the plan: config\/production\.json/);
});

test("a planned symlink stays in scope; an approved dependency edit still meets the migration gate", async () => {
  const s = await setup({ "src/real.ts": "", "db/migrate/1.json": "{}" }, ["Approve and record ADR", "Block"]);
  await fs.symlink("real.ts", path.join(s.root, "src/a.ts"));
  assert.equal(await s.run("write", { path: "src/a.ts", content: "x" }), undefined);
  assert.equal(s.ui.asked.length, 0, "src/a.ts is in the plan");
  await fs.symlink("db/migrate/1.json", path.join(s.root, "package.json"));
  await updateTask(s.root, (t) => void t.allowedExtra.push("package.json", "db/"));
  const r: any = await s.run("write", { path: "package.json", content: '{"dependencies":{"b":"2"}}' });
  assert.equal(r.block, true);
  assert.match(s.ui.asked.at(-1)!, /Schema change or migration: db\/migrate\/1\.json/);
});

test("planning edits nothing: write and edit are blocked until the plan is approved", async () => {
  const s = await setup({}, [], task({ status: "planning" }));
  for (const tool of ["write", "edit"]) assert.match((await s.run(tool, { path: "src/a.ts", content: "" }))?.reason ?? "", /Planning edits nothing/);
});
