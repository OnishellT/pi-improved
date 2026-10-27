import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePolicyFailure } from "../src/policy.ts";
import { fakeUI } from "./helpers.ts";

function setup(opts: { remaining: () => boolean; reason?: string }) {
  const calls: string[][] = [];
  const pi: any = {
    exec: async (_cmd: string, args: string[]) => {
      calls.push(args);
      const rest = args.slice(4);
      if (rest[0] === "next") return { code: 0, stdout: JSON.stringify(opts.remaining() ? { remaining: 1, selector: "sel" } : { remaining: 0 }) };
      return { code: 0, stdout: "" };
    },
  };
  const ctx: any = { cwd: "/p", ui: fakeUI(["Approve the exception", opts.reason ?? "because"]) };
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

test("after the approval cap the findings are rechecked: leftovers are a failure", async () => {
  const t = setup({ remaining: () => true });
  assert.equal(await resolvePolicyFailure(t.pi, t.ctx, { agentlint: "lint" } as any, "report"), "failed");
  assert.equal(t.calls.filter((a) => a[4] === "approve").length, 10);
});
