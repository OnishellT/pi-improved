import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ON_DEMAND, DEFAULT_SKILLS, OPT_IN, readManifest, updateManifest, type Phase } from "./manifest.ts";

const MAX_BODY = 12_000;
const KEEP = "No changes";
const DEFAULTS = "Defaults";
const DONE = "Done";
const MAX_DESC = 160;
const PHASES: [Phase, string][] = [
  ["setup", "Setup"],
  ["plan", "Plan"],
  ["implement", "Implement"],
  ["diagnose", "Diagnose"],
  ["review", "Review"],
  ["learn", "Learn"],
];

export interface Skill {
  name: string;
  description: string;
  body: string;
  files: { name: string; content: string }[];
}

/** Root of this package, so a skill can point at its scripts through the `{{package}}` placeholder. */
const packageDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const skillsDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "skills");

export async function listSkills(): Promise<string[]> {
  const entries = await fs.readdir(skillsDir(), { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && (await fs.access(path.join(skillsDir(), e.name, "SKILL.md")).then(() => true, () => false))) names.push(e.name);
  }
  return names.sort();
}

export async function loadSkill(name: string): Promise<Skill> {
  const dir = path.join(skillsDir(), name);
  const text = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const description = match?.[1].match(/^description:\s*(.*)$/m)?.[1].trim().replace(/^"([\s\S]*)"$/, "$1").replace(/\\"/g, '"') ?? "";
  const files = await Promise.all(
    (await fs.readdir(dir))
      .filter((f) => f.endsWith(".md") && f !== "SKILL.md")
      .sort()
      .map(async (f) => ({ name: f, content: await fs.readFile(path.join(dir, f), "utf8") })),
  );
  return { name, description, body: text.slice(match?.[0].length ?? 0).trim(), files };
}

export async function phaseSkills(root: string, phase: Phase): Promise<string[]> {
  const manifest = await readManifest(root).catch(() => undefined);
  return manifest?.skills?.[phase] ?? DEFAULT_SKILLS[phase];
}

export async function phaseOnDemand(root: string, phase: Phase): Promise<string[]> {
  const manifest = await readManifest(root).catch(() => undefined);
  return manifest?.skillsOnDemand?.[phase] ?? DEFAULT_ON_DEMAND[phase];
}

/** Cross-harness boilerplate that ends every pstack skill: the same ~1 KB would repeat in each phase prompt. */
const BOILERPLATE = "## Agent integration boundary";

/** Drops "call the Skill tool" / slash-invocation lines (the model has no such tool) and the boilerplate section; points to bundled skills instead. */
export function clean(text: string, bundled: string[]) {
  const out: string[] = [];
  let boilerplate = false;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) boilerplate = line.trim() === BOILERPLATE;
    if (boilerplate) continue;
    if (/Skill tool|\/pstack-[\w-]+/i.test(line)) {
      const refs = bundled.filter((n) => line.includes(n) || line.includes(n.replace(/^pstack-/, "")));
      if (refs.length) out.push(`(The referenced skill ${refs.join(", ")}, if bundled, is included below.)`);
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .trimEnd()
    .replace(/\.claude\/skills\//g, ".pi/skills/")
    .replace(/\bClaude\b/g, "the agent")
    .replace(/\{\{package\}\}/g, packageDir());
}

const cap = (text: string) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n\n[truncated]` : text);

/** Text to prepend to a phase prompt. Deterministic so prompt caching works. */
export async function skillsBlock(root: string, phase: Phase): Promise<string> {
  const bundled = await listSkills();
  const sections: string[] = [];
  for (const name of await phaseSkills(root, phase)) {
    if (!bundled.includes(name)) continue;
    const skill = await loadSkill(name);
    sections.push(`## Skill: ${name}\n\n${cap(clean(skill.body, bundled))}`);
    for (const f of skill.files) sections.push(`### ${f.name}\n\n${cap(clean(f.content.trim(), bundled))}`);
  }
  const index = await onDemandIndex(root, phase, bundled);
  if (index) sections.push(index);
  return sections.join("\n\n");
}

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESC ? `${flat.slice(0, MAX_DESC - 1)}…` : flat;
};

