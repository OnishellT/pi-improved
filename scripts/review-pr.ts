// Local pull request reviewer: `npm run review -- <pr> [--dry-run] [--force]`.
// Builds curated context, runs the reviewer in a disposable worktree at the PR head, and
// posts one GitHub review with inline comments and a confidence score (README.md, "Reviewing pull requests").
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { contextDocs, linkedIssues, skipsMarkdownOnly } from "./review/context.ts";
import {
  changedLines,
  commentableLines,
  gitDiffCommand,
  splitDiffByFile,
  wholeFileChanges,
} from "./review/diff.ts";
import { planDelta } from "./review/delta.ts";
import { collectPages, type Page } from "./review/pages.ts";
import { parsePiStream } from "./review/pi-stream.ts";
import {
  buildReviewPayload,
  dedupeFindings,
  finalizeReview,
  pendingAttempt,
  planThreadActions,
  reviewGate,
  scopeFindings,
} from "./review/policy.ts";
import {
  decodeReview,
  findSecretLeak,
  inlineCommentBody,
  type Marker,
  missingVerdicts,
  parseMarker,
  renderBody,
  splitFindings,
  type Review,
} from "./review/result.ts";

// Tooling configuration: the reviewer CLI and its model.
const provider = "openai";
const model = process.env["REVIEW_MODEL"] ?? "gpt-6.1-terra";
const thinking = process.env["REVIEW_THINKING"] ?? "xhigh";
const timeoutMs = Number(process.env["REVIEW_TIMEOUT_MS"] ?? 10 * 60_000);
// Dedicated read-only pi profile, rebuilt from the repo's settings on every run.
const piDir = process.env["REVIEW_PI_DIR"] ?? join(homedir(), ".pi", "reviewer-pi-improved");
const piMainDir = process.env["PI_MAIN_DIR"] ?? join(homedir(), ".pi", "agent");
// Prompt and profile settings come from the PR's base branch when it has them (see main), so a
// PR cannot rewrite the reviewer that judges it; the local copies are the bootstrap fallback.
let piSettingsFile = resolve(import.meta.dirname, "review", "pi-settings.json");
// The reviewer reads untrusted text and can read files, so it gets a minimal environment:
// none of the caller's secrets.
const piEnv: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? homedir(),
  LANG: process.env["LANG"] ?? "C.UTF-8",
  TERM: "dumb",
  PI_CODING_AGENT_DIR: piDir,
  PI_TELEMETRY: "0",
};
let promptFile = resolve(import.meta.dirname, "review", "prompt.md");
// Home of the reviewer process: an empty scratch directory, not the owner's.
let reviewerHome = tmpdir();

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(
  cmd: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<Run> {
  return new Promise((resolvePromise) => {
    const [file = "", ...args] = cmd;
    const proc = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => (out += chunk));
    proc.stderr.on("data", (chunk: string) => (err += chunk));
    proc.on("error", (cause) => resolvePromise({ code: 127, out, err: err + String(cause) }));
    proc.on("close", (code) => resolvePromise({ code: code ?? -1, out, err }));
    proc.stdin.end(opts.stdin);
  });
}

