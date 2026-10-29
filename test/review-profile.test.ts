import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { linkCredentials } from "../scripts/review/profile.ts";
import { tempDir } from "./helpers.ts";

async function dirs() {
  const root = await tempDir("review-profile-");
  const main = join(root, "main");
  const pi = join(root, "pi");
  mkdirSync(main);
  mkdirSync(pi);
  return { main, pi };
}

test("auth.json is symlinked, not copied, and a missing models-store.json is fine", async () => {
  const { main, pi } = await dirs();
  writeFileSync(join(main, "auth.json"), "{}");
  linkCredentials(main, pi, "openai");
  assert.ok(lstatSync(join(pi, "auth.json")).isSymbolicLink());
  assert.equal(readlinkSync(join(pi, "auth.json")), join(main, "auth.json"));
  assert.throws(() => lstatSync(join(pi, "models-store.json")));
});

test("models-store.json is linked when present", async () => {
  const { main, pi } = await dirs();
  writeFileSync(join(main, "auth.json"), "{}");
  writeFileSync(join(main, "models-store.json"), "{}");
  linkCredentials(main, pi, "openai");
  assert.ok(lstatSync(join(pi, "models-store.json")).isSymbolicLink());
});

test("a missing auth.json names the provider to sign in to", async () => {
  const { main, pi } = await dirs();
  assert.throws(() => linkCredentials(main, pi, "anthropic"), /auth\.json is missing: sign pi in to the anthropic provider/);
});
