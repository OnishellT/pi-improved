import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CATALOG, connectorById, type ConnectorSignal } from "./connectors.ts";
import { agentlintCheck, agentlintCmd, discover, hasAgentlintConfig, isProject, type Discovery, type Run } from "./discover.ts";
import type { Exec } from "./git.ts";
import { isNixFailure } from "./nix.ts";
import { agentDir } from "./subagent-ext.ts";
import { restoreModel, usePhaseModel } from "./models.ts";
import { readManifest, updateManifest, type EnabledConnector } from "./manifest.ts";
import { phaseSkills, skillsBlock } from "./skills.ts";
import { AGENTS_MAX_LINES, SETUP_NUDGE, setupPrompt } from "./setup-prompt.ts";
import { LOCAL_STATE } from "./task-state.ts";
import { resolvePolicyFailure } from "./policy.ts";
import { checkVerifyApp } from "./verify-app.ts";
import { agentlintStepOf, formatVerify, isPolicyFailure, runVerify, verifySteps } from "./verify.ts";

const MAX_NUDGES = 2;
const START_TIMEOUT = 30_000;
const MAX_VERIFY_FAILURES = 3;
const NONE = "No more";
const DECLINE = "Don't ask again";
export const REPEAT_WARNING = "Repeating it reruns the interview and the docs on the strong setup model, which costs far more than a normal task. Do it only if the project changed a lot. Update it?";

/** Returns what is missing from the setup output; empty means complete. */
export async function checkOutputs(root: string, verify: string[], exec: Exec): Promise<string[]> {
  const problems: string[] = [];
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => undefined);
  if (agents === undefined) problems.push("AGENTS.md is missing.");
  else if (agents.split("\n").length > AGENTS_MAX_LINES) problems.push(`AGENTS.md has more than ${AGENTS_MAX_LINES} lines. Move the details into skills.`);

  const skillsDir = path.join(root, ".pi/skills");
  const skills = await fs.readdir(skillsDir).catch(() => [] as string[]);
  let valid = 0;
  for (const dir of skills) {
    const text = await fs.readFile(path.join(skillsDir, dir, "SKILL.md"), "utf8").catch(() => "");
    if (!text) continue;
    if (/^---\n[\s\S]*?\bname:\s*\S[\s\S]*?\bdescription:\s*\S[\s\S]*?\n---/.test(text)) valid++;
    else problems.push(`.pi/skills/${dir}/SKILL.md needs frontmatter with name and description.`);
  }
  const wanted = await phaseSkills(root, "setup");
  if (wanted.includes("domain-modeling") && !(await fs.access(path.join(root, "GLOSSARY.md")).then(() => true, () => false))) problems.push("GLOSSARY.md is missing.");
  if (wanted.includes("pstack-create-verification-skill")) problems.push(...(await checkVerifyApp(root, exec)));
  if (!valid) problems.push("No domain skill found in .pi/skills/<name>/SKILL.md.");
  if (!verify.length) problems.push("No verify steps. Every project needs at least one check that runs.");
  return problems;
}

async function chooseConnectors(ctx: ExtensionContext, signals: ConnectorSignal[], current: EnabledConnector[]) {
  const enabled = new Map(current.map((c) => [c.id, c]));
  const enable = (id: string) => enabled.set(id, { id, mcp: connectorById(id)?.mcp });

  for (const signal of signals) {
    const c = connectorById(signal.id);
    if (!c || enabled.has(c.id)) continue;
    if (await ctx.ui.confirm(`Connect ${c.name}?`, `Detected because ${signal.evidence}.\nWould be used read-only for ${c.purpose}.`)) enable(c.id);
  }
  for (;;) {
    const rest = CATALOG.filter((c) => !enabled.has(c.id));
    if (!rest.length) break;
    const pick = await ctx.ui.select("Does the project use any other service?", [NONE, ...rest.map((c) => c.name)]);
    if (!pick || pick === NONE) break;
    enable(rest.find((c) => c.name === pick)!.id);
  }
  for (const c of enabled.values()) {
    if (!c.mcp) ctx.ui.notify(`${connectorById(c.id)?.name ?? c.id}: configure it in ${path.join(agentDir(), "mcp.json")} under the name "${c.id}" and it will be used.`, "warning");
  }
  return [...enabled.values()];
}

/** Local state kept out of git: the one list /pr also leaves out of its commit (task-state.ts). `.pi/evidence/` has no code owner: the verify-app skill (setup-prompt.ts) writes there. */
export const IGNORED_STATE = LOCAL_STATE;

