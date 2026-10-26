import type { Plan } from "./task-state.ts";

export const TASK_NUDGE = "Call task_plan with your plan.";
export const QUESTION_NUDGE = "The user does not read plain-text questions here. If you need a decision, call ask_user. Otherwise make the reasonable choice that fits the plan, AGENTS.md and the ADRs, and keep implementing.";

export const planText = (p: Plan) =>
  [
    p.summary,
    "",
    "Steps:",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Files:",
    ...p.files.map((f) => `- ${f}`),
    ...(p.interface?.length ? ["", "Interface:", ...p.interface.map((i) => `- ${i.file}: ${[...i.exports, ...(i.signatures ?? [])].join(", ")}${i.source ? ` (${i.source})` : ""}`)] : []),
    ...(p.seams?.length ? ["", "Seams:", ...p.seams.map((x) => `- ${x.name} → ${x.testFile}: ${x.catches}${x.misses ? ` (misses: ${x.misses})` : ""}`)] : []),
    ...(p.decisions.length ? ["", "Decisions:", ...p.decisions.map((d) => `- ${d.question} → ${d.answer ?? `see ${d.source}`}`)] : []),
  ].join("\n");

export function taskPrompt(title: string, ticket: string | undefined, tracker: string | undefined, related: string[], skills = "", spec: string[] = []) {
  const steps = [
    ticket && tracker ? `Read ticket ${ticket} with the ${tracker} tools (tool_search finds them). Read only.` : ticket && `Ticket ${ticket} has no connector enabled. Work from the title.`,
    spec.length && `Read in full: ${spec.join(", ")}.`,
    "Read GLOSSARY.md, AGENTS.md, the .pi/skills/* skills and docs/adr/* decisions that relate to the task.",
    "Read the files you will touch and their siblings (their names and exports are the convention). Edit nothing yet.",
    "Call task_plan: summary, steps, files (repo-relative, directories end with /), decisions, interface, seams.",
  ].filter(Boolean);
  return [
    ...(skills ? [skills, ""] : []),
    `New task: ${title}`,
    "",
    ...(related.length ? ["Similar past tasks:", ...related.map((r) => `- ${r}`), ""] : []),
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "decisions: only real choices the code and docs leave open; if an ADR, doc or skill settles one, set source to its path (path#section allowed). 2-4 options, recommended first.",
    "interface: file and export names (and signatures) the tests import, each with a source ('ticket', or a doc/GLOSSARY.md/code path). Code checks every name appears literally in that source; otherwise it counts as invented and the user is asked. Names nobody gave: source 'user', never invent silently.",
    "Name new files like their siblings, after the ticket's noun; one module per noun. Copy argument shapes from the ticket or existing callers. Reuse existing helpers.",
    "seams: test attachment points per the tdd skill: test file (in files), what it catches and misses. At least one; every acceptance criterion, invalid inputs included, needs a seam.",
  ].join("\n");
}
