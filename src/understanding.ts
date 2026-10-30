import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { completeTask, treeSnapshot, UNREADABLE } from "./gate.ts";
import { readTask } from "./task-state.ts";
import { recordUnderstanding } from "./telemetry.ts";

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
      if (task?.status !== "implementing" || !task.understanding) throw new Error("No understanding check is pending.");
      // Code changed during the check closes only after verify passes on it (the gate then asks for this call again).
      const tree = await treeSnapshot(pi, ctx.cwd);
      if (tree === UNREADABLE) throw new Error("git could not read the working tree, so the verified code cannot be confirmed. /task done closes the task.");
      if (tree !== task.understanding.tree) throw new Error("The code changed during the check. End your turn so verify checks it; then call understanding_done again.");
      // Before the task is marked done: telemetry records into the active task only.
      await recordUnderstanding(ctx.cwd, skipped ? "skipped" : "done", skipped ? 0 : gaps.length);
      await completeTask(pi, ctx);
      return { content: [{ type: "text", text: "Recorded. The task is done." }], details: { skipped, gaps } };
    },
  });
}