async function sh(cmd: string[], opts: { cwd?: string; stdin?: string } = {}) {
  const result = await run(cmd, opts);
  if (result.code !== 0) {
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${result.code}): ${result.err.trim()}`);
  }
  return result.out;
}

const usageText = `usage: npm run review -- <pr> [--dry-run] [--force]

Reviews a pull request with the local reviewer and posts one review (inline comments,
summary, confidence 1-5). --dry-run prints the review instead of posting it. A head that already
has a local review is skipped, and from the fourth round on the run stops unless the last review had
confidence 4 or more; --force overrides both, and --dry-run ignores both.
Env: REVIEW_MODEL, REVIEW_THINKING, REVIEW_TIMEOUT_MS, REVIEW_IDLE_MS, REVIEW_PI_DIR, PI_MAIN_DIR. See README.md.`;

function parseArgs(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usageText);
    process.exit(0);
  }
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const pr = Number(positional[0]);
  const unknown = argv.filter(
    (arg) => arg.startsWith("--") && arg !== "--dry-run" && arg !== "--force",
  );
  if (positional.length !== 1 || !Number.isInteger(pr) || pr < 1 || unknown.length > 0) {
    throw new Error("usage: npm run review -- <pr> [--dry-run] [--force]");
  }
  return { pr, dryRun, force };
}

interface Thread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  firstCommentId: number;
  comments: { author: string; body: string; at: string }[];
}

interface PrData {
  repo: string;
  title: string;
  body: string;
  sha: string;
  base: string;
  issues: { number: number; body: string }[];
  threads: Thread[];
  earlierReviews: string[];
  earlierMarkers: Marker[];
  attempt: { incomplete: boolean; pendingThreadIds: Set<string> };
}

const threadsQuery = `
query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){
pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line
comments(first:50){pageInfo{hasNextPage endCursor}nodes{databaseId createdAt author{login} body}}}}}}}`;

const threadCommentsQuery = `
query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{
comments(first:50,after:$after){pageInfo{hasNextPage endCursor}nodes{databaseId createdAt author{login} body}}}}}`;

interface ThreadComment {
  databaseId: number;
  createdAt: string;
  author: { login: string } | null;
  body: string;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: Page<ThreadComment>;
}

async function graphqlPage<T>(query: string, vars: Record<string, string | number>, cursor: string | null) {
  const args = Object.entries(vars).flatMap(([key, value]) => ["-F", `${key}=${value}`]);
  if (cursor !== null) args.push("-F", `after=${cursor}`);
  return JSON.parse(await sh(["gh", "api", "graphql", ...args, "-f", `query=${query}`])) as T;
}

async function fetchThreads(owner: string, name: string, pr: number): Promise<ThreadNode[]> {
  const nodes = await collectPages(
    async (cursor) =>
      (
        await graphqlPage<{
          data: { repository: { pullRequest: { reviewThreads: Page<ThreadNode> } } };
        }>(threadsQuery, { owner, name, pr }, cursor)
      ).data.repository.pullRequest.reviewThreads,
  );
  // A thread with more than 50 comments loses the rest of them without this.
  for (const node of nodes) {
    if (!node.comments.pageInfo.hasNextPage) continue;
    const rest = await collectPages(
      async (cursor) =>
        (
          await graphqlPage<{ data: { node: { comments: Page<ThreadComment> } } }>(
            threadCommentsQuery,
            { id: node.id },
            cursor,
          )
        ).data.node.comments,
      node.comments,
    );
    node.comments.nodes = rest;
  }
  return nodes;
}

async function fetchPr(pr: number): Promise<PrData> {
  const repo = (
    await sh(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
  ).trim();
  const [owner = "", name = ""] = repo.split("/");
  const view = JSON.parse(
    await sh([
      "gh",
      "pr",
      "view",
      String(pr),
      "-R",
      repo,
      "--json",
      "title,body,headRefOid,baseRefName,reviews",
    ]),
  ) as {
    title: string;
    body: string;
    headRefOid: string;
    baseRefName: string;
    reviews: { body: string; submittedAt: string; author: { login: string } | null }[];
  };
  const threadNodes = await fetchThreads(owner, name, pr);
  const me = (await sh(["gh", "api", "user", "--jq", ".login"])).trim();
  const myReviews = view.reviews.filter((review) => review.author?.login === me);
  const issues = [];
  for (const number of linkedIssues(view.body)) {
    const issue = JSON.parse(
      await sh(["gh", "issue", "view", String(number), "-R", repo, "--json", "body"]),
    ) as { body: string };
    issues.push({ number, body: issue.body });
  }
  const sha = view.headRefOid;
  const attempt = pendingAttempt({
    head: sha,
    reviews: myReviews.flatMap((review) => {
      const marker = parseMarker(review.body);
      return marker ? [{ sha: marker.sha, at: review.submittedAt }] : [];
    }),
    threadComments: threadNodes.flatMap((node) =>
      node.comments.nodes
        .filter((comment) => comment.author?.login === me)
        .map((comment) => ({ threadId: node.id, body: comment.body, at: comment.createdAt })),
    ),
  });
  return {
    attempt,
    repo,
    title: view.title,
    body: view.body,
    sha: view.headRefOid,
    base: view.baseRefName,
    issues,
    threads: threadNodes.map((node) => ({
      id: node.id,
      isResolved: node.isResolved,
      firstCommentId: node.comments.nodes[0]?.databaseId ?? 0,
      path: node.path,
      line: node.line,
      comments: node.comments.nodes.map((comment) => ({
        author: comment.author?.login ?? "ghost",
        body: comment.body,
        at: comment.createdAt,
      })),
    })),
    earlierReviews: myReviews
      .map((review) => review.body)
      .filter((body) => parseMarker(body) !== undefined),
    earlierMarkers: myReviews.flatMap((review) => parseMarker(review.body) ?? []),
  };
}

function fenced(label: string, content: string) {
  return `## ${label}\n\n\`\`\`\`\`\n${content.trim()}\n\`\`\`\`\`\n`;
}

