import assert from "node:assert/strict";
import { test } from "node:test";
import { OTHER, registerAskUser, selectOrType } from "../src/ask.ts";
import { fakePi, fakeUI } from "./helpers.ts";

test("selectOrType returns the picked option, the typed text, or undefined on cancel", async () => {
  assert.equal(await selectOrType({ ui: fakeUI(["a"]) }, "Q?", ["a", "b"]), "a");
  assert.equal(await selectOrType({ ui: fakeUI([OTHER, "mine"]) }, "Q?", ["a", "b"]), "mine");
  assert.equal(await selectOrType({ ui: fakeUI([undefined]) }, "Q?", ["a", "b"]), undefined);
});

test("ask_user takes an open question (no options) as typed text, and keeps the options path", async () => {
  const { pi, tools } = fakePi();
  registerAskUser(pi);
  const ui = fakeUI(["b", "Cache it per request"]);
  const result = await tools.get("ask_user").execute("1", { questions: [{ question: "Which?", options: ["a", "b"] }, { question: "How would you approach it?" }] }, undefined, undefined, { hasUI: true, ui });
  assert.deepEqual(result.details.answers.map((a: any) => a.answer), ["b", "Cache it per request"]);
  assert.deepEqual(ui.asked, ["(1/2) Which?", "(2/2) How would you approach it?"]);
});

test("backing out of the typed answer shows that question's options again; the next questions still come", async () => {
  assert.equal(await selectOrType({ ui: fakeUI([OTHER, undefined, "b"]) }, "Q?", ["a", "b"]), "b");
  const { pi, tools } = fakePi();
  registerAskUser(pi);
  const ui = fakeUI([OTHER, undefined, "a", "y"]);
  const result = await tools.get("ask_user").execute("1", { questions: [{ question: "Which?", options: ["a", "b"] }, { question: "Then?", options: ["x", "y"] }] }, undefined, undefined, { hasUI: true, ui });
  assert.deepEqual(result.details.answers.map((a: any) => a.answer), ["a", "y"]);
  assert.doesNotMatch(result.content[0].text, /skipped/);
});

test("ask_user without a UI tells the agent to choose and say so, not to write notes in the docs", async () => {
  const { pi, tools } = fakePi();
  registerAskUser(pi);
  await assert.rejects(tools.get("ask_user").execute("1", { questions: [{ question: "Which?", options: ["a", "b"] }] }, undefined, undefined, { hasUI: false, ui: fakeUI([]) }), (e: Error) => {
    assert.match(e.message, /fits AGENTS\.md and the ADRs/);
    assert.match(e.message, /final summary/);
    return true;
  });
});
