import { connectorById } from "./connectors.ts";
import { agentlintCheck, type Discovery } from "./discover.ts";
import type { Manifest } from "./manifest.ts";

export const AGENTS_MAX_LINES = 150;
export const AGENTLINT_SKILLS = "node_modules/@aurelienbbn/agentlint/skills/agentlint";

const INSTALL_DEV: Record<string, string> = { npm: "npm install -D", pnpm: "pnpm add -D", yarn: "yarn add -D", bun: "bun add -d" };

function agentlintStep(cmd: string, found: Discovery) {
  const install = found.agentlint
    ? "agentlint is already configured in `.agentlint/config.ts`. Keep its rules."
    : `Install it with \`${INSTALL_DEV[found.packageManager ?? "npm"] ?? INSTALL_DEV.npm} @aurelienbbn/agentlint\`, then run \`${cmd} init\`.`;
  return `Turn the most important rules into agentlint rules. The user asked for this.
   - ${install}
   - Read \`${AGENTLINT_SKILLS}/rule-advisor/SKILL.md\` and follow it.
   - From the MUST / NEVER rules in AGENTS.md, pick those where a code pattern can find the cases but a person still has to judge them. Purely mechanical rules belong in the existing linter or tests.
   - Ask the user with \`ask_user\` which ones to enforce, at most 3 to start. Only enforce what the user selects. Use \`authority: "human"\` unless the user says the agent may decide.
   - Write each rule in \`.agentlint/config.ts\` with fixtures. Run \`${cmd} rules test\`, then \`${cmd} rules scan\` to see the findings in the existing code.
   - If a rule finds many cases in existing code, narrow \`binding.include\` or make it a \`change\` rule. NEVER bulk-accept findings with a generic reason.
   - \`${agentlintCheck(cmd)}\` runs as part of verify and must exit 0.`;
}

/** The one model-facing instruction for setup. Short on purpose: cheap models follow short lists. */
export function setupPrompt(found: Discovery, manifest: Manifest, resuming: boolean, skills = "") {
  const connectors = manifest.connectors.map((c) => {
    const known = connectorById(c.id);
    return `   - ${known?.name ?? c.id}: ${known?.purpose ?? ""} (MCP server "${c.id}", read-only)`;
  });

  const steps = [
    "Read the existing docs and agent files listed above. Then explore the code: entry points, main modules, data flow, tests.",
    connectors.length
      ? `Read recent context from these connectors (find their tools with tool_search). Never create or change anything there.\n${connectors.join("\n")}`
      : "No connectors are enabled. Skip this step.",
    `List what you could not determine and any contradictions between the code, the docs and the connectors.
   Interview the user following the grilling skill, ONE question at a time via \`ask_user\`, until the domain and the main workflows are clear (max ~12 questions).
   Give 2-4 options per question, recommended option first. Don't ask anything the code already answers.`,
    `Write \`GLOSSARY.md\` at the repo root following GLOSSARY-FORMAT.md, and ADRs following ADR-FORMAT.md in \`docs/adr/\` (reuse existing GLOSSARY.md / docs/agents/ if present: never duplicate).${found.glossary ? " GLOSSARY.md already exists: extend it." : ""}${found.agentDocs ? " docs/agents/ already exists: link to it instead of repeating it." : ""}`,
    `Write AGENTS.md and the domain skills following the technical-writing skill (Diátaxis; short sentences):
   - \`AGENTS.md\`, at most ${AGENTS_MAX_LINES} lines: purpose, stack, commands, architecture map, conventions, hard rules (MUST / NEVER), and links to the skills. If it already exists, update it and keep the user's content.
   - Two short sections (about 10 lines in total, \`AGENTS.md\` is reread every turn): "Before finishing", listing the verify commands (${manifest.verify.length ? manifest.verify.map((v) => `\`${v}\``).join(", ") : "from the verify step below"}) to run and pass before calling a task done; and "When to use /task", saying that dependencies, migrations, \`review.paths\` areas and big changes go through \`/task\` (plan, gates, review) while small edits are done directly.
   - \`.pi/skills/domain-<name>/SKILL.md\`, one per business area. Use frontmatter with \`name\` and \`description\`, then the vocabulary, invariants, key files and pitfalls.
   - \`docs/adr/NNNN-<title>.md\` for each architecture decision that the code shows or the user confirmed.`,
    "Create the project's verification skill following pstack-create-verification-skill at `.pi/skills/verify-app/SKILL.md`, with a runnable script when the app can be driven headlessly. Its evidence, maps and scratch files live under `.pi/evidence/` inside the repo (never under the home directory or outside the repo); the command must not create directories elsewhere. Add its command to the verify list passed to `setup_finish` only if it runs green.",
    ...(manifest.agentlint ? [agentlintStep(manifest.agentlint, found)] : []),
    "Make sure verification exists. Use the proposed verify steps, fix them if they are wrong, or add a missing script or target. Order them fastest first: the stack's compiler, type checker or linter (whatever this project already has) before the tests, so the agent gets static feedback before behavior feedback. Do not change application code and do not install other dependencies without asking.",
    "Call `setup_finish` with the final verify steps and a short summary. If it reports problems, fix them and call it again.",
  ];

  return `${skills ? `${skills}\n\n` : ""}# Project setup${resuming ? " (resuming: keep what is already written, finish the rest)" : ""}

You are setting up this repository so future agents can work on it with little context.
Language for questions and docs: ${manifest.language}.

## What the scan already found
\`\`\`json
${JSON.stringify({ ...found, verify: manifest.verify }, null, 2)}
\`\`\`

## Steps
${steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`;
}

export const NUDGE =
  "Setup is not finished. If you need the user, use ask_user. Otherwise continue the steps and call setup_finish.";
