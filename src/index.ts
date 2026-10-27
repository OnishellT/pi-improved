import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUser } from "./ask.ts";
import { registerBasePrompt } from "./base-prompt.ts";
import { registerDoctor } from "./doctor.ts";
import { registerGate } from "./gate.ts";
import { registerContextGuard } from "./context-guard.ts";
import { registerGuards } from "./guards.ts";
import { registerLearn } from "./learn.ts";
import { registerModels } from "./models.ts";
import { registerPhaseTools } from "./phase-tools.ts";
import { registerPr } from "./pr.ts";
import { registerSkills } from "./skills.ts";
import { registerSetup } from "./setup.ts";
import { loadBundledSubagent } from "./subagent-ext.ts";
import { registerTask } from "./task.ts";
import { registerTelemetry } from "./telemetry.ts";
import { registerTriggers } from "./triggers.ts";

export default async function (pi: ExtensionAPI) {
  await loadBundledSubagent(pi).catch(() => undefined);
  // Children work for the parent (pi-subagent sets this in every child): no setup offers, gates or prompts nobody can answer.
  if (process.env.PI_SUBAGENT_RUN_DIR) return;
  registerAskUser(pi);
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
  registerPhaseTools(pi);
  registerPr(pi);
  registerTelemetry(pi);
  registerContextGuard(pi);
}