function readIfPresent(root: string, path: string) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

// Review policy (project documents, prompt, tool profile) is read from the base branch,
// so a pull request cannot rewrite the rules it is judged by or exclude itself from review.
interface Policy {
  read: (path: string) => string | undefined;
  list: (dir: string) => string[];
}

function basePolicy(base: string): Policy {
  const git = (...args: string[]) =>
    spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return {
    read: (path) => {
      const result = git("show", `origin/${base}:${path}`);
      return result.status === 0 ? result.stdout : undefined;
    },
    list: (dir) => {
      const result = git("ls-tree", "--name-only", `origin/${base}`, `${dir}/`);
      return result.status === 0
        ? result.stdout
            .split("\n")
            .filter(Boolean)
            .map((path) => path.split("/").pop() ?? "")
        : [];
    },
  };
}

function buildContext(
  policy: Policy,
  data: PrData,
  diff: string,
  paths: string[],
  commits: string,
  delta?: string,
  lastReviewed?: string,
  fullReason?: string,
) {
  const sections: string[] = [];
  for (const path of contextDocs(policy.list("docs"))) {
    const content = policy.read(path);
    if (content !== undefined) sections.push(fenced(`Project document: ${path}`, content));
  }
  sections.push(fenced("Pull request title and description", `${data.title}\n\n${data.body}`));
  for (const issue of data.issues)
    sections.push(fenced(`Linked issue #${issue.number}`, issue.body));
  if (data.earlierReviews.length > 0) {
    sections.push(
      fenced(
        "Earlier local reviews of this pull request",
        data.earlierReviews.join("\n\n---\n\n").replace(/<!--[\s\S]*?-->/g, ""),
      ),
    );
  }
  const threads =
    data.threads.length === 0
      ? "No earlier review threads."
      : data.threads
          .map((thread) => {
            const replies = thread.comments.map(
              (comment) => `  [${comment.author}] ${comment.body.replace(/\n/g, "\n    ")}`,
            );
            return `thread id: ${thread.id}\nstate: ${thread.isResolved ? "resolved" : "UNRESOLVED"}\nlocation: ${thread.path}:${thread.line ?? "outdated"}\n${replies.join("\n")}`;
          })
          .join("\n\n");
  sections.push(fenced("Earlier review threads (all reviewers)", threads));
  sections.push(fenced("Commits of the pull request (oldest last)", commits));
  if (delta !== undefined) {
    sections.push(
      `## Review mode: FOLLOW-UP\n\nThis is a follow-up round. The last reviewed commit is ${lastReviewed}. Review the delta below; the full diff that follows is background only. Report new findings only on lines changed in the delta (a critical problem anywhere is the one exception), and judge every unresolved earlier thread.\n\n${fenced("Delta since the last reviewed commit", delta)}`,
    );
  } else if (fullReason !== undefined) {
    sections.push(`## Review mode: FULL REVIEW\n\n${fullReason} Review the whole diff, and judge every unresolved earlier thread.\n`);
  } else {
    sections.push("## Review mode: FIRST REVIEW\n\nReview the whole diff.\n");
  }
  sections.push(
    `Changed files: ${paths.join(", ")}\nBase branch: ${data.base}. Head commit: ${data.sha}.\n\n${fenced("Diff", diff)}`,
  );
  return sections.join("\n");
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Creates or refreshes the reviewer's pi profile from the repo's settings and links the
// owner's credentials into it. Fails clearly when the provider is not signed in.
async function ensurePiProfile() {
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const settings = readFileSync(piSettingsFile, "utf8");
  const settingsPath = join(piDir, "settings.json");
  if (readIfPresent(piDir, "settings.json") !== settings) writeFileSync(settingsPath, settings);
  for (const file of ["auth.json", "models-store.json"]) {
    const source = join(piMainDir, file);
    const target = join(piDir, file);
    if (existsSync(target)) continue;
    if (isSymlink(target)) unlinkSync(target); // dangling: the main profile changed or signed out
    if (!existsSync(source)) {
      throw new Error(`${source} is missing: sign pi in to the openai provider first`);
    }
    symlinkSync(source, target);
  }
  const check = await run(["pi", "auth", "check", "--provider", provider, "--model", model], { env: piEnv });
  if (check.code !== 0 || !check.out.includes("ready")) {
    throw new Error(
      `pi is not ready for ${provider}/${model}: ${(check.out + check.err).trim().slice(0, 300)}`,
    );
  }
}

// Secret-bearing values of the owner's env file and provider credentials (configuration such
// as origins is not secret and may be quoted).
const secretKey = /secret|key|token|password|credential/i;

function localSecrets(clone: string): string[] {
  const values: string[] = [];
  const collect = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (secretKey.test(key)) values.push(value);
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([name, inner]) =>
        collect(inner, secretKey.test(key) ? key : name),
      );
    }
  };
  for (const file of [".env"]) {
    const content = readIfPresent(clone, file);
    if (content !== undefined) collect(parseEnv(content), "");
  }
  const auth = readIfPresent(piMainDir, "auth.json");
  if (auth !== undefined) {
    try {
      collect(JSON.parse(auth), "");
    } catch {
      // An unreadable credentials file has nothing to leak.
    }
  }
  return values;
}

