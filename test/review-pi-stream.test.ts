import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiStream } from "../scripts/review/pi-stream.ts";

const event = (value: unknown) => JSON.stringify(value);
const assistant = (text: string, tokens: number, cost: number) =>
  event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text },
      ],
      usage: { totalTokens: tokens, cost: { total: cost } },
    },
  });

test("takes the text of the last assistant message and sums usage", () => {
  const stream = [
    event({ type: "agent_start" }),
    assistant("looking", 100, 0.001),
    event({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "x" }] },
    }),
    "not json",
    assistant("final answer", 50, 0.002),
    event({ type: "agent_settled" }),
  ].join("\n");
  assert.deepEqual(parsePiStream(stream), {
    text: "final answer",
    usage: { tokens: 150, costUsd: 0.003 },
  });
});

test("an empty stream yields empty text", () => {
  assert.equal(parsePiStream("").text, "");
});
