import { mkdtempSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";

// Every temp dir a test creates; removed once when the importing test file finishes.
const created: string[] = [];
after(async () => {
  await Promise.all(created.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// Tests must never touch the real ~/.pi/agent (trust.json, subagent runs): point it at a temp dir for this test file.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-improved-agent-"));
created.push(process.env.PI_CODING_AGENT_DIR);

export async function tempDir(prefix = "pi-improved-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function tempProject(files: Record<string, string>) {
  const root = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}

/** Set env vars for `run` (undefined deletes), then put the previous values back. */
export async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

/** Scripted UI: each dialog consumes the next queued answer. */
export function fakeUI(answers: unknown[]) {
  const asked: string[] = [];
  const next = (title: string) => {
    asked.push(title);
    if (!answers.length) throw new Error(`Unexpected dialog: ${title}`);
    return Promise.resolve(answers.shift());
  };
  return {
    asked,
    select: (title: string) => next(title),
    confirm: (title: string) => next(title),
    input: (title: string) => next(title),
    notify: () => {},
    setStatus: () => {},
  };
}

/** Session context with a scripted UI; `extra` adds or overrides fields (mode, reload, ...). */
export function fakeCtx(root: string, answers: unknown[], extra: object = {}) {
  const ui = fakeUI(answers);
  return { ui, ctx: { cwd: root, hasUI: true, ui, waitForIdle: async () => {}, ...extra } as any };
}

/** Minimal ExtensionAPI double: records registrations and scripts exec results. */
export function fakePi(exec: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const sent: string[] = [];
  const mcp: { name: string; config: any }[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    exec: async (cmd: string, args: string[]) => ({ stdout: "", stderr: "", killed: false, ...exec(cmd, args) }),
    sendUserMessage: (text: string) => {
      sent.push(text);
      for (const handler of handlers.get("agent_start") ?? []) handler({}, {});
    },
    getMcpServers: () => mcp,
    registerMcpServer: (name: string, config: any) => {
      const at = mcp.findIndex((m) => m.name === name);
      if (at >= 0) mcp[at] = { name, config };
      else mcp.push({ name, config });
    },
    unregisterMcpServer: (name: string) => {
      const at = mcp.findIndex((m) => m.name === name);
      if (at >= 0) mcp.splice(at, 1);
    },
    getAllTools: () => [],
  };
  const emit = async (event: string, payload: any, ctx: any) => {
    let result;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
    return result;
  };
  return { pi, tools, commands, sent, mcp, emit };
}

/** A successful exec result. */
export const ok = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });

/**
 * exec double for a subagent review: spawn records the brief file, wait answers `opts.wait`.
 * `git` answers git calls by their args (default: empty output).
 */
export function fakeSubagentExec(opts: { spawn?: any; wait?: any; git?: (args: string[]) => string } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  let brief = "";
  const exec: any = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "git") return ok(opts.git?.(args) ?? "");
    if (args[0] === "spawn") {
      brief = readFileSync(args[args.indexOf("--file") + 1], "utf8");
      return opts.spawn ?? ok("Spawned review (a1b2c3)\nState: busy\n");
    }
    if (args[0] === "wait") return opts.wait ?? ok();
    return ok();
  };
  return { exec, calls, brief: () => brief };
}

/** The subagent CLI may be invoked by bare name or by its bundled absolute path. */
export const isSubagent = (cmd: string) => cmd === "subagent" || /(^|\/)subagent(\.ts)?$/.test(cmd);
