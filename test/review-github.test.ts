import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchThreads, graphqlArgs, remoteFor } from "../scripts/review/github.ts";

test("remoteFor picks the remote of the PR's repository, not origin", () => {
  const remotes = [
    "origin\tgit@github.com:me/pi-improved.git (fetch)",
    "origin\tgit@github.com:me/pi-improved.git (push)",
    "upstream\thttps://github.com/OnishellT/pi-improved (fetch)",
    "mirror\tssh://git@gitlab.com/x/y.git (fetch)",
  ].join("\n");
  assert.equal(remoteFor("https://github.com/OnishellT/pi-improved", remotes), "upstream");
  assert.equal(remoteFor("https://github.com/me/pi-improved", remotes), "origin");
  assert.throws(() => remoteFor("https://github.com/other/repo", remotes), /no git remote fetches/);
  // The host counts: the same owner and name on another host is another repository.
  assert.throws(() => remoteFor("https://github.com/x/y", remotes), /no git remote fetches/);
  // Only fetch URLs count: a push URL to the repository does not make a fork's remote fit.
  const fork = "fork\thttps://github.com/me/y (fetch)\nfork\thttps://github.com/x/y (push)";
  assert.throws(() => remoteFor("https://github.com/x/y", fork), /no git remote/);
  // A numeric owner in an scp-style URL is a path, not a port.
  assert.equal(remoteFor("https://github.com/123/repo", "n\tgit@github.com:123/repo.git (fetch)"), "n");
  assert.equal(remoteFor("https://github.com/o/r", "p\tssh://git@github.com:22/o/r.git (fetch)"), "p");
});

test("graphqlArgs sends strings raw with -f and numbers with -F", () => {
  assert.deepEqual(graphqlArgs("Q", { owner: "123", name: "true", pr: 7 }), [
    "api",
    "graphql",
    "-f",
    "owner=123",
    "-f",
    "name=true",
    "-F",
    "pr=7",
    "-f",
    "query=Q",
  ]);
});

const comment = (id: number) => ({ databaseId: id, createdAt: "t", author: { login: "a" }, body: `c${id}` });
const page = <T>(nodes: T[], next: string | null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });

test("fetchThreads follows thread pages and a long thread's comment pages", async () => {
  const calls: Record<string, string | number>[] = [];
  const graphql = async (query: string, vars: Record<string, string | number>) => {
    calls.push(vars);
    if (query.includes("node(id:")) return { data: { node: { comments: page([comment(2)], null) } } };
    const threads =
      vars["after"] === undefined
        ? page([{ id: "T1", isResolved: false, path: "a.ts", line: 1, comments: page([comment(1)], "c1") }], "t1")
        : page([{ id: "T2", isResolved: true, path: "b.ts", line: null, comments: page([comment(3)], null) }], null);
    return { data: { repository: { pullRequest: { reviewThreads: threads } } } };
  };
  const nodes = await fetchThreads(graphql, "o", "n", 5);
  assert.deepEqual(nodes.map((node) => [node.id, node.comments.nodes.map((c) => c.databaseId)]), [
    ["T1", [1, 2]],
    ["T2", [3]],
  ]);
  assert.deepEqual(calls, [
    { owner: "o", name: "n", pr: 5 },
    { owner: "o", name: "n", pr: 5, after: "t1" },
    { id: "T1", after: "c1" },
  ]);
});
