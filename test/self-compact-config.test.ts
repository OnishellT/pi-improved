import test from "node:test";
import assert from "node:assert/strict";
import { checkThresholds, parseThreshold, profileForModel, resolveConfig, sanitizeStatus, thresholdState, thresholdTokens } from "../src/self-compact/config.ts";
import { parseProfileFile } from "../src/self-compact/profile.ts";

test("parses absolute, suffixed, and percentage thresholds", () => {
  assert.equal(parseThreshold("120").value, 120);
  assert.equal(parseThreshold("2.5k").value, 2500);
  assert.equal(parseThreshold("1m").value, 1_000_000);
  assert.equal(parseThreshold("35%").value, 0.35);
  assert.throws(() => parseThreshold("91%"));
  assert.throws(() => parseThreshold("0"));
});

test("resolves defaults and configurable values", () => {
  const config = resolveConfig();
  assert.equal(config.notice.label, "75%");
  assert.equal(config.warning.label, "85%");
  assert.equal(config.force.label, "90%");
  assert.equal(resolveConfig({ notice: "225k", warning: "250k", force: "270k" }).force.value, 270_000);
  assert.throws(() => resolveConfig({ buffer: -1 }));
});

test("validates the profile file schema", () => {
  assert.deepEqual(parseProfileFile('{"default":{"notice":"60%"},"models":{"anthropic/claude-sonnet-5-5":{"force":"82%"}}}'), {
    default: { notice: "60%" }, models: { "anthropic/claude-sonnet-5-5": { force: "82%" } },
  });
  assert.throws(() => parseProfileFile('{"models":{"bad-key":{"force":"80%"}}}'));
  assert.throws(() => parseProfileFile('{"default":{"unknown":1}}'));
});

test("merges provider/model profiles with project values taking priority", () => {
  const global = profileForModel({ default: { notice: "70%" }, models: { "anthropic/claude-sonnet-5-5": { force: "82%" } } }, "anthropic", "claude-sonnet-5-5");
  const project = profileForModel({ default: { notice: "60%" }, models: { "anthropic/claude-sonnet-5-5": { warning: "72%" } } }, "anthropic", "claude-sonnet-5-5");
  const config = resolveConfig({}, { ...global, ...project });
  assert.equal(config.notice.label, "60%");
  assert.equal(config.warning.label, "72%");
  assert.equal(config.force.label, "82%");
  assert.equal(resolveConfig({ notice: "55%" }, { ...global, ...project }).notice.label, "55%");
});

test("reports threshold states and resolves percentage markers against effective context", () => {
  const config = resolveConfig({ notice: "10%", warning: "20%", force: "30%" });
  assert.equal(thresholdTokens(config.warning, 1_000), 200);
  assert.equal(thresholdTokens(config.notice, 1_000_000), 100_000);
  assert.equal(thresholdTokens(config.notice, 200_000), 20_000);
  assert.equal(thresholdTokens(resolveConfig({ notice: "225k" }).notice, 200_000), 225_000);
  assert.equal(thresholdState(99, 1_000, config), "below");
  assert.equal(thresholdState(100, 1_000, config), "notice");
  assert.equal(thresholdState(200, 1_000, config), "warning");
  assert.equal(thresholdState(300, 1_000, config), "force");
  assert.throws(() => thresholdState(100, 1_000, resolveConfig({ notice: "30%", warning: "20%", force: "40%" })));
});

test("checkThresholds validates threshold ordering", () => {
  const config = resolveConfig({ notice: "10%", warning: "20%", force: "30%" });
  assert.equal(checkThresholds(config, 1_000), undefined);
  
  const misordered = resolveConfig({ notice: "30%", warning: "20%", force: "40%" });
  assert.ok(checkThresholds(misordered, 1_000));
});

test("checkThresholds reports when force >= window", () => {
  const config = resolveConfig({ notice: "10%", warning: "20%", force: "100k" });
  const error = checkThresholds(config, 1_000);
  assert.ok(error);
  assert.match(error, /less than the context window size/);
});

test("sanitizeStatus removes carriage returns, newlines, and tabs", () => {
  assert.equal(sanitizeStatus("hello world"), "hello world");
  assert.equal(sanitizeStatus("hello\nworld"), "hello world");
  assert.equal(sanitizeStatus("hello\r\nworld"), "hello world");
  assert.equal(sanitizeStatus("hello\tworld"), "hello world");
  assert.equal(sanitizeStatus("hello\nworld\nhere"), "hello world here");
  assert.equal(sanitizeStatus("\r\n\thello\r\n\tworld\r\n\t"), "hello world");
});