const idleMs = Number(process.env["REVIEW_IDLE_MS"] ?? 120_000);

// Runs pi while streaming its JSON events: prints one progress line per turn, and kills the
// process when no event arrives for idleMs or the total time passes timeoutMs.
async function runPi(args: string[], cwd: string): Promise<Run> {
  const [file = "", ...rest] = args;
  const env = { ...piEnv, HOME: reviewerHome };
  const proc = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let lastEvent = Date.now();
  let killedFor = "";
  const kill = (reason: string) => {
    killedFor = reason;
    proc.kill("SIGKILL");
  };
  const total = setTimeout(() => kill(`over ${Math.round(timeoutMs / 1000)}s in total`), timeoutMs);
  const idle = setInterval(() => {
    if (Date.now() - lastEvent > idleMs) kill(`no event for ${Math.round(idleMs / 1000)}s`);
  }, 5000);
  let turns = 0;
  let out = "";
  let pending = "";
  const progress = (line: string) => {
    if (!line.startsWith("{")) return;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: { type?: string; name?: string }[] };
      };
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      turns += 1;
      const tools = (event.message.content ?? [])
        .filter((item) => item.type === "toolCall")
        .map((item) => item.name);
      console.error(`  turn ${turns}${tools.length > 0 ? `: ${tools.join(", ")}` : ": answer"}`);
    } catch {
      // Not an event line.
    }
  };
  let errText = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => (errText += chunk));
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (text: string) => {
    lastEvent = Date.now();
    out += text;
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(progress);
  });
  const code = await new Promise<number>((done) => {
    proc.on("error", () => done(127));
    proc.on("close", (exit) => done(exit ?? -1));
  });
  progress(pending);
  clearTimeout(total);
  clearInterval(idle);
  return { code: killedFor ? -1 : code, out, err: killedFor ? `killed: ${killedFor}` : errText };
}

const usage = { tokens: 0, costUsd: 0 };

