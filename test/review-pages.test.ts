import assert from "node:assert/strict";
import { test } from "node:test";
import { collectPages, type Page } from "../scripts/review/pages.ts";

test("collectPages follows cursors until the last page", async () => {
  const pages: Record<string, Page<number>> = {
    start: { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: "a" } },
    a: { nodes: [3], pageInfo: { hasNextPage: true, endCursor: "b" } },
    b: { nodes: [4], pageInfo: { hasNextPage: false, endCursor: "c" } },
  };
  const seen: (string | null)[] = [];
  const all = await collectPages(async (cursor) => {
    seen.push(cursor);
    return pages[cursor ?? "start"] as Page<number>;
  });
  assert.deepEqual(all, [1, 2, 3, 4]);
  assert.deepEqual(seen, [null, "a", "b"]);
});

test("collectPages starts after a page the caller already has", async () => {
  const seen: (string | null)[] = [];
  const all = await collectPages(
    async (cursor) => {
      seen.push(cursor);
      return { nodes: [2], pageInfo: { hasNextPage: false, endCursor: null } };
    },
    { nodes: [1], pageInfo: { hasNextPage: true, endCursor: "a" } },
  );
  assert.deepEqual(all, [1, 2]);
  assert.deepEqual(seen, ["a"]);
});

test("collectPages throws when a next page has no cursor or repeats it", async () => {
  await assert.rejects(
    collectPages(async () => ({ nodes: [1], pageInfo: { hasNextPage: true, endCursor: null } })),
    /did not advance/,
  );
  await assert.rejects(
    collectPages(async () => ({ nodes: [1], pageInfo: { hasNextPage: true, endCursor: "a" } })),
    /did not advance/,
  );
});

test("collectPages throws when cursors cycle", async () => {
  const next: Record<string, string> = { start: "a", a: "b", b: "a" };
  await assert.rejects(
    collectPages(async (cursor) => ({
      nodes: [1],
      pageInfo: { hasNextPage: true, endCursor: next[cursor ?? "start"] ?? null },
    })),
    /did not advance/,
  );
});
