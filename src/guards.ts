import * as fs from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { globalPath } from "./config.ts";

/** agentlint commands that open a browser UI and wait for a person: the `review` subcommand right after the binary (optionally after `--`), or the UI flags anywhere. */
const INTERACTIVE_AGENTLINT = /\bagentlint(?:\s+--)?\s+review\b|\bagentlint\b[^;&|\n]*\s--(?:review|wizard)\b/;

/** Recording an exception to a rule is a decision for the user, even when the rule allows agent authority. */
const AGENTLINT_ACCEPT = /\bagentlint(?:\s+--)?\s+(?:accept|approve)\b/;

/** Workflow state the code owns: the model must not rewrite it. Only write/edit are guarded; a bash redirect into it is a deliberate limit. */
const OWNED = /(^|\/)\.pi\/(workflow|task)\.json$/;

/** The user's own config file holds review.never, limits and selfCompact.prompt: only the user (or a command) changes it. */
function isGlobalConfig(file: string, cwd: string) {
  return toolPath(file, cwd) === canonical(path.resolve(globalPath()));
}

/** The file the write and edit tools would touch: pi turns a file URL into its path, strips a leading @, turns Unicode spaces into plain ones and expands ~, then resolves against the cwd. Symlinks are followed. */
function toolPath(file: string, cwd: string) {
  const unspaced = file.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  // A file URL names the same file as its path.
  const plain = unspaced.startsWith("file://") ? (() => { try { return fileURLToPath(unspaced); } catch { return unspaced; } })() : unspaced;
  const expanded = plain === "~" || plain.startsWith("~/") ? path.join(homedir(), plain.slice(1)) : plain;
  return canonical(path.resolve(cwd, expanded));
}

/** The path with symlinks resolved, also when the file does not exist yet (a dangling link is followed; else its nearest existing parent is resolved). */
function canonical(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      return canonical(path.resolve(path.dirname(file), fs.readlinkSync(file)));
    } catch {}
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}

export function registerGuards(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const file = String((event.input as { path?: unknown }).path ?? "");
      if (OWNED.test(path.posix.normalize(file)) || (file && OWNED.test(toolPath(file, ctx.cwd).split(path.sep).join("/")))) return { block: true, reason: `${file} is workflow state managed by the extension. Do not edit it; ask the user (/models, /setup) if it needs to change.` };
      if (file && isGlobalConfig(file, ctx.cwd)) return { block: true, reason: `${file} is the user's own configuration (limits, review policy, self-compact). Do not edit it; ask the user to change it.` };
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
