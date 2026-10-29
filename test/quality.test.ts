import assert from "node:assert/strict";
import { test } from "node:test";
import { BREAK, collectDiffs, commentedOutCode, commitSubject, isFixTask, mayCommit, parseDiff, qualityVerdict, reviewWarnings, swallowedErrors, weakening } from "../src/quality.ts";
import { isTestFile } from "../src/risk.ts";

const bools = [false, true];

test("qualityVerdict: every combination of its facts", () => {
  for (const fix of bools) for (const source of bools) for (const tests of bools) for (const weakened of bools) for (const over of bools) {
    const reasons = qualityVerdict({ fix, source, tests, weakened, lines: over ? 501 : 500, cap: 500 });
    assert.equal(reasons.some((r) => /no test/.test(r)), fix && source && !tests, JSON.stringify({ fix, source, tests }));
    assert.equal(reasons.some((r) => /weakened/.test(r)), weakened);
    assert.equal(reasons.some((r) => /cap 500/.test(r)), over);
    assert.equal(reasons.length, +(fix && source && !tests) + +weakened + +over);
  }
});

test("qualityVerdict passes extra reasons through, so another rule can add its own", () => {
  assert.deepEqual(qualityVerdict({ fix: false, source: false, tests: false, weakened: false, lines: 0, cap: 1, extra: ["laws edited"] }), ["laws edited"]);
});

test("mayCommit: every combination", () => {
  assert.deepEqual((["pass", "fail", "none"] as const).map(mayCommit), [true, false, true]);
});

test("isFixTask reads the request and the intent, not the plan summary", () => {
  const plan = (o: any) => ({ summary: "", steps: [], files: [], decisions: [], interface: [], seams: [], ...o });
  assert.equal(isFixTask({ title: "Fix the parser crash on empty input", plan: undefined }), true);
  assert.equal(isFixTask({ title: "Add a CSV export", body: "Users hit a bug when exporting", plan: undefined }), true);
  assert.equal(isFixTask({ title: "Add a CSV export", plan: plan({ intent: "Regression: totals are wrong" }) }), true);
  assert.equal(isFixTask({ title: "Add fixtures for the prefix parser", plan: plan({ summary: "fix up the docs" }) }), false);
  assert.equal(isFixTask(undefined), false);
});

test("parseDiff splits files, keeps '-- ' lines as removed text and marks non-adjacent runs", () => {
  const diff = [
    "diff --git a/a.py b/a.py", "index 1..2 100644", "--- a/a.py", "+++ b/a.py", "@@ -1,2 +1,2 @@", "--- old sql comment", "+new1", "+new2", "@@ -9 +9 @@", "+new3",
    "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/n.ts b/n.ts", "new file mode 100644", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1 @@", "+x", "",
  ].join("\n");
  assert.deepEqual(parseDiff(diff), [
    { file: "a.py", added: ["new1", "new2", BREAK, "new3"], removed: ["-- old sql comment"] },
    { file: "gone.ts", added: [], removed: ["bye"] },
    { file: "n.ts", added: ["x"], removed: [] },
  ]);
});

test("weakening: lost assertions net of added ones, and skip/only/xfail/retry markers", () => {
  assert.deepEqual(weakening(["expect(a).toBe(2)"], ["expect(a).toBe(1)"]), { lost: 0, markers: [] });
  assert.equal(weakening([], ["assert x == 1", "self.assertEqual(a, b)"]).lost, 2);
  assert.equal(weakening(["assert x == 1"], ["assert x == 1", "assert y"]).lost, 1);
  for (const line of ["it.skip('x', () => {})", "@pytest.mark.xfail", "@pytest.mark.skip(reason='x')", "t.Skip(\"later\")", "#[ignore]", "describe.only('x')", "@Disabled", "jest.retryTimes(3)", "xit('x')"]) assert.equal(weakening([line], []).markers.length, 1, line);
  assert.deepEqual(weakening(["test('adds', () => { expect(add(1, 2)).toBe(3) })", "// we expect nothing odd"], []), { lost: 0, markers: [] });
});

