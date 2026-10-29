import type { Plan } from "./task-state.ts";

/** A run that ends on a plain-text question: its last line (within the last 400 chars) ends with "?". */
export const endsOnQuestion = (text: string) => /\?\s*$/.test(text.trim().slice(-400).split("\n").filter(Boolean).at(-1) ?? "");

/** The text of an assistant message, or undefined for any other message. */
export const assistantText = (message: any): string | undefined =>
  message?.role !== "assistant" ? undefined : typeof message.content === "string" ? message.content : (message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

export const TASK_NUDGE = "Call task_plan with your plan.";
export const QUESTION_NUDGE = "The user does not read plain-text questions here. If you need a decision, call ask_user. Otherwise make the reasonable choice that fits the plan, AGENTS.md and the ADRs, and keep implementing.";

export const planText = (p: Plan) =>
  [
    ...(p.intent ? [`Intent: ${p.intent}`, ""] : []),
    p.summary,
    "",
    "Steps:",
    ...p.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Files:",
    ...p.files.map((f) => `- ${f}`),
    ...(p.interface.length ? ["", "Interface:", ...p.interface.map((i) => `- ${i.file}: ${[...i.exports, ...(i.signatures ?? [])].join(", ")}${i.source ? ` (${i.source})` : ""}${i.usage ? `\n  usage: ${i.usage}` : ""}`)] : []),
    ...(p.seams.length ? ["", "Seams:", ...p.seams.map((x) => `- ${x.name} → ${x.testFile}: ${x.catches}${x.misses ? ` (misses: ${x.misses})` : ""}`)] : []),
    ...(p.decisions.length ? ["", "Decisions:", ...p.decisions.map((d) => `- ${d.question} → ${d.answer ?? `see ${d.source}`}`)] : []),
  ].join("\n");

export function taskPrompt(title: string, ticket: string | undefined, tracker: string | undefined, related: string[], skills = "", spec: string[] = [], body?: string) {
  const steps = [
    ticket && tracker ? `Read ticket ${ticket} with the ${tracker} tools (tool_search finds them). Read only.` : ticket && `Ticket ${ticket} has no connector enabled. Work from the title.`,
    spec.length && `Read in full: ${spec.join(", ")}.`,
    "Read GLOSSARY.md, AGENTS.md, the .pi/skills/* skills and docs/adr/* decisions that relate to the task.",
    "Read the files you will touch and their siblings (their names and exports are the convention). Edit nothing yet.",
    "Call task_plan: intent, summary, steps, files (repo-relative, directories end with /), decisions, interface, seams.",
  ].filter(Boolean);
  return [
    ...(skills ? [skills, ""] : []),
    `New task: ${title}`,
    ...(body ? ["", body] : []),
    "",
    ...(related.length ? ["Similar past tasks:", ...related.map((r) => `- ${r}`), ""] : []),
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "decisions: only real choices the code and docs leave open; if an ADR, doc or skill settles one, set source to its path (path#section allowed). 2-4 options, recommended first. Once the plan is approved, pi records each answered decision as an ADR in docs/adr/; you never write those.",
    "intent: the ticket restated in your own words, one short paragraph. If you cannot, you have not understood it yet.",
    "interface: file and export names (and signatures) the tests import, a usage line for callables (the call a test would make, in the ticket's words) and a source ('ticket', or a doc/GLOSSARY.md/code path). Code checks every name appears literally in that source; otherwise it counts as invented and the user is asked. Names nobody gave: source 'user', never invent silently.",
    "Name new files like their siblings, after the ticket's noun; one module per noun. Copy argument shapes from the ticket or existing callers. Reuse existing helpers.",
    "seams: test attachment points per the tdd skill: test file (in files), what it catches and misses. At least one; every acceptance criterion, invalid inputs included, needs a seam.",
  ].join("\n");
}
