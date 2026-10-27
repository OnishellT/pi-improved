import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAbortCleanup } from "./abort.ts";
import { registerAskUser } from "./ask.ts";
import { registerBasePrompt } from "./base-prompt.ts";
import { registerDoctor } from "./doctor.ts";
import { registerGate } from "./gate.ts";
import { registerContextGuard } from "./context-guard.ts";
import { registerGuards } from "./guards.ts";
import { registerLearn } from "./learn.ts";
import { registerModels } from "./models.ts";
import { registerPr } from "./pr.ts";
import { registerSkills } from "./skills.ts";
import { registerSetup } from "./setup.ts";
import { loadBundledSubagent } from "./subagent-ext.ts";
import { registerSubagentView } from "./subagent-view.ts";
import { registerTask } from "./task.ts";
import { registerTelemetry } from "./telemetry.ts";
import { registerTriggers } from "./triggers.ts";

export default async function (pi: ExtensionAPI) {
  const subagent = await loadBundledSubagent(pi).catch(() => undefined);
  // Children work for the parent (pi-subagent sets this in every child): no setup offers, gates or prompts nobody can answer.
  if (process.env.PI_SUBAGENT_RUN_DIR) return;
  registerAskUser(pi);
  registerAbortCleanup(pi);
  registerSubagentView(pi, subagent === "bundled");
  registerDoctor(pi);
  registerBasePrompt(pi);
  registerModels(pi);
  registerSkills(pi);
  registerSetup(pi);
  registerTask(pi);
  // Order matters for `tool_call`: Pi runs handlers in registration order and stops at the first block, so guards come before the triggers' dialogs.
  registerGuards(pi);
  registerTriggers(pi);
  registerGate(pi);
  registerLearn(pi);
  // Sessions saved when these tools were toggled per phase come back with them inactive; turn them on once.
  // Only on resume or fork: new sessions already have them, and a startup `--tools` list stays as given.
  pi.on("session_start", (event) => {
    if (event.reason !== "resume" && event.reason !== "fork") return;
    const active = pi.getActiveTools();
    const missing = ["setup_finish", "task_plan"].filter((t) => !active.includes(t));
    if (missing.length) pi.setActiveTools([...active, ...missing]);
  });
  registerPr(pi);
  registerTelemetry(pi);
  registerContextGuard(pi);
}
