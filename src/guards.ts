import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** agentlint commands that open a browser UI and wait for a person. */
// The `review` subcommand right after the binary (optionally after `--`), or the UI flags anywhere.
const INTERACTIVE_AGENTLINT = /\bagentlint(?:\s+--)?\s+review\b|\bagentlint\b[^;&|\n]*\s--(?:review|wizard)\b/;

/** Recording an exception to a rule is a decision for the user, even when the rule allows agent authority. */
const AGENTLINT_ACCEPT = /\bagentlint(?:\s+--)?\s+(?:accept|approve)\b/;

/** Workflow state the code owns: the model must not rewrite it. */
const OWNED = /(^|\/)\.pi\/(workflow|task)\.json$/;

export function registerGuards(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const file = String((event.input as { path?: unknown }).path ?? "");
      if (OWNED.test(file)) return { block: true, reason: `${file} is workflow state managed by the extension. Do not edit it; ask the user (/models, /setup) if it needs to change.` };
      return;
    }
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (INTERACTIVE_AGENTLINT.test(command)) {
      return { block: true, reason: "This agentlint command opens an interactive UI for a person and would hang. Use `rules scan` or `next --format json` instead." };
    }
    if (AGENTLINT_ACCEPT.test(command)) {
      const approved = ctx.hasUI && (await ctx.ui.select(`The agent wants to accept an agentlint exception:\n${command}`, ["Approve the exception", "Block: make it fix the code"])) === "Approve the exception";
      if (!approved) return { block: true, reason: "The user did not accept this exception. Fix the code so the finding no longer applies, or explain why it is wrong and ask the user." };
    }
  });
}
