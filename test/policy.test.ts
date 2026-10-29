import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVE, resolvePolicyFailure } from "../src/policy.ts";
import { fakeUI } from "./helpers.ts";

function setup(opts: { remaining: () => boolean; reason?: string }) {
  const calls: string[][] = [];
  const pi: any = {
    exec: async (_cmd: string, args: string[]) => {
      calls.push(args);
      const rest = args.slice(4);
      if (rest[0] === "next") return { code: 0, stdout: JSON.stringify(opts.remaining() ? { remaining: 1, selector: "sel", finding: { ruleTitle: "Money review", file: "src/a.js", line: 3, message: "check it" } } : { remaining: 0 }) };
      return { code: 0, stdout: "" };
    },
  };
  const ctx: any = { cwd: "/p", ui: fakeUI([APPROVE, ...Array(11).fill(opts.reason ?? "because")]) };
  return { pi, ctx, calls };
}

test("reason and selector reach agentlint as argv, never inside the shell string", async () => {
  let left = 1;
  const t = setup({ remaining: () => left > 0, reason: "a $HOME `x` b" });
  t.pi.exec = ((orig) => async (c: string, a: string[]) => ((a[4] === "approve" && (left = 0)), orig(c, a)))(t.pi.exec);
  assert.equal(await resolvePolicyFailure(t.pi, t.ctx, { agentlint: "lint" } as any, "report"), "approved");
  const approve = t.calls.find((a) => a[4] === "approve")!;
  assert.deepEqual(approve.slice(4), ["approve", "--reason", "a $HOME `x` b", "sel"]);
  assert.ok(!approve[1].includes("$HOME"));
  assert.match(approve[3], /^human:/);
});

test("a selector that comes back after its approve stops with a message instead of looping", async () => {
  const t = setup({ remaining: () => true });
  const notes: string[] = [];
  t.ctx.ui.notify = (m: string) => notes.push(m);
  assert.equal(await resolvePolicyFailure(t.pi, t.ctx, { agentlint: "lint" } as any, "report"), "failed");
  assert.equal(t.calls.filter((a) => a[4] === "approve").length, 1);
  assert.ok(notes.some((n) => /src\/a\.js:3 after it was accepted/.test(n)));
});

test("no open finding to accept is a failure, not an approval that would rerun the same failing verify", async () => {
  const t = setup({ remaining: () => false });
  const notes: string[] = [];
  t.ctx.ui.notify = (m: string) => notes.push(m);
  assert.equal(await resolvePolicyFailure(t.pi, t.ctx, { agentlint: "lint" } as any, "report"), "failed");
  assert.equal(t.calls.filter((a) => a[4] === "approve").length, 0);
  assert.ok(notes.some((n) => /no open finding/.test(n)));
});

test("any number of distinct findings is accepted, with no fixed cap", async () => {
  let left = 12;
  const t = setup({ remaining: () => left > 0 });
  t.pi.exec = async (_c: string, a: string[]) => {
    t.calls.push(a);
    if (a[4] === "next") return { code: 0, stdout: JSON.stringify(left ? { remaining: left, selector: "1", finding: { file: "src/a.js", line: left, message: "m" } } : { remaining: 0 }) };
    if (a[4] === "approve") left--;
    return { code: 0, stdout: "" };
  };
  t.ctx.ui = fakeUI([APPROVE, ...Array(12).fill("because")]);
  assert.equal(await resolvePolicyFailure(t.pi, t.ctx, { agentlint: "lint" } as any, "report"), "approved");
  assert.equal(t.calls.filter((a) => a[4] === "approve").length, 12);
});

test("each finding is shown and gets its own reason; an empty reason hands the rest to the model", async () => {
  let left = 2;
  const t = setup({ remaining: () => left > 0 });
  t.pi.exec = ((orig) => async (c: string, a: string[]) => {
    if (a[4] === "approve") left--;
    const r = await orig(c, a);
    return a[4] === "next" && left ? { ...r, stdout: r.stdout.replace('"line":3', `"line":${3 + left}`) } : r;
  })(t.pi.exec);
  t.ctx.ui = fakeUI([APPROVE, "first reason", ""]);
  assert.equal(await resolvePolicyFailure(t.pi, t.ctx, { agentlint: "lint" } as any, "report"), "fix");
  assert.match(t.ctx.ui.asked[1], /Money review\nsrc\/a\.js:5: check it/);
  assert.deepEqual(t.calls.filter((a) => a[4] === "approve").map((a) => a[6]), ["first reason"]);
});
