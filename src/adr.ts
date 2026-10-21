import * as fs from "node:fs/promises";
import * as path from "node:path";

export const ADR_DIR = "docs/adr";

export interface AdrInput {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
}

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Writes the next numbered ADR and returns its repo-relative path. */
export async function writeAdr(root: string, adr: AdrInput, date = new Date()): Promise<string> {
  const dir = path.join(root, ADR_DIR);
  await fs.mkdir(dir, { recursive: true });
  const numbers = (await fs.readdir(dir)).map((f) => Number(f.match(/^(\d{4})-/)?.[1] ?? 0));
  const next = String(Math.max(0, ...numbers) + 1).padStart(4, "0");
  const relative = `${ADR_DIR}/${next}-${slug(adr.title) || "decision"}.md`;
  const body = [
    `# ${next}. ${adr.title}`,
    "",
    `Date: ${date.toISOString().slice(0, 10)}`,
    "Status: Accepted",
    "",
    "## Context",
    adr.context,
    "",
    "## Decision",
    adr.decision,
    ...(adr.consequences ? ["", "## Consequences", adr.consequences] : []),
    "",
  ].join("\n");
  await fs.writeFile(path.join(root, relative), body, { flag: "wx" });
  return relative;
}
