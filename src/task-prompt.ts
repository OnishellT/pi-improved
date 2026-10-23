import type { Plan } from "./task-state.ts";

export const TASK_NUDGE = "Call task_plan with your plan.";
export const QUESTION_NUDGE = "The user does not read plain-text questions here. If you need a decision, call ask_user. Otherwise make the reasonable choice that fits the plan, AGENTS.md and the ADRs, and keep implementing.";

export const planText = (p: Plan) =>
  [
    p.summary,
    "",
    "Pasos:",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Archivos:",
    ...p.files.map((f) => `- ${f}`),
    ...(p.interface?.length ? ["", "Interfaz:", ...p.interface.map((i) => `- ${i.file}: ${[...i.exports, ...(i.signatures ?? [])].join(", ")}${i.source ? ` (${i.source})` : ""}`)] : []),
    ...(p.seams?.length ? ["", "Seams:", ...p.seams.map((x) => `- ${x.name} → ${x.testFile}: ${x.catches}${x.misses ? ` (no cubre: ${x.misses})` : ""}`)] : []),
    ...(p.decisions.length ? ["", "Decisiones:", ...p.decisions.map((d) => `- ${d.question} → ${d.answer ?? `ver ${d.source}`}`)] : []),
  ].join("\n");

export function taskPrompt(title: string, ticket: string | undefined, tracker: string | undefined, related: string[], skills = "", spec: string[] = []) {
  const steps = [
    ticket && tracker
      ? `Read ticket ${ticket} with the ${tracker} tools (find them with tool_search). Read only, never modify the ticket.`
      : ticket && `Ticket ${ticket} has no connector enabled. Work from the title.`,
    spec.length && `Read the spec file(s) named in the request in full: ${spec.join(", ")}.`,
    "Read the ticket, GLOSSARY.md (if present), AGENTS.md, the .pi/skills/* skills and docs/adr/* decisions that relate to the task.",
    "Read the files you will touch and explore the code around them, including the files next to them (their names and exports are the convention to follow). Do not edit any file yet.",
    "Call task_plan with: summary, steps, files (repo-relative, directories end with /), decisions, interface and seams.",
  ].filter(Boolean);
  return [
    ...(skills ? [skills, ""] : []),
    `New task: ${title}`,
    "",
    ...(related.length ? ["Similar past tasks:", ...related.map((r) => `- ${r}`), ""] : []),
    "Follow these steps in order:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Put in decisions only real choices the code and docs do not settle. If an ADR, doc or skill already settles one, set source to its path (path#section allowed). Each decision has 2-4 options, recommended first.",
    "interface pins the file and export names (and signatures) the tests will import. Derive them from the ticket, the docs or existing code and cite the source ('ticket', or the doc/GLOSSARY.md/existing file path). The code checks that every name appears literally in the cited source: a name that is not there counts as invented and the user is asked. If a name is not given anywhere, set source to 'user'; never invent silently.",
    "New files: name them like their siblings in the same directory (same casing and separators) after the noun the ticket uses; one module per ticket noun, not a new catch-all file. Signatures: copy the argument shape the ticket or existing callers use (an object with named fields stays an object). Reuse existing helpers (validators, parsers, types) instead of adding parallel ones.",
    "seams are the test attachment points, chosen per the tdd skill: each has a test file (listed in files), what it catches and what it misses. At least one. Every acceptance criterion in the ticket, including the invalid-input ones, must be covered by a seam.",
  ].join("\n");
}
