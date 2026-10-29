import { BEND_INSTALL, bendCheck } from "./bend.ts";
import { limitsOf } from "./config.ts";
import { connectorById } from "./connectors.ts";
import { agentlintCheck, type Discovery } from "./discover.ts";
import type { Manifest } from "./manifest.ts";
import { uiDriverHint } from "./ui-driver.ts";

export const AGENTS_MAX_LINES = 150;
const AGENTLINT_SKILLS = "node_modules/@aurelienbbn/agentlint/skills/agentlint";

const INSTALL_DEV: Record<string, string> = { npm: "npm install -D", pnpm: "pnpm add -D", yarn: "yarn add -D", bun: "bun add -d" };

function agentlintStep(cmd: string, found: Discovery, rules: number) {
  const install = found.agentlint
    ? "agentlint is already configured in `.agentlint/config.ts`. Keep its rules."
    : `Install it with \`${INSTALL_DEV[found.packageManager ?? "npm"] ?? INSTALL_DEV.npm} @aurelienbbn/agentlint\`, then run \`${cmd} init\`.`;
  return `Turn the most important rules into agentlint rules. The user asked for this.
   - ${install}
   - Read \`${AGENTLINT_SKILLS}/rule-advisor/SKILL.md\` and follow it.
   - From the MUST / NEVER rules in AGENTS.md, pick those where a code pattern can find the cases but a person still has to judge them. Purely mechanical rules belong in the existing linter or tests.
   - Ask the user with \`ask_user\` which ones to enforce, at most ${rules} to start. Only enforce what the user selects. Use \`authority: "human"\` unless the user says the agent may decide.
   - agentlint has no warning or calibration mode: every configured rule blocks verify until each finding is fixed or a person accepts it. Never offer a rule "without enforcement".
   - Pick the lifecycle by what the rule judges. A rule about changing something ("changing X needs Y") is \`lifecycle: "change"\`: it judges the diff against the merge base, so existing code is never flagged. \`lifecycle: "state"\` judges the current code, existing code included. A change detector is \`detect({ context })\`: loop \`context.change.files\` (\`path\`, \`status\`, \`hunks[].lines[]\` with \`kind\` "addition" | "deletion" | "context") and call \`context.report({ key, file, message, evidence })\`; its fixtures are \`{ before: { path: text }, after: { path: text } }\`.
   - Write each rule in \`.agentlint/config.ts\` with fixtures. Run \`${cmd} rules test\`, then \`${cmd} rules scan\` and tell the user how many findings each rule has in the existing code.
   - For existing findings: narrow the detector or \`binding.include\`, or turn the rule into a \`change\` rule. What is left, setup_finish shows to the user one by one to accept with their own reason. Never run \`approve\`, \`accept\` or \`review\` yourself, and NEVER bulk-accept findings with a generic reason.
   - setup_finish adds \`${agentlintCheck(cmd)}\` to verify as a step of its own, and it must exit 0; do not add agentlint to the other steps or scripts.`;
}

function bendStep(bend: NonNullable<Discovery["bend"]>) {
  if (!bend.installed) return `The project has \`${bend.laws}\` (Bend) but \`bend\` is not on PATH. Do not install it. Tell the user how in your summary: ${BEND_INSTALL}. Do not add a Bend step to verify, but keep one that is already there.`;
  return bend.proof
    ? `\`${bend.laws}\` holds the user's laws and \`${bend.proof}\` their proofs. The verify steps must include \`${bendCheck(bend.proof)}\`: add it if missing. Never edit \`${bend.laws}\`.`
    : `\`${bend.laws}\` has no \`PROOF.bend\` yet. Do not write one now: tell the user in your summary that a \`/task\` can prove the laws in \`PROOF.bend\`, and that running \`/setup\` again then adds the proof check to verify.`;
}