// One reviewer run; a timeout or an empty answer is retried once.
async function runReviewer(
  worktree: string,
  contextFile: string,
  feedback?: string,
): Promise<string> {
  const task = feedback
    ? `Your previous answer was rejected: ${feedback}\nRe-check what you need and answer again, ending with the single fenced json block.`
    : "Review this pull request as instructed. End with the single fenced json block.";
  const args = [
    "pi",
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    thinking,
    "--no-context-files",
    "--no-mcp",
    "--append-system-prompt",
    promptFile,
    `@${contextFile}`,
    task,
  ];
  let lastProblem = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await runPi(args, worktree);
    const answer = parsePiStream(result.out);
    usage.tokens += answer.usage.tokens;
    usage.costUsd += answer.usage.costUsd;
    if (result.code === 0 && answer.text.trim() !== "") return answer.text;
    lastProblem =
      result.code === 0
        ? "empty answer"
        : `exit ${result.code}: ${result.err.trim().slice(0, 300) || "timed out"}`;
    console.error(
      `reviewer run ${attempt} failed (${lastProblem})${attempt === 1 ? ", retrying" : ""}`,
    );
  }
  throw new Error(`the reviewer failed twice: ${lastProblem}`);
}

async function reviewWithRetry(
  worktree: string,
  contextFile: string,
  openThreadIds: readonly string[],
): Promise<Review> {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await runReviewer(worktree, contextFile, feedback);
    const decoded = decodeReview(answer);
    const missing = decoded.ok ? missingVerdicts(decoded.review, openThreadIds) : [];
    if (decoded.ok && missing.length === 0) return decoded.review;
    feedback = decoded.ok
      ? `"resolved" must hold exactly one verdict for every open thread; missing: ${missing.join(", ")}`
      : decoded.error;
    console.error(`review result rejected (attempt ${attempt + 1}): ${feedback.slice(0, 300)}`);
  }
  throw new Error("the reviewer did not produce a valid result twice; nothing was posted");
}

const resolveMutation = `mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}`;

