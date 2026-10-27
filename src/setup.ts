import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CATALOG, connectorById, type ConnectorSignal } from "./connectors.ts";
import { agentlintCheck, agentlintCmd, discover, hasAgentlintConfig, isProject, readPackageJson, type Discovery, type Run } from "./discover.ts";
import { agentDir } from "./subagent-ext.ts";
import { restoreModel, usePhaseModel } from "./models.ts";
import { readManifest, updateManifest, type EnabledConnector } from "./manifest.ts";
import { phaseSkills, skillsBlock } from "./skills.ts";
import { AGENTS_MAX_LINES, SETUP_NUDGE, setupPrompt } from "./setup-prompt.ts";
import { CONTRACT_PATH } from "./contract.ts";
import { METRICS_DIR } from "./telemetry.ts";
import { TASK_PATH } from "./task-state.ts";
import { formatVerify, runVerify } from "./verify.ts";

const MAX_NUDGES = 2;
const START_TIMEOUT = 30_000;
const MAX_VERIFY_FAILURES = 3;
const NONE = "No more";
const DECLINE = "Don't ask again";
export const REPEAT_WARNING = "Repeating it reruns the interview and the docs on the strong setup model, which costs far more than a normal task. Do it only if the project changed a lot. Update it?";

/** Returns what is missing from the setup output; empty means complete. */
export async function checkOutputs(root: string, verify: string[]): Promise<string[]> {
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
  if ((await phaseSkills(root, "setup")).includes("domain-modeling") && !(await fs.access(path.join(root, "GLOSSARY.md")).then(() => true, () => false))) problems.push("GLOSSARY.md is missing.");
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

/** Local state kept out of git. `.pi/evidence/` has no code owner: the verify-app skill (setup-prompt.ts) writes there. */
export const IGNORED_STATE = [TASK_PATH, CONTRACT_PATH, METRICS_DIR, ".pi/evidence/"];

async function ensureIgnored(root: string, entries: string[]) {
  const gitignore = path.join(root, ".gitignore");
  const current = await fs.readFile(gitignore, "utf8").catch(() => "");
  const lines = current.split("\n").map((l) => l.trim());
  const missing = entries.filter((e) => !lines.includes(e) && !lines.includes(e.replace(/\/$/, "")));
  if (missing.length) await fs.appendFile(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

/** True when a verify step already runs the agentlint gate, directly or through a package script. */
async function runsAgentlint(root: string, verify: string[]) {
  const scripts: Record<string, string> = (await readPackageJson(root)).scripts ?? {};
  const expand = (step: string) => step.replace(/^(?:npm|pnpm|yarn|bun)(?: run)? ([\w:-]+)$/, (all, name) => scripts[name] ?? all);
  return verify.some((step) => /agentlint\b.*\bcheck\b/.test(expand(step)));
}

/** Returns the agentlint command when the project will enforce agentlint rules. */
async function chooseAgentlint(ctx: ExtensionContext, found: Discovery) {
  if (found.agentlint) return agentlintCmd(found.packageManager);
  if (!found.stacks.includes("node")) return undefined;
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
      let manifest = await readManifest(root);
      if (manifest.setup === "done" && !(await ctx.ui.confirm("This project already has setup", REPEAT_WARNING))) return;

      const resuming = manifest.setup !== "done" && Boolean(manifest.startedAt);
      ctx.ui.setStatus("setup", "setup: scanning the repo…");
      const found = await discover(root, run);
      const language = manifest.language ?? (await ctx.ui.select("Which language for questions and docs?", ["Español", "English"]));
      if (!language) return ctx.ui.setStatus("setup", undefined);
      const connectors = await chooseConnectors(ctx, found.connectors, manifest.connectors);
      const agentlint = manifest.agentlint ?? (await chooseAgentlint(ctx, found));

      manifest = await updateManifest(root, (m) => {
        m.setup = "running";
        m.language = language;
        m.startedAt ??= new Date().toISOString();
        m.connectors = connectors;
        m.agentlint = agentlint;
        if (!m.verify.length) m.verify = found.verify;
        m.mode ??= "direct";
      });
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

      const { agentlint } = await readManifest(root);
      const problems = await checkOutputs(root, verify);
      if (agentlint) {
        if (!(await hasAgentlintConfig(root))) problems.push(`agentlint is not configured. Run \`${agentlint} init\` and add the rules the user selected.`);
        else {
          const tests = await runVerify([`${agentlint} rules test`], pi.exec.bind(pi), root);
          // A config with zero rules is a valid choice; agentlint reports it as "No matching rules".
          const noRules = tests.results.some((r) => /No matching rules/.test(r.output));
          if (!tests.ok && !noRules) problems.push(`agentlint rule fixtures fail:\n${formatVerify(tests)}`);
        }
        if (!(await runsAgentlint(root, verify))) verify = [...verify, agentlintCheck(agentlint)];
      }
      if (problems.length) throw new Error(`Setup incomplete:\n- ${problems.join("\n- ")}`);

      const result = await runVerify(verify, pi.exec.bind(pi), root);
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
        m.mode ??= "direct";
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
