import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { desktopWrapper } from "../src/computer/desktop.ts";
import { which } from "../src/computer/which.ts";

test("the bundled wrapper is executable, since it is registered as the MCP command", () => {
  fs.accessSync(desktopWrapper(), fs.constants.X_OK);
});

test("session.py unit tests", { skip: !which("python3") }, () => {
  const run = spawnSync("python3", ["-B", "-m", "unittest", "test_session"], { cwd: path.dirname(desktopWrapper()), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
