import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runCliWithConfig(options: {
  config: object;
  args: string[];
  preloadSource?: string;
}): Promise<{ stdout: string; stderr: string }> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "teams-switch-"));
  const opencodeDir = path.join(tempHome, ".opencode");
  const configPath = path.join(opencodeDir, "teams-switch.json");
  const preloadPath = path.join(tempHome, "mock-fetch.mjs");

  await fs.mkdir(opencodeDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(options.config), "utf8");
  await fs.writeFile(preloadPath, options.preloadSource ?? "", "utf8");

  try {
    return await execFileAsync(
      process.execPath,
      ["--import", preloadPath, "dist/src/cli.js", ...options.args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
        },
      },
    );
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

test("status command prints Weekly for a free weekly-only quota", async () => {
  const { stdout } = await runCliWithConfig({
    config: {
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
    },
    args: ["status"],
    preloadSource: [
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
  });

  assert.match(stdout, /Weekly 82%/);
  assert.match(stdout, /重置时间: Weekly/);
  assert.doesNotMatch(stdout, /Hourly 82%/);
});

test("switch command skips accounts below the 5 percent quota threshold", async () => {
  const { stdout } = await runCliWithConfig({
    config: {
      currentIndex: 0,
      lastSwitchTime: 0,
      accounts: [
        {
          id: "acct-current",
          accessToken: "token-current",
          addedAt: 0,
          isValid: true,
          quota: {
            hourly: { remainingPercent: 80, resetAt: 1900000000, limitWindowSeconds: 18000 },
          },
        },
        {
          id: "acct-low",
          accessToken: "token-low",
          addedAt: 0,
          isValid: true,
          quota: {
            hourly: { remainingPercent: 4, resetAt: 1900000000, limitWindowSeconds: 18000 },
          },
        },
        {
          id: "acct-ok",
          accessToken: "token-ok",
          addedAt: 0,
          isValid: true,
          quota: {
            hourly: { remainingPercent: 5, resetAt: 1900000000, limitWindowSeconds: 18000 },
          },
        },
      ],
    },
    args: ["switch"],
  });

  assert.match(stdout, /已手动切换至账号: acct-ok/);
});
