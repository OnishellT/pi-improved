import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SKILLS, readManifest, updateManifest, type Phase } from "./manifest.ts";

const MAX_BODY = 12_000;
const KEEP = "Sin cambios";
const DEFAULTS = "Por defecto";
const DONE = "Listo";
const PHASES: [Phase, string][] = [
  ["setup", "Setup"],
  ["plan", "Plan"],
  ["implement", "Implementación"],
  ["diagnose", "Diagnóstico"],
  ["review", "Revisión"],
  ["learn", "Aprendizaje"],
];

export interface Skill {
  name: string;
  description: string;
  body: string;
  files: { name: string; content: string }[];
}

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

/** Drops "call the Skill tool" / slash-invocation lines (the model has no such tool); points to bundled skills instead. */
function clean(text: string, bundled: string[]) {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/Skill tool|\/pstack-[\w-]+/i.test(line)) {
      const refs = bundled.filter((n) => line.includes(n) || line.includes(n.replace(/^pstack-/, "")));
      if (refs.length) out.push(`(The referenced skill ${refs.join(", ")}, if bundled, is included below.)`);
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\.claude\/skills\//g, ".pi/skills/")
    .replace(/\bClaude\b/g, "the agent");
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
  return sections.join("\n\n");
}

export function registerSkills(pi: ExtensionAPI) {
  pi.registerCommand("skills", {
    description: "Elige qué skills incluye cada fase: setup, plan, implementación, diagnóstico, revisión y aprendizaje",
    handler: async (_args, ctx: ExtensionContext) => {
      const root = ctx.cwd;
      const all = await listSkills();
      const current = (await readManifest(root)).skills ?? {};
      const now = (phase: Phase, source: Partial<Record<Phase, string[]>>) => (source[phase] ?? DEFAULT_SKILLS[phase]).join(", ") || "ninguna";
      ctx.ui.notify(PHASES.map(([key, name]) => `${name}: ${now(key, current)}`).join("\n"), "info");

      const next = { ...current };
      for (const [key, name] of PHASES) {
        let chosen = [...(next[key] ?? DEFAULT_SKILLS[key])];
        let changed = false;
        for (;;) {
          const options = [changed ? DONE : KEEP, DEFAULTS, ...all.map((s) => `${chosen.includes(s) ? "✓" : "·"} ${s}`)];
          const pick = await ctx.ui.select(`${name} (ahora: ${chosen.join(", ") || "ninguna"})`, options);
          if (!pick || pick === KEEP || pick === DONE) break;
          changed = true;
          if (pick === DEFAULTS) {
            delete next[key];
            chosen = [...DEFAULT_SKILLS[key]];
            changed = false;
            break;
          }
          const skill = pick.slice(2);
          chosen = chosen.includes(skill) ? chosen.filter((s) => s !== skill) : [...chosen, skill];
        }
        if (changed) next[key] = chosen;
      }
      await updateManifest(root, (m) => {
        if (Object.keys(next).length) m.skills = next;
        else delete m.skills;
      });
      ctx.ui.notify(PHASES.map(([key, name]) => `${name}: ${now(key, next)}`).join("\n"), "info");
    },
  });
}
