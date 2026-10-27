import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Plan } from "./task-state.ts";

/** The plan's pinned interface as JSON, read by scripts/contract-check.mjs and the contract-first skill; local state. */
export const CONTRACT_PATH = ".pi/contract.json";

export type InterfaceEntry = Plan["interface"][number];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (name: string, flags = "") => new RegExp(`(^|[^A-Za-z0-9_])${escape(name)}(?=$|[^A-Za-z0-9_])`, flags);

/** Tokens of a file stem: `entry-sizing` → entry, sizing; `orderGuards` → order, guards. */
export const stemTokens = (file: string) =>
  path
    .basename(file)
    .replace(/\..*$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter(Boolean);

/**
 * Names of an interface entry that the cited evidence (ticket, doc, existing file) never mentions.
 * Exports must appear as whole words (case-insensitive); a new file's stem must have every token in the text.
 * Language-agnostic on purpose: plain text, no parsing.
 */
export function missingNames(entry: InterfaceEntry, evidence: string, newFile: boolean): string[] {
  const missing = entry.exports.filter((name) => !word(name, "i").test(evidence));
  if (newFile) {
    const tokens = stemTokens(entry.file);
    if (tokens.length && !tokens.every((t) => word(t, "i").test(evidence))) missing.push(path.basename(entry.file));
  }
  return missing;
}

/** True when the document shares a word of 4+ letters with the question: cheap proof that a cited source is about it. */
export const relatesTo = (question: string, text: string) => (question.match(/[A-Za-z0-9]{4,}/g) ?? []).some((w) => word(w, "i").test(text));

/** Interface names the working copy does not expose yet: each export must appear literally (as a word) in its file. */
export async function checkContract(root: string, plan: Plan): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of plan.interface ?? []) {
    const text = await fs.readFile(path.join(root, entry.file), "utf8").catch(() => undefined);
    if (text === undefined) {
      problems.push(`${entry.file}: the file does not exist`);
      continue;
    }
    const missing = entry.exports.filter((name) => !word(name).test(text));
    if (missing.length) problems.push(`${entry.file}: missing ${missing.join(", ")}`);
  }
  return problems;
}

export const formatContract = (problems: string[]) =>
  ["Interface contract not met (the plan pinned these names; the tests and the reviewer expect them):", ...problems.map((p) => `- ${p}`)].join("\n");