test("swallowedErrors: empty, log-only and TODO handlers across languages; handled errors pass", () => {
  const bad: string[][] = [
    ["try { f() } catch (e) {}"], ["} catch (e) {", "}"], ["catch (Exception e) {", "    e.printStackTrace()", "}"],
    ["except Exception:", "    pass"], ["except ValueError: pass"], ["except:", "    print(e)"], ["promise.catch(() => {})"], ["_ = err"], ["let _ = write();"], ["foo().ok();"], ["rm x || true"],
    ["if err != nil {", "}"], ["if err != nil {", "  log.Println(err)", "}"], ["rescue => e", "end"], ["} catch (e) {", "  // TODO handle", "}"],
  ];
  for (const lines of bad) assert.ok(swallowedErrors(lines).length >= 1, lines.join(" / "));
  const good = [["} catch (e) {", "  throw new Error('bad', { cause: e })", "}"], ["except KeyError as e:", "    raise ConfigError(str(e)) from e"], ["if err != nil {", "  return err", "}"], ["} catch (e) {", BREAK, "}"]];
  for (const lines of good) assert.deepEqual(swallowedErrors(lines), [], lines.join(" / "));
});

test("commentedOutCode: code in comments, not prose, directives or shebangs", () => {
  const bad = ["// const x = compute(a, b);", "# print(value)", "  // if (ready) {", "# return total;", "-- SELECT_ME(x);", "// foo.bar(baz)"];
  for (const l of bad) assert.equal(commentedOutCode([l]).length, 1, l);
  const good = ["// Returns the total for the cart", "#!/usr/bin/env python", "// eslint-disable-next-line no-console", "# type: ignore", "// TODO: remove (later)", "// see https://example.com/a?b=c", "const x = 1;"];
  for (const l of good) assert.deepEqual(commentedOutCode([l]), [], l);
});

test("reviewWarnings: a clean diff gives nothing; findings are listed per kind and capped", () => {
  assert.deepEqual(reviewWarnings([{ file: "a.ts", added: ["const a = 1;"], removed: [] }], isTestFile), []);
  const dirty = [{ file: "a.ts", added: ["} catch (e) {}", "// const x = 1;"], removed: [] }, { file: "a.test.ts", added: ["it.skip('x')"], removed: ["expect(a).toBe(1)"] }, { file: "README.md", added: ["// const y = 2;"], removed: [] }];
  const out = reviewWarnings(dirty, isTestFile).join("\n");
  assert.match(out, /swallowed errors[\s\S]*a\.ts: \} catch/);
  assert.match(out, /Commented-out code[\s\S]*a\.ts: \/\/ const x/);
  assert.doesNotMatch(out, /README\.md/);
  assert.match(out, /a\.test\.ts: 1 assertion removed[\s\S]*marker/);
  const many = reviewWarnings([{ file: "a.ts", added: Array.from({ length: 8 }, () => "x || true"), removed: [] }], isTestFile).join("\n");
  assert.match(many, /and 3 more/);
});

test("commitSubject: at most 72 characters, no trailing period or ellipsis, prefix counted", () => {
  assert.equal(commitSubject("Add retries to the uploader."), "Add retries to the uploader");
  assert.equal(commitSubject("Fix it…"), "Fix it");
  assert.equal(commitSubject("Fix it\n\nlong body"), "Fix it");
  const long = commitSubject("Make the importer accept every spreadsheet format the finance team uses today");
  assert.ok(long.length <= 72 && !long.endsWith(" "), long);
  const prefixed = commitSubject("Make the importer accept every spreadsheet format the finance team uses today", "[ABC-123] ");
  assert.ok(prefixed.length <= 72 && prefixed.startsWith("[ABC-123] "), prefixed);
  assert.equal(commitSubject(""), "");
});

test("collectDiffs reads a real repo: changes, new files, no generated paths", async () => {
  const { execFileSync } = await import("node:child_process");
  const { tempProject } = await import("./helpers.ts");
  const fsp = await import("node:fs/promises");
  const root = await tempProject({ "a.py": "x = 1\n", "package-lock.json": "{}\n" });
  const run = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, stdio: "pipe" });
  run("init", "-q"); run("add", "."); run("commit", "-qm", "init");
  await fsp.writeFile(`${root}/a.py`, "x = 2\ntry:\n    f()\nexcept Exception:\n    pass\n");
  await fsp.writeFile(`${root}/package-lock.json`, `${"{}".repeat(100)}\n`);
  await fsp.writeFile(`${root}/new.py`, "y = 1\n");
  const exec: any = async (cmd: string, args: string[], o: any) => {
    try { return { stdout: execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8" }), stderr: "", code: 0, killed: false }; } catch (e: any) { return { stdout: "", stderr: String(e), code: e.status ?? 1, killed: false }; }
  };
  const diffs = await collectDiffs(exec, root, "HEAD");
  assert.deepEqual(diffs.map((d) => d.file).sort(), ["a.py", "new.py"]);
  assert.equal(swallowedErrors(diffs.find((d) => d.file === "a.py")!.added).length, 1);
});
