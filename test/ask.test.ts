import assert from "node:assert/strict";
import { test } from "node:test";
import { OTHER, selectOrType } from "../src/ask.ts";
import { fakeUI } from "./helpers.ts";

test("selectOrType returns the picked option, the typed text, or undefined on cancel", async () => {
  assert.equal(await selectOrType({ ui: fakeUI(["a"]) }, "Q?", ["a", "b"]), "a");
  assert.equal(await selectOrType({ ui: fakeUI([OTHER, "mine"]) }, "Q?", ["a", "b"]), "mine");
  assert.equal(await selectOrType({ ui: fakeUI([undefined]) }, "Q?", ["a", "b"]), undefined);
});
