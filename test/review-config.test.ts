import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseArgs, reviewConfig } from "../scripts/review/config.ts";

test("defaults: openai, gpt-6.1-terra, xhigh, profiles under ~/.pi", () => {
  const config = reviewConfig({}, "/h");
  assert.deepEqual(
    [config.provider, config.model, config.thinking, config.piDir, config.piMainDir],
    ["openai", "gpt-6.1-terra", "xhigh", "/h/.pi/reviewer-pi-improved", "/h/.pi/agent"],
  );
});

test("REVIEW_PROVIDER overrides the provider", () => {
  assert.equal(reviewConfig({ REVIEW_PROVIDER: "anthropic" }, "/h").provider, "anthropic");
});

test("the main pi dir honors PI_CODING_AGENT_DIR, and PI_MAIN_DIR over it", () => {
  assert.equal(reviewConfig({ PI_CODING_AGENT_DIR: "/p" }, "/h").piMainDir, "/p");
  assert.equal(reviewConfig({ PI_CODING_AGENT_DIR: "/p", PI_MAIN_DIR: "/m" }, "/h").piMainDir, "/m");
});

test("the profile settings leave provider and model to the command-line flags", () => {
  const settings = JSON.parse(readFileSync(new URL("../scripts/review/pi-settings.json", import.meta.url), "utf8"));
  assert.equal(settings.defaultProvider, undefined);
  assert.equal(settings.defaultModel, undefined);
});

test("parseArgs takes one PR number and the known flags", () => {
  assert.deepEqual(parseArgs(["19", "--dry-run"]), { help: false, pr: 19, dryRun: true, force: false });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["19", "20"]), /usage/);
});

test("parseArgs names an unknown single-dash or double-dash option", () => {
  assert.throws(() => parseArgs(["19", "-f"]), /unknown option: -f/);
  assert.throws(() => parseArgs(["-n", "5"]), /unknown option: -n/);
  assert.throws(() => parseArgs(["5", "--fast"]), /unknown option: --fast/);
});
