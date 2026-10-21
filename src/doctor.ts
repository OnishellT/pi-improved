import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveBin } from "./bin.ts";
import { bundledExtension, hasGlobalSubagent } from "./subagent-ext.ts";
import { readManifest } from "./manifest.ts";

const MIN_NODE = [22, 18];

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export const nodeOk = (version: string) => {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

/** Environment checks. Never throws. */
export async function runDoctor(pi: ExtensionAPI, ctx: ExtensionContext, version = process.versions.node): Promise<Check[]> {
  const probe = async (cmd: string, args: string[]) => {
    try {
      return (await pi.exec(cmd, args, { cwd: ctx.cwd, timeout: 15_000 })).code === 0;
    } catch {
      return false;
    }
  };
  const checks: Check[] = [];
  checks.push({ name: "Node", ok: nodeOk(version), detail: nodeOk(version) ? version : `${version}: se necesita >= ${MIN_NODE.join(".")}` });
  const subagent = resolveBin("subagent");
  const subagentOk = await probe(subagent, ["list"]);
  checks.push({ name: "subagent", ok: subagentOk, detail: subagentOk ? subagent : "no se encontró o no corre (reinstala con `pi install git:github.com/OnishellT/pi-improved`)" });
  const agentlint = resolveBin("agentlint");
  const agentlintOk = await probe(agentlint, ["--help"]);
  checks.push({ name: "agentlint", ok: agentlintOk, detail: agentlintOk ? agentlint : "no se encontró o no corre" });
  const ext = hasGlobalSubagent() ? "global" : fs.existsSync(bundledExtension()) ? "empaquetada" : undefined;
  checks.push({ name: "extensión subagent", ok: Boolean(ext), detail: ext ?? "falta: sin ella la revisión nunca termina (reinstala el paquete)" });
  const tmuxOk = await probe("tmux", ["-V"]);
  checks.push({ name: "tmux", ok: tmuxOk, detail: tmuxOk ? "ok" : "no está instalado: la revisión con subagente lo necesita (apt/brew install tmux)" });
  const gitOk = await probe("git", ["--version"]);
  checks.push({ name: "git", ok: gitOk, detail: gitOk ? "ok" : "no está instalado" });

  const wanted = Object.values((await readManifest(ctx.cwd).catch(() => undefined))?.models ?? {}).filter((m): m is string => Boolean(m));
  if (wanted.length && ctx.modelRegistry) {
    const available = new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));
    const missing = [...new Set(wanted)].filter((m) => !available.has(m));
    checks.push({
      name: "Modelos",
      ok: !missing.length,
      detail: missing.length ? `no disponibles: ${missing.join(", ")}. Corre /login <provider> para: ${[...new Set(missing.map((m) => m.split("/")[0]))].join(", ")}` : "ok",
    });
  }
  return checks;
}

let warned = false;

export function registerDoctor(pi: ExtensionAPI) {
  pi.registerCommand("doctor", {
    description: "Revisa que el entorno tenga todo lo que pi-improved necesita",
    handler: async (_args, ctx) => {
      const checks = await runDoctor(pi, ctx);
      ctx.ui.notify(checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n"), checks.every((c) => c.ok) ? "info" : "warning");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    const bad = (await runDoctor(pi, ctx)).filter((c) => !c.ok);
    if (bad.length) ctx.ui.notify(`Falta algo en el entorno (${bad.map((c) => c.name).join(", ")}). Corre /doctor.`, "warning");
  });
}
