import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export async function tempProject(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-improved-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
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
    registerMcpServer: (name: string, config: any) => mcp.push({ name, config }),
    getAllTools: () => [],
  };
  const emit = async (event: string, payload: any, ctx: any) => {
    let result;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
    return result;
  };
  return { pi, tools, commands, sent, mcp, emit };
}

/** The subagent CLI may be invoked by bare name or by its bundled absolute path. */
export const isSubagent = (cmd: string) => cmd === "subagent" || /(^|\/)subagent(\.ts)?$/.test(cmd);
