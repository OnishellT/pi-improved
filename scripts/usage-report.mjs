#!/usr/bin/env node
// Reports what local Pi sessions cost: per day, per model, per subagent, and by context size of the turn.
// Run as: node scripts/usage-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root ~/.pi/agent]
// Cost comes from each assistant message's usage.cost.total (what Pi already computed). Unknown data is reported as
// warnings, never as a failure.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "0000-00-00" },
    until: { type: "string", default: "9999-99-99" },
    root: { type: "string", default: process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent") },
  },
});

for (const key of ["since", "until"]) {
  const v = values[key];
  if (v !== "0000-00-00" && v !== "9999-99-99" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    console.error(`--${key} must be YYYY-MM-DD, got "${v}"`);
    process.exit(1);
  }
}

const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
const warnings = [];
const warn = (msg) => warnings.push(msg);

async function list(dir) {
  try {
    return await readdir(dir, { recursive: true });
  } catch {
    warn(`cannot read ${dir}`);
    return [];
  }
}

/** Subagent runs: session file -> handle, from subagents/<run>/metadata.json. */
async function subagentFiles(root) {
  const map = new Map();
  const dir = path.join(root, "subagents");
  for (const e of (await list(dir)).filter((e) => e.endsWith("metadata.json"))) {
    try {
      const meta = JSON.parse(await readFile(path.join(dir, e), "utf8"));
      if (typeof meta.sessionFile === "string") map.set(path.resolve(meta.sessionFile), String(meta.handle ?? path.dirname(e)));
      else warn(`${e}: no sessionFile`);
    } catch {
      warn(`${e}: unreadable metadata`);
    }
  }
  return map;
}

async function scan(root) {
  const subs = await subagentFiles(root);
  const files = new Set([...subs.keys()]);
  for (const e of await list(path.join(root, "sessions"))) if (e.endsWith(".jsonl")) files.add(path.resolve(root, "sessions", e));
  const turns = [];
  const seen = new Set();
  for (const file of [...files].sort()) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      warn(`${file}: unreadable`);
      continue;
    }
    let bad = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        bad++;
        continue;
      }
      const m = d?.message;
      if (m?.role !== "assistant" || !m.usage) continue;
      const cost = m.usage.cost?.total;
      if (typeof cost !== "number") {
        warn(`${path.basename(file)}: assistant message without usage.cost.total (left out)`);
        continue;
      }
      const key = d.id ? `${file}#${d.id}` : undefined;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const ts = typeof d.timestamp === "string" ? d.timestamp : typeof m.timestamp === "number" ? new Date(m.timestamp).toISOString() : undefined;
      if (!ts) {
        warn(`${path.basename(file)}: message without timestamp (left out)`);
        continue;
      }
      const u = m.usage;
      turns.push({ day: ts.slice(0, 10), model: m.model ?? "unknown", cost, ctx: num(u.input) + num(u.cacheRead) + num(u.cacheWrite), sub: subs.get(file) });
    }
    if (bad) warn(`${path.basename(file)}: ${bad} unparseable line(s) skipped`);
  }
  return turns;
}

const usd = (n, w = 9) => `$${n.toFixed(2).padStart(w)}`;

function report(all, { since, until }) {
  const rows = all.filter((t) => t.day >= since && t.day <= until);
  const total = rows.reduce((s, t) => s + t.cost, 0);
  const pct = (c) => `${((c / (total || 1)) * 100).toFixed(1).padStart(5)}%`;
  const out = [`${rows.length} assistant turns from ${since} to ${until}: $${total.toFixed(2)}`];
  const table = (title, keyOf, byKey) => {
    const g = new Map();
    for (const t of rows) {
      const k = keyOf(t);
      if (k === undefined) continue;
      const [n, c] = g.get(k) ?? [0, 0];
      g.set(k, [n + 1, c + t.cost]);
    }
    out.push("", `== ${title} ==`);
    const sorted = [...g].sort(byKey ? (a, b) => (a[0] < b[0] ? -1 : 1) : (a, b) => b[1][1] - a[1][1]);
    for (const [k, [n, c]] of sorted) out.push(`  ${usd(c)} ${pct(c)}  turns=${String(n).padStart(5)}  ${k}`);
  };
  table("by day (UTC)", (t) => t.day, true);
  table("by model", (t) => t.model);
  table("by subagent", (t) => t.sub);
  out.push("", "== share of turns by context size ==");
  for (const [lo, hi] of [[0, 50e3], [50e3, 100e3], [100e3, 200e3], [200e3, Infinity]]) {
    const sel = rows.filter((t) => t.ctx >= lo && t.ctx < hi);
    const label = hi === Infinity ? `${lo / 1e3}K+` : `${lo / 1e3}-${hi / 1e3}K`;
    out.push(`  ${label.padStart(9)}: ${((sel.length / (rows.length || 1)) * 100).toFixed(1).padStart(5)}% of turns  turns=${sel.length}  ${usd(sel.reduce((s, t) => s + t.cost, 0))}`);
  }
  return out.join("\n");
}

const turns = await scan(values.root);
console.log(report(turns, values));
for (const w of [...new Set(warnings)]) console.log(`warning: ${w}`);
if (!turns.length) console.log(`warning: no priced assistant turns found under ${values.root}`);