async function main() {
  const { pr, dryRun, force } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const data = await fetchPr(pr);
  const gate = reviewGate(data.earlierMarkers, data.sha, force || dryRun, data.attempt.incomplete);
  if (gate.action !== "run") {
    console.error(gate.message);
    process.exit(gate.action === "skip" ? 0 : 2);
  }
  const lastReviewed = data.earlierMarkers.at(-1)?.sha;
  const gitCommon = (
    await sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  const mainClone = dirname(gitCommon);
  await sh([
    "git",
    "fetch",
    "-q",
    "origin",
    `pull/${pr}/head`,
    `+refs/heads/${data.base}:refs/remotes/origin/${data.base}`,
  ]);
  const scratch = mkdtempSync(join(tmpdir(), `review-${pr}-`));
  const worktree = join(scratch, "tree");
  reviewerHome = join(scratch, "home");
  mkdirSync(reviewerHome);
  try {
    await run(["git", "worktree", "prune"]);
    await sh(["git", "worktree", "add", "--detach", worktree, data.sha]);
    const policy = basePolicy(data.base);
    for (const [name, assign] of [
      ["prompt.md", (path: string) => (promptFile = path)],
      ["pi-settings.json", (path: string) => (piSettingsFile = path)],
    ] as const) {
      const content = policy.read(`scripts/review/${name}`);
      if (content === undefined) continue;
      const path = join(scratch, name);
      writeFileSync(path, content);
      assign(path);
    }
    // Changed paths come from the diff: `gh pr view --json files` stops at 100 entries.
    // Built from the captured head, so a push during the run cannot change what is reviewed.
    const fullDiff = await sh(gitDiffCommand(`origin/${data.base}...${data.sha}`), {
      cwd: worktree,
    });
    const changed = splitDiffByFile(fullDiff).map((file) => file.path);
    const paths = changed;
    const diff = fullDiff;
    const commits = await sh(["git", "log", "--format=%h %s", `origin/${data.base}..${data.sha}`], {
      cwd: worktree,
    });
    // Follow-up rounds judge what changed since the last reviewed commit, unless a rebase or
    // force-push since then would mix the base branch's changes into that range.
    const plan = await planDelta(
      (args) => run(["git", ...args], { cwd: worktree }),
      lastReviewed,
      data.sha,
      `origin/${data.base}`,
    );
    const delta =
      plan.mode === "delta" ? await sh(gitDiffCommand(plan.range), { cwd: worktree }) : undefined;
    const fullReason = plan.mode === "full" ? plan.reason : undefined;
    const deltaChanged = delta === undefined ? undefined : splitDiffByFile(delta).map((file) => file.path);
    if (skipsMarkdownOnly(changed, lastReviewed !== undefined, deltaChanged)) {
      console.log(`PR #${pr} changes only Markdown files: no review needed.`);
      return;
    }
    const contextFile = join(scratch, "context.md");
    writeFileSync(
      contextFile,
      buildContext(policy, data, diff, paths, commits, delta, lastReviewed, fullReason),
    );
    console.error(
      `reviewing #${pr} at ${data.sha.slice(0, 7)} with ${provider}/${model}:${thinking} (${paths.length} files)...`,
    );
    await ensurePiProfile();
    const openThreads = new Map(
      data.threads.filter((thread) => !thread.isResolved).map((thread) => [thread.id, thread]),
    );
    const rawReview = await reviewWithRetry(worktree, contextFile, [...openThreads.keys()]);

    const threadInfos = data.threads.map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      path: thread.path,
      line: thread.line,
      firstCommentId: thread.firstCommentId,
      text: thread.comments.map((comment) => comment.body).join("\n"),
    }));
    const verdicts = (rawReview.resolved ?? []).filter((verdict) =>
      openThreads.has(verdict.threadId),
    );
    const notFixed = verdicts.filter((verdict) => verdict.verdict === "not_fixed").length;
    // Changed lines only: unchanged hunk context is not "changed since the last review".
    const deltaLines = delta === undefined ? undefined : changedLines(delta);
    const deltaPaths = wholeFileChanges(delta ?? "");
    const review = finalizeReview(
      rawReview,
      dedupeFindings(scopeFindings(rawReview.findings, deltaLines, deltaPaths), threadInfos),
      notFixed,
    );
    const { inline, outside } = splitFindings(review.findings, commentableLines(diff));
    const threadNotes = verdicts.map((verdict) => {
      const thread = openThreads.get(verdict.threadId);
      return `- \`${thread?.path}:${thread?.line ?? "outdated"}\` ${verdict.verdict === "fixed" ? "fixed" : "not fixed"}: ${verdict.note}`;
    });
    const body = renderBody({
      review,
      sha: data.sha,
      outside,
      threadNotes,
      notFixed,
      note: fullReason,
    });
    const secrets = localSecrets(mainClone);
    // Raw text, not JSON: escaping would hide secrets that hold quotes, backslashes or newlines.
    const outgoing = [body, ...inline.map(inlineCommentBody)].join("\n");
    if (findSecretLeak(outgoing, secrets)) {
      throw new Error("the review contains a local secret value; nothing was posted");
    }
    const payload = buildReviewPayload(data.sha, body, inline);
    if (dryRun) {
      console.log(JSON.stringify(payload, null, 2));
      console.log(`thread verdicts: ${JSON.stringify(verdicts)}`);
      console.error(
        `dry run done in ${Math.round((Date.now() - started) / 1000)}s; usage: ${usage.tokens} tokens, $${usage.costUsd.toFixed(4)}`,
      );
      return;
    }
    // Thread replies and resolutions go first: the review carries the head marker, so a
    // failure here is retried by the next run instead of being skipped for good.
    try {
      const actions = planThreadActions(verdicts, threadInfos, data.sha, data.attempt.pendingThreadIds);
      for (const reply of actions.replies) {
        await sh([
          "gh",
          "api",
          `repos/${data.repo}/pulls/${pr}/comments/${reply.commentId}/replies`,
          "-f",
          `body=${reply.body}`,
        ]);
      }
      for (const thread of actions.resolve) {
        await sh([
          "gh",
          "api",
          "graphql",
          "-f",
          `query=${resolveMutation}`,
          "-f",
          `thread=${thread}`,
        ]);
      }
      const posted = JSON.parse(
        await sh(["gh", "api", `repos/${data.repo}/pulls/${pr}/reviews`, "--input", "-"], {
          stdin: JSON.stringify(payload),
        }),
      ) as { html_url: string };
      console.log(
        `${posted.html_url}\nconfidence ${review.confidence}/5, ${review.findings.length} findings (${inline.length} inline), ${Math.round((Date.now() - started) / 1000)}s; usage: ${usage.tokens} tokens, $${usage.costUsd.toFixed(4)}`,
      );
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${reason}\nThe run failed after it started posting: run it again to resume.`,
      );
    }
  } finally {
    await run(["git", "worktree", "remove", "--force", worktree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