async function ensureIgnored(root: string, entries: string[]) {
  const gitignore = path.join(root, ".gitignore");
  const current = await fs.readFile(gitignore, "utf8").catch(() => "");
  const lines = current.split("\n").map((l) => l.trim());
  const missing = entries.filter((e) => !lines.includes(e) && !lines.includes(e.replace(/\/$/, "")));
  if (missing.length) await fs.appendFile(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

/** Returns the agentlint command when the project will enforce agentlint rules. */
async function chooseAgentlint(ctx: ExtensionContext, found: Discovery, always: boolean) {
  if (found.agentlint) return agentlintCmd(found.packageManager);
  if (!found.stacks.includes("node")) return undefined;
  if (always) return agentlintCmd(found.packageManager);
  const pick = await ctx.ui.select(
    "Turn the most important AGENTS.md rules into agentlint rules?\nThey block the end of every task until met or someone accepts the exception with a reason. You choose which.",
    ["Yes (recommended)", "No"],
  );
  return pick === "Yes (recommended)" ? agentlintCmd(found.packageManager) : undefined;
}

function registerConnectors(pi: ExtensionAPI, connectors: EnabledConnector[]) {
  const registered = new Set(pi.getMcpServers().map((s: any) => s.name));
  for (const c of connectors) {
    if (!c.mcp || registered.has(c.id)) continue;
    pi.registerMcpServer(c.id, { url: c.mcp.url, exposure: "deferred", description: connectorById(c.id)?.purpose });
  }
}

export function registerSetup(pi: ExtensionAPI) {
  const run: Run = (command, args) => pi.exec(command, args, { timeout: 15_000 }).then((r) => (r.code === 0 ? r.stdout : ""), () => "");
  let nudges = 0;
  let verifyFailures = 0;
  let onStart: (() => void) | undefined;
  pi.on("agent_start", () => {
    onStart?.();
    onStart = undefined;
  });

  const setupRunning = async (cwd: string) => (await readManifest(cwd).catch(() => undefined))?.setup === "running";

  pi.registerCommand("setup", {
    description: "Prepare the project for the agent: scan, interview, connectors, docs and verify",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return ctx.ui.notify("/setup needs the interactive UI.", "error");
      const root = ctx.cwd;
      // Discovery and verify run git and bash through Nix: without it the scan comes back empty and says nothing.
      const probe = await pi.exec("git", ["--version"], { timeout: 15_000 }).catch(() => undefined);
      if (probe && isNixFailure(probe)) return ctx.ui.notify(`/setup cannot scan or verify the project. ${probe.stderr}`, "error");
      let manifest = await readManifest(root);
      if (manifest.setup === "done" && !(await ctx.ui.confirm("This project already has setup", REPEAT_WARNING))) return;

      const resuming = manifest.setup !== "done" && Boolean(manifest.startedAt);
      ctx.ui.setStatus("setup", "setup: scanning the repo…");
      const found = await discover(root, run);
      const language = manifest.language ?? (await ctx.ui.select("Which language for questions and docs?", ["Español", "English"]));
      if (!language) return ctx.ui.setStatus("setup", undefined);
      const connectors = await chooseConnectors(ctx, found.connectors, manifest.connectors);
      const use = manifest.useAgentlint;
      const agentlint = use === "never" ? undefined : (manifest.agentlint ?? (await chooseAgentlint(ctx, found, use === "always")));

      manifest = await updateManifest(root, (m) => {
        m.setup = "running";
        m.language = language;
        m.startedAt ??= new Date().toISOString();
        m.connectors = connectors;
        m.agentlint = agentlint;
        if (!m.verify.length) {
          m.verify = found.verify;
          const own = agentlintCheck(agentlintCmd(found.packageManager));
          if (found.verify.includes(own)) m.agentlintStep = own;
        }
        // Intended: opting out drops only the one step setup added, as a whole. pi-improved does not rewrite the user's own
        // scripts or commands, even when they run agentlint; the notice below tells the user and leaves the choice to them.
        // A setup from before the step was recorded added exactly `<agentlint> check --all`.
        if (use === "never") {
          const added = m.agentlintStep ?? (manifest.agentlint ? agentlintCheck(manifest.agentlint) : undefined);
          m.verify = m.verify.filter((step) => step !== added);
          delete m.agentlintStep;
        }
        // The merged view decides: a mode from the global file must keep applying.
        if (manifest.mode === undefined) m.mode = "direct";
      });
      manifest = await readManifest(root);
      // Only a hint, so a mention is enough: nothing is classified by it.
      if (use === "never" && manifest.verify.some((step) => /\bagentlint\b/.test(step))) ctx.ui.notify("useAgentlint is \"never\", but a verify step of yours still runs agentlint. Setup leaves your commands alone: change that step yourself if you want it gone.", "warning");
      registerConnectors(pi, connectors);
      nudges = 0;
      verifyFailures = 0;

      ctx.ui.setStatus("setup", "setup: the agent is documenting the project…");
      const previous = await usePhaseModel(pi, ctx, "setup");
      // sendUserMessage does not wait for the run: idle before it starts would restore the model before the first call.
      const started = new Promise<void>((resolve) => {
        onStart = resolve;
        setTimeout(resolve, START_TIMEOUT).unref();
      });
      pi.sendUserMessage(setupPrompt(found, manifest, resuming, await skillsBlock(root, "setup")));
      await started;
      await ctx.waitForIdle();
      await restoreModel(pi, ctx, previous);
      ctx.ui.setStatus("setup", undefined);
      if ((await readManifest(root)).setup === "done") await ctx.reload();
    },
  });

  pi.registerTool({
    name: "setup_finish",
    label: "Finish setup",
    description: "Finish /setup: checks the written files, runs verify and asks the user to approve. Call it only during /setup.",
    parameters: Type.Object({
      verify: Type.Array(Type.String(), { minItems: 1, description: "Shell commands that must all pass, in order" }),
      summary: Type.String({ description: "What you documented and what is still unresolved, 3-8 lines" }),
    }),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      let { verify } = params;
      const { summary } = params;
      const root = ctx.cwd;
      if (!(await setupRunning(root))) throw new Error("No setup is running. The user starts one with /setup.");

      const manifest = await readManifest(root);
      let { agentlint } = manifest;
      let addedStep: string | undefined;
      // The person can say yes to agentlint at the start and no in the interview: without a way out, setup could never finish.
      if (agentlint && !(await hasAgentlintConfig(root)) && ctx.hasUI) {
        const drop = await ctx.ui.confirm("Drop agentlint?", "Setup was to add agentlint rules, but the project has no agentlint config. Drop agentlint for this project? Set `useAgentlint` to \"never\" to stop /setup from asking.");
        if (drop) {
          await updateManifest(root, (m) => void delete m.agentlint);
          agentlint = undefined;
        }
      }
      const problems = await checkOutputs(root, verify, pi.exec.bind(pi));
      if (agentlint) {
        if (!(await hasAgentlintConfig(root))) problems.push(`agentlint is not configured. Run \`${agentlint} init\` and add the rules the user selected.`);
        else {
          const tests = await runVerify([`${agentlint} rules test`], pi.exec.bind(pi), root);
          // A config with zero rules is a valid choice; agentlint reports it as "No matching rules".
          const noRules = tests.results.some((r) => /No matching rules/.test(r.output));
          if (!tests.ok && !noRules) problems.push(`agentlint rule fixtures fail:\n${formatVerify(tests)}`);
        }
        // Always a step of its own, even when a script of the user's also runs agentlint: running it twice is cheaper than parsing scripts to tell.
        addedStep = agentlintCheck(agentlint);
        if (!verify.includes(addedStep)) verify = [...verify, addedStep];
      }
      if (problems.length) throw new Error(`Setup incomplete:\n- ${problems.join("\n- ")}`);

      // Stored where the user put it, run first: a script of the user's that also runs agentlint must not stop the run before the approval below.
      const steps = verifySteps({ verify, agentlintStep: addedStep });
      let result = await runVerify(steps, pi.exec.bind(pi), root);
      // Findings in code that predates the rules are the user's call, not another model round: they accept each one or send it back.
      while (!result.ok && agentlint && ctx.hasUI && isPolicyFailure(result, agentlintStepOf({ agentlintStep: addedStep }))) {
        const report = formatVerify(result);
        const outcome = await resolvePolicyFailure(pi, ctx, manifest, report);
        if (outcome === "approved") {
          result = await runVerify(steps, pi.exec.bind(pi), root);
          continue;
        }
        if (outcome === "stop") {
          await updateManifest(root, (m) => void (m.setup = "pending"));
          return { content: [{ type: "text", text: "The user paused setup on the agentlint findings. Stop here." }], details: undefined, terminate: true };
        }
        throw new Error(`${report}\n\n${outcome === "failed" ? "Recording the acceptance failed. " : ""}The user wants these findings fixed, not accepted. If the rule is about changes, make it a \`change\` rule; if it flags code it should not, narrow its detector or \`binding.include\`; or remove the rule if the user agrees. Then call setup_finish again.`);
      }
      let verifyNote = "";
      if (!result.ok) {
        verifyFailures++;
        const report = formatVerify(result);
        if (verifyFailures < MAX_VERIFY_FAILURES) throw new Error(`${report}\n\nFix the cause (or the verify steps, if they are wrong) and call setup_finish again.`);
        const choice = await ctx.ui.select(`verify failed ${verifyFailures} times. What now?`, ["Keep trying", "Finish anyway (verify stays pending)", "Pause setup"]);
        if (choice === "Keep trying") throw new Error(`${report}\n\nThe user asked you to keep trying.`);
        if (choice !== "Finish anyway (verify stays pending)") {
          await updateManifest(root, (m) => void (m.setup = "pending"));
          return { content: [{ type: "text", text: "The user paused setup. Stop here." }], details: undefined, terminate: true };
        }
        verifyNote = "\n\n⚠️  verify still fails.";
      }

      const changed = (await run("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"])).trim() || "(no changes detected by git)";
      const approved = await ctx.ui.confirm("Approve the setup?", `${summary}${verifyNote}\n\nFiles:\n${changed}\n\nReview it with git diff before answering.`);
      if (!approved) {
        const feedback = await ctx.ui.input("What should change?");
        throw new Error(`The user did not approve. Feedback: ${feedback || "(none)"}. Apply it and call setup_finish again.`);
      }

      await ensureIgnored(root, [...IGNORED_STATE, ...((await fs.access(path.join(root, "package.json")).then(() => true, () => false)) ? ["node_modules/"] : [])]);

      await updateManifest(root, (m) => {
        m.setup = "done";
        m.verify = verify;
        if (addedStep) m.agentlintStep = addedStep;
        // As at the start: a mode from the global file must keep applying.
        if (manifest.mode === undefined) m.mode = "direct";
        m.completedAt = new Date().toISOString();
      });
      return { content: [{ type: "text", text: "Setup complete and approved. Stop here." }], details: { verify }, terminate: true };
    },
  });

  // Connector tools are read-only while setup runs.
  pi.on("tool_call", async (event, ctx) => {
    const server = event.toolName.match(/^mcp__(.+?)__/)?.[1];
    if (!server || !(await setupRunning(ctx.cwd))) return;
    const manifest = await readManifest(ctx.cwd);
    if (!manifest.connectors.some((c) => c.id === server)) return;
    const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
    if (hints?.readOnlyHint !== true) return { block: true, reason: `During setup, ${server} can only be used to read. This tool can modify data.` };
  });

  // A cheap model often stops early. Push it back to the steps a bounded number of times.
  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") nudges = 0;
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || nudges >= MAX_NUDGES || !(await setupRunning(ctx.cwd))) return;
    nudges++;
    return { entries: [{ type: "custom_message", customType: "setup-nudge", content: SETUP_NUDGE, display: false }], continue: true };
  });

  // Escape, an error or a model that gave up after the nudges leaves setup "running"; say how to get out of it.
  // agent_settled, not agent_before_settle: pi skips the settle boundary on Escape.
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.hasUI && (await setupRunning(ctx.cwd))) ctx.ui.notify("Setup stopped before finishing. Run /setup to continue where it left off.", "warning");
  });

  pi.on("session_start", async (event, ctx) => {
    const manifest = await readManifest(ctx.cwd).catch(() => undefined);
    if (!manifest) return;
    registerConnectors(pi, manifest.connectors);
    if (event.reason !== "startup" || ctx.mode !== "tui" || manifest.setup === "done" || manifest.setup === "declined") return;
    if (!(await isProject(ctx.cwd))) return;

    const question = manifest.startedAt
      ? "A setup is half done. Continue it?"
      : "This project has no agent setup. Do it now? (default mode: direct, work from AGENTS.md; /task is optional and recommended for risky changes)";
    const choice = await ctx.ui.select(question, ["Yes", "Later", DECLINE]);
    if (choice === "Yes") pi.sendUserMessage("/setup", { expandPromptTemplates: true });
    else if (choice === DECLINE) await updateManifest(ctx.cwd, (m) => void (m.setup = "declined"));
  });
}
