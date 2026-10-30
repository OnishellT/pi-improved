import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { UNDERSTANDING_EVENT, type UnderstandingPayload } from "./events.ts";
import { completeTask } from "./gate.ts";
import { readTask } from "./task-state.ts";

/** Ends the teach-back the gate asked for: records how it went, then completes the task the usual way. */
export function registerUnderstanding(pi: ExtensionAPI) {
  pi.registerTool({
    name: "understanding_done",
    label: "Understanding done",
    description: "Call once the understanding check is over: whether the user skipped it, and the misunderstandings it found. Completes the task.",
    parameters: Type.Object({
      skipped: Type.Boolean({ description: "The user answered skip" }),
      gaps: Type.Array(Type.String(), { description: "One line per misunderstanding the answers showed; empty when none" }),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, { skipped, gaps }, _signal, _update, ctx) {
      const task = await readTask(ctx.cwd).catch(() => undefined);
      if (task?.status !== "implementing" || task.understanding !== "asked") throw new Error("No understanding check is pending.");
      // Before the task is marked done: telemetry records into the active task only.
      pi.events.emit(UNDERSTANDING_EVENT, { root: ctx.cwd, outcome: skipped ? "skipped" : "done", gaps: skipped ? 0 : gaps.length } satisfies UnderstandingPayload);
      await completeTask(pi, ctx);
      return { content: [{ type: "text", text: "Recorded. The task is done." }], details: { skipped, gaps } };
    },
  });
}
