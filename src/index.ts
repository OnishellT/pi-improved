import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUser } from "./ask.ts";
import { registerDoctor } from "./doctor.ts";
import { registerGate } from "./gate.ts";
import { registerGuards } from "./guards.ts";
import { registerLearn } from "./learn.ts";
import { registerModels } from "./models.ts";
import { registerPhaseTools } from "./phase-tools.ts";
import { registerSkills } from "./skills.ts";
import { registerSetup } from "./setup.ts";
import { registerTask } from "./task.ts";
import { registerTelemetry } from "./telemetry.ts";
import { registerTriggers } from "./triggers.ts";

/** Set by pi-subagent in every child session. */
export const isSubagentChild = () => Boolean(process.env.PI_SUBAGENT_RUN_DIR);

export default function (pi: ExtensionAPI) {
  // Children work for the parent: no setup offers, gates or prompts nobody can answer.
  if (isSubagentChild()) return;
  registerAskUser(pi);
  registerDoctor(pi);
  registerModels(pi);
  registerSkills(pi);
  registerSetup(pi);
  registerTask(pi);
  registerTriggers(pi);
  registerGate(pi);
  registerLearn(pi);
  registerPhaseTools(pi);
  registerGuards(pi);
  registerTelemetry(pi);
}