/** Offered only to a project without LAWS.bend, and only for pure logic: the laws are the user's spec, so each one is shown and approved before it is written. */
function lawsStep(manifest: Manifest) {
  const ask = manifest.useBend === "always" ? "" : "First ask the user with `ask_user` whether they want to record such rules as proven laws (Bend, https://bend-lang.com); if not, skip the rest of this step. ";
  return `Look for invariants that must never break and are pure logic (limits, pricing, permissions, state transitions), using what the interview and the code showed. If there are none, skip this step silently. ${ask}Check \`command -v bend\`: if it is missing, show the user ${BEND_INSTALL} and never run it; write the laws anyway.
   - Draft each law in plain words and show it with \`ask_user\` (approve / change / drop). Write only the approved ones.
   - If \`bend\` is installed, read the "Recursion and Termination", "Quantities" and "Laws and Proofs" sections of \`bend guide\` before writing Bend.
   - Write the smallest Bend model of the logic in \`Model.bend\` and the approved laws in \`LAWS.bend\`, which imports it. A law is an equality: \`law name:\`, then \`for x: Nat\` lines, then \`{Model.f(x) == y : T}\`; a yes/no fact is \`{... == True{} : Bool}\`. If \`bend\` is installed, \`BEND_NO_TELEMETRY=1 bend --check-only LAWS.bend\` must fail only with "TODO found" (the laws are open claims): fix any other error. Never put a law in without approval; laws are the user's spec.
   - If \`bend\` is installed, write \`PROOF.bend\` and try to prove them; when \`BEND_NO_TELEMETRY=1 bend --check-only PROOF.bend\` passes, add it to the verify steps. If you cannot prove them quickly, leave PROOF.bend out. Either way, say in the summary that the laws cover only the model until a \`/task\` adds a test in the project's language that compares the real code with the model (and proves any open law).`;
}

/** The one model-facing instruction for setup. Short on purpose: cheap models follow short lists. */
export function setupPrompt(found: Discovery, manifest: Manifest, resuming: boolean, skills = "") {
  const connectors = manifest.connectors.map((c) => {
    const known = connectorById(c.id);
    return `   - ${known?.name ?? c.id}: ${known?.purpose ?? ""} (MCP server "${c.id}", read-only)`;
  });

  const limits = limitsOf(manifest);
  const steps = [
    "Read the existing docs and agent files listed above. Then explore the code: entry points, main modules, data flow, tests.",
    connectors.length
      ? `Read recent context from these connectors (find their tools with tool_search). Never create or change anything there.\n${connectors.join("\n")}`
      : "No connectors are enabled. Skip this step.",
    `List what you could not determine and any contradictions between the code, the docs and the connectors.
   Interview the user following the grilling skill, ONE question at a time via \`ask_user\`, until the domain and the main workflows are clear (max ~${limits.interviewQuestions} questions).
   Give 2-4 options per question, recommended option first. Don't ask anything the code already answers.`,
    `Write \`GLOSSARY.md\` at the repo root following GLOSSARY-FORMAT.md, and ADRs following ADR-FORMAT.md in \`docs/adr/\` (reuse existing GLOSSARY.md / docs/agents/ if present: never duplicate).${found.glossary ? " GLOSSARY.md already exists: extend it." : ""}${found.agentDocs ? " docs/agents/ already exists: link to it instead of repeating it." : ""}`,
    `Write AGENTS.md and the domain skills following the technical-writing skill (Diátaxis; short sentences):
   - \`AGENTS.md\`, at most ${AGENTS_MAX_LINES} lines: purpose, stack, commands, architecture map, conventions, hard rules (MUST / NEVER), and links to the skills. If it already exists, update it and keep the user's content.
   - Two short sections (about 10 lines in total, \`AGENTS.md\` is reread every turn): "Before finishing", listing the verify commands (${manifest.verify.length ? manifest.verify.map((v) => `\`${v}\``).join(", ") : "from the verify step below"}) to run and pass before calling a task done; and "When to use /task", saying that dependencies, migrations, \`review.paths\` areas and big changes go through \`/task\` (plan, gates, review) while small edits are done directly.
   - \`.pi/skills/domain-<name>/SKILL.md\`, one per business area. Use frontmatter with \`name\` and \`description\`, then the vocabulary, invariants, key files and pitfalls.
   - \`docs/adr/NNNN-<title>.md\` for each architecture decision that the code shows or the user confirmed.`,
    `Create the project's verification skill following pstack-create-verification-skill at \`.pi/skills/verify-app/SKILL.md\`, with a runnable script when the app can be driven headlessly. Its evidence and scratch files live under \`.pi/evidence/\` inside the repo (never under the home directory or outside the repo); the command must not create directories elsewhere. The feature map is versioned in the skill's own \`features/\` folder: \`README.md\`, one file per feature, and \`coverage.json\`; setup_finish checks it.${found.uiDrivers?.length ? ` For behavior a headless run cannot reach (desktop windows, Electron), the script may use these GUI drivers: ${uiDriverHint(found.uiDrivers)}` : ""} Add its command to the verify list passed to \`setup_finish\` only if it runs green.`,
    ...(found.bend ? [bendStep(found.bend)] : manifest.useBend === "never" ? [] : [lawsStep(manifest)]),
    ...(manifest.agentlint ? [agentlintStep(manifest.agentlint, found, limits.agentlintRules)] : []),
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

export const SETUP_NUDGE =
  "Setup is not finished. If you need the user, use ask_user. Otherwise continue the steps and call setup_finish.";
