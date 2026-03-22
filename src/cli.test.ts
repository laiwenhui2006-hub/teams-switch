import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("status command prints Weekly for a free weekly-only quota", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "teams-switch-"));
  const opencodeDir = path.join(tempHome, ".opencode");
  const configPath = path.join(opencodeDir, "teams-switch.json");
  const preloadPath = path.join(tempHome, "mock-fetch.mjs");

  await fs.mkdir(opencodeDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      currentIndex: 0,
      lastSwitchTime: 0,
      accounts: [
        {
          id: "acct-1",
          accessToken: "token",
          email: "alice@example.com",
          planType: "free",
          addedAt: 0,
          isValid: true,
        },
      ],
    }),
    "utf8",
  );

  await fs.writeFile(
    preloadPath,
    [
      "globalThis.fetch = async () =>",
      "  new Response(JSON.stringify({",
      '    plan_type: "free",',
      "    rate_limit: {",
      "      primary_window: {",
      "        used_percent: 18,",
      "        reset_at: 1900000000,",
      "        limit_window_seconds: 604800,",
      "      },",
      "    },",
      "  }), {",
      "    status: 200,",
      '    headers: { "Content-Type": "application/json" },',
      "  });",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", preloadPath, "dist/src/cli.js", "status"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
        },
      },
    );

    assert.match(stdout, /Weekly 82%/);
    assert.match(stdout, /重置时间: Weekly/);
    assert.doesNotMatch(stdout, /Hourly 82%/);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
