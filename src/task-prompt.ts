export const TASK_NUDGE = "Call task_plan with your plan.";
export const QUESTION_NUDGE = "The user does not read plain-text questions here. If you need a decision, call ask_user. Otherwise make the reasonable choice that fits the plan, AGENTS.md and the ADRs, and keep implementing.";

export function taskPrompt(title: string, ticket: string | undefined, tracker: string | undefined, related: string[], skills = "") {
  const steps = [
    ticket && tracker
      ? `Read ticket ${ticket} with the ${tracker} tools (find them with tool_search). Read only, never modify the ticket.`
      : ticket && `Ticket ${ticket} has no connector enabled. Work from the title.`,
    "Read the .pi/skills/* skills and docs/adr/* decisions that relate to the task.",
    "Explore the code the task touches. Do not edit any file yet.",
    "Call task_plan with: summary, steps, files (repo-relative, directories end with /), and decisions.",
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
  ].join("\n");
}
