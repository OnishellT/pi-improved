import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { checkSeparateProfiles, linkCredentials } from "../scripts/review/profile.ts";
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

test("a link to another main profile is replaced", async () => {
  const { main, pi } = await dirs();
  const other = join(main, "..", "other");
  mkdirSync(other);
  writeFileSync(join(other, "auth.json"), "{}");
  writeFileSync(join(main, "auth.json"), "{}");
  symlinkSync(join(other, "auth.json"), join(pi, "auth.json"));
  linkCredentials(main, pi, "openai");
  assert.equal(readlinkSync(join(pi, "auth.json")), join(main, "auth.json"));
});

test("a relative main dir is linked by its absolute path", async () => {
  const { main, pi } = await dirs();
  writeFileSync(join(main, "auth.json"), "{}");
  linkCredentials(relative(process.cwd(), main), pi, "openai");
  assert.equal(readlinkSync(join(pi, "auth.json")), join(main, "auth.json"));
});

test("a copied auth.json is replaced by a link", async () => {
  const { main, pi } = await dirs();
  writeFileSync(join(main, "auth.json"), "{}");
  writeFileSync(join(pi, "auth.json"), "{\"stale\":1}");
  linkCredentials(main, pi, "openai");
  assert.ok(lstatSync(join(pi, "auth.json")).isSymbolicLink());
});

test("a correct link is kept as is", async () => {
  const { main, pi } = await dirs();
  writeFileSync(join(main, "auth.json"), "{}");
  linkCredentials(main, pi, "openai");
  const before = lstatSync(join(pi, "auth.json")).ino;
  linkCredentials(main, pi, "openai");
  assert.equal(lstatSync(join(pi, "auth.json")).ino, before);
});

test("overlapping main and reviewer profiles are rejected", async () => {
  const { main, pi } = await dirs();
  assert.throws(() => checkSeparateProfiles(main, main), /overlaps the main pi profile/);
  assert.throws(() => checkSeparateProfiles(main, join(main, "reviewer")), /overlaps/);
  symlinkSync(main, join(pi, "alias"));
  assert.throws(() => checkSeparateProfiles(main, join(pi, "alias")), /overlaps/);
  checkSeparateProfiles(main, pi);
});