/** Compact index of the phase's on-demand skills (only bundled ones, none already injected); empty when there is nothing to list. */
async function onDemandIndex(root: string, phase: Phase, bundled: string[]): Promise<string> {
  const injected = await phaseSkills(root, phase);
  const names = (await phaseOnDemand(root, phase)).filter((n) => bundled.includes(n) && !injected.includes(n));
  if (!names.length) return "";
  const lines = ["## Skills on request", "", "Read a skill's SKILL.md only if the task needs it; do not read them otherwise."];
  for (const name of names) {
    lines.push(`- ${name}: ${oneLine((await loadSkill(name)).description)} (${path.join(skillsDir(), name, "SKILL.md")})`);
  }
  return lines.join("\n");
}

export function registerSkills(pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "Pick the skills each phase includes: setup, plan, implement, diagnose, review and learn",
    handler: async (_args, ctx: ExtensionContext) => {
      const root = ctx.cwd;
      const all = await listSkills();
      const manifest = await readManifest(root);
      const current = manifest.skills ?? {};
      const currentOD = manifest.skillsOnDemand ?? {};
      const now = (phase: Phase, source: Partial<Record<Phase, string[]>>) => (source[phase] ?? DEFAULT_SKILLS[phase]).join(", ") || "none";
      const nowOD = (phase: Phase, source: Partial<Record<Phase, string[]>>) => (source[phase] ?? DEFAULT_ON_DEMAND[phase]).join(", ");
      const show = (skills: Partial<Record<Phase, string[]>>, onDemand: Partial<Record<Phase, string[]>>) =>
        PHASES.map(([key, name]) => `${name}: ${now(key, skills)}${nowOD(key, onDemand) ? ` (on request: ${nowOD(key, onDemand)})` : ""}`).join("\n");
      ctx.ui.notify(show(current, currentOD), "info");

      const next = { ...current };
      const nextOD = { ...currentOD };
      const tag = (s: string) => (OPT_IN.includes(s) ? `${s} [opt-in]` : s);
      for (const [key, name] of PHASES) {
        let chosen = [...(next[key] ?? DEFAULT_SKILLS[key])];
        let onDemand = [...(nextOD[key] ?? DEFAULT_ON_DEMAND[key])];
        let changed = false;
        for (;;) {
          const options = [
            changed ? DONE : KEEP,
            DEFAULTS,
            ...all.map((s) => `${chosen.includes(s) ? "✓" : "·"} ${tag(s)}`),
            ...all.map((s) => `${onDemand.includes(s) ? "◆" : "◇"} ${tag(s)} (on request)`),
          ];
          const pick = await ctx.ui.select(`${name} (now: ${chosen.join(", ") || "none"}; on request: ${onDemand.join(", ") || "none"})`, options);
          if (!pick || pick === KEEP || pick === DONE) break;
          changed = true;
          if (pick === DEFAULTS) {
            delete next[key];
            delete nextOD[key];
            chosen = [...DEFAULT_SKILLS[key]];
            onDemand = [...DEFAULT_ON_DEMAND[key]];
            changed = false;
            break;
          }
          const skill = pick.slice(2).replace(/ \(on request\)$/, "").replace(/ \[opt-in\]$/, "");
          if (/^[◆◇]/.test(pick)) {
            onDemand = onDemand.includes(skill) ? onDemand.filter((s) => s !== skill) : [...onDemand, skill];
            chosen = chosen.filter((s) => s !== skill);
          } else {
            chosen = chosen.includes(skill) ? chosen.filter((s) => s !== skill) : [...chosen, skill];
            onDemand = onDemand.filter((s) => s !== skill);
          }
        }
        if (changed) {
          next[key] = chosen;
          if (onDemand.join() !== DEFAULT_ON_DEMAND[key].join()) nextOD[key] = onDemand;
          else delete nextOD[key];
        }
      }
      await updateManifest(root, (m) => {
        if (Object.keys(next).length) m.skills = next;
        else delete m.skills;
        if (Object.keys(nextOD).length) m.skillsOnDemand = nextOD;
        else delete m.skillsOnDemand;
      });
      ctx.ui.notify(show(next, nextOD), "info");
    },
  });
}
