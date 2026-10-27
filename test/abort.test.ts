import assert from "node:assert/strict";
import { test } from "node:test";
import { activeHandles } from "../src/abort.ts";

test("an aborted run stops only the children that are still working", () => {
  const listing = [
    "repo-facts (756287)  busy      opencode-go/deepseek-v4.1-flash  low",
    "review (92e070)  starting  opencode-go/deepseek-v4.1-flash  low",
    "done (a1b2c3)  idle      opencode-go/deepseek-v4.1-flash  low",
    "ffeedd  busy      opencode-go/deepseek-v4.1-flash  low",
    "gone (123abc)  exited    opencode-go/deepseek-v4.1-flash  low",
  ].join("\n");
  assert.deepEqual(activeHandles(listing), ["756287", "92e070", "ffeedd"]);
  assert.deepEqual(activeHandles("No subagents\n"), []);
});
