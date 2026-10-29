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
import { exposeSubagent, nixExec } from "./nix.ts";
import type { Exec } from "./git.ts";
import { registerPr } from "./pr.ts";
import { registerSkills } from "./skills.ts";
import { registerSetup } from "./setup.ts";
import { registerShow } from "./show.ts";
import { globalProblem } from "./config.ts";
import { migrateGlobal, migrateProject } from "./legacy-config.ts";
import { loadBundledSubagent } from "./subagent-ext.ts";
import { registerSubagentView } from "./subagent-view.ts";
import { registerTask } from "./task.ts";
import { registerTelemetry } from "./telemetry.ts";
import { registerTriggers } from "./triggers.ts";

/** `pi` whose `exec` puts the Nix git, gh, bash and tmux first on the PATH of the commands that need them. */
function withNix(pi: ExtensionAPI): ExtensionAPI {
  const exec = nixExec(pi.exec.bind(pi) as Exec) as unknown as ExtensionAPI["exec"];
  return new Proxy(pi, {
    get(target, key) {
      if (key === "exec") return exec;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const TMUX_WAIT = 30_000;

export default async function (rawPi: ExtensionAPI) {
  const pi = withNix(rawPi);
  const subagent = await loadBundledSubagent(pi).catch(() => undefined);
  // The first Nix build of tmux can take minutes: start it now, and make only a bash call wait for it. Children never start panes.
  const child = !!process.env.PI_SUBAGENT_RUN_DIR;
  const exposed = !child && (subagent === "bundled" || subagent === "global") ? exposeSubagent(undefined, undefined, undefined, subagent === "bundled") : undefined;
  // A bash call waits for the build only so long: after that it runs with the system tmux, if there is one.
  if (exposed) pi.on("tool_call", async (event) => void (event.toolName === "bash" && (await Promise.race([exposed, new Promise((resolve) => setTimeout(resolve, TMUX_WAIT).unref())]))));
  // Children work for the parent (pi-subagent sets this in every child): no setup offers, gates or prompts nobody can answer.
  if (process.env.PI_SUBAGENT_RUN_DIR) return;
  // Settings that used to live in other files (computer.json, self-compact.json, pi's settings.json) are copied into the config files before anything reads them.
  const moved = migrateGlobal();
  pi.on("session_start", (_event, ctx) => {
    const notices = [...moved.splice(0), ...migrateProject(ctx.cwd)];
    // readManifest treats an unreadable global file as empty; say so once per session, and why.
    const broken = globalProblem();
    if (broken) notices.push(`${broken}. It is ignored until fixed: only the project's .pi/workflow.json applies. /doctor shows the same.`);
    if (notices.length) ctx.hasUI ? ctx.ui.notify(notices.join("\n"), "info") : console.error(`[pi-improved] ${notices.join(" ")}`);
  });
  registerAskUser(pi);
  registerShow(pi);
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
