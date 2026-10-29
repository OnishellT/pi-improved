import * as fs from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBin } from "./bin.ts";
import { globalPath } from "./config.ts";
import { readManifest } from "./manifest.ts";

/** agentlint commands that open a browser UI and wait for a person: the `review` subcommand right after the binary (optionally after `--`), or the UI flags anywhere. */
const INTERACTIVE_AGENTLINT = /\bagentlint(?:\s+--)?\s+review\b|\bagentlint\b[^;&|\n]*\s--(?:review|wizard)\b/;

/**
 * Recording an exception to a rule is a decision for the user, even when the rule allows agent authority.
 * agentlint keeps exceptions in this file; the guard watches the file, not the command, so no spelling of the command gets past it.
 */
const ACCEPTANCES = path.join(".agentlint", "acceptances.jsonl");

/** Workflow state the code owns: the model must not rewrite it. Only write/edit are guarded; a bash redirect into it is a deliberate limit. */
const OWNED = /(^|\/)\.pi\/(workflow|task)\.json$/;

/** The user's own config file holds review.never, limits and selfCompact.prompt: only the user (or a command) changes it. */
function isGlobalConfig(file: string, cwd: string) {
  return toolPath(file, cwd) === canonical(path.resolve(globalPath()));
}

/** The file the write and edit tools would touch: pi turns a file URL into its path, strips a leading @, turns Unicode spaces into plain ones and expands ~, then resolves against the cwd. Symlinks are followed. */
export const toolPath = (file: string, cwd: string) => canonical(givenPath(file, cwd));

/** The path the tool is given, resolved as in `toolPath` but with symlinks kept. */
export function givenPath(file: string, cwd: string) {
  const unspaced = file.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  // A file URL names the same file as its path.
  const plain = unspaced.startsWith("file://") ? (() => { try { return fileURLToPath(unspaced); } catch { return unspaced; } })() : unspaced;
  const expanded = plain === "~" || plain.startsWith("~/") ? path.join(homedir(), plain.slice(1)) : plain;
  return path.resolve(cwd, expanded);
}

/** The path with symlinks resolved, also when the file does not exist yet (a dangling link is followed; else its nearest existing parent is resolved). */
export const shellQuote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

export function canonical(file: string): string {
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
      if (file && toolPath(file, ctx.cwd) === canonical(path.resolve(ctx.cwd, ACCEPTANCES))) {
        const manifest = await readManifest(ctx.cwd).catch(() => undefined);
        // The configured command is shell text already; only the fallback path is quoted.
        const agentlint = manifest?.agentlint ?? shellQuote(resolveBin("agentlint"));
        return { block: true, reason: `${file} holds the exceptions the user approved. Do not edit it; run \`${agentlint} propose <selector> --summary '<why>'\` (selector from \`${agentlint} next --format json\`); propose only records it, so then ask the user to review and approve the proposal.` };
      }
      return;
    }
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (INTERACTIVE_AGENTLINT.test(command)) {
      return { block: true, reason: "This agentlint command opens an interactive UI for a person and would hang. Use `rules scan` or `next --format json` instead." };
    }
    await watchAcceptances(ctx.cwd);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const restored = await checkAcceptances(ctx);
    if (restored) return { content: [...event.content, { type: "text" as const, text: restored }] };
  });
}

/** By project: the acceptance records the user has approved, as the file held them. A record taken out is no longer approved: back again, it is asked again. */
const known = new Map<string, string[]>();

const records = async (cwd: string) => ((await read(path.resolve(cwd, ACCEPTANCES))) ?? "").split("\n").filter((l) => l.trim());

/** Start watching the file: the records it holds before the agent first acts are the user's. */
export async function watchAcceptances(cwd: string) {
  if (!known.has(cwd)) known.set(cwd, await records(cwd));
}

/** After the user approved a record outside a bash call: trust the new records `approved` picks and nothing else, so nothing rides along. */
export async function trustAcceptances(cwd: string, approved: (record: any) => boolean) {
  const trusted = known.get(cwd) ?? [];
  const pick = (line: string) => {
    try {
      return approved(JSON.parse(line));
    } catch {
      return false;
    }
  };
  known.set(cwd, (await records(cwd)).filter((l) => trusted.includes(l) || pick(l)));
}

/**
 * Records the user has not approved are shown in one confirm; declined, or with nobody to ask, the file goes back to the approved records.
 * Runs after every bash call and before the gate verifies, so a record written later (a background process) is caught before it can open the gate.
 * Returns the note for the model when it put the file back.
 */
export async function checkAcceptances(ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">): Promise<string | undefined> {
  const trusted = known.get(ctx.cwd);
  if (!trusted) return;
  const now = await records(ctx.cwd);
  // A changed record (a new reason, an exception that came back) is a line the user has not approved: they see it too.
  const added = now.filter((l) => !trusted.includes(l));
  if (!added.length || (ctx.hasUI && (await ctx.ui.confirm("The agent recorded agentlint exceptions. Keep them?", added.join("\n"))))) {
    known.set(ctx.cwd, now);
    return;
  }
  const file = path.resolve(ctx.cwd, ACCEPTANCES);
  if (trusted.length) await fs.promises.writeFile(file, `${trusted.join("\n")}\n`);
  else await fs.promises.rm(file, { force: true });
  const why = ctx.hasUI ? "The user did not accept the agentlint exceptions the agent recorded" : "agentlint exceptions need the user's approval and nobody can be asked here";
  return `${why}, so ${ACCEPTANCES} was restored. Fix the code so the finding no longer applies, or explain why it is wrong and ask the user.`;
}

/** The file's content, or undefined when it does not exist. */
const read = (file: string) => fs.promises.readFile(file, "utf8").catch(() => undefined);
