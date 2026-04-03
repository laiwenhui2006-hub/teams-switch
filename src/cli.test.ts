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
      cooldownUntil: 0,
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
      cooldownUntil: 0,
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

test("switch command treats weekly below 5 percent as ineligible and still picks the next eligible account", async () => {
  const { stdout } = await runCliWithConfig({
    config: {
      currentIndex: 0,
      cooldownUntil: 0,
      accounts: [
        {
          id: "acct-current",
          accessToken: "token-current",
          addedAt: 0,
          isValid: true,
          quota: {
            weekly: { remainingPercent: 50, resetAt: 1900000000, limitWindowSeconds: 604800 },
            hourly: { remainingPercent: 50, resetAt: 1900000100, limitWindowSeconds: 18000 },
          },
        },
        {
          id: "acct-weekly-low",
          accessToken: "token-weekly-low",
          addedAt: 0,
          isValid: true,
          quota: {
            weekly: { remainingPercent: 4, resetAt: 1900000200, limitWindowSeconds: 604800 },
            hourly: { remainingPercent: 99, resetAt: 1900000300, limitWindowSeconds: 18000 },
          },
        },
        {
          id: "acct-next-ok",
          accessToken: "token-next-ok",
          addedAt: 0,
          isValid: true,
          quota: {
            weekly: { remainingPercent: 7, resetAt: 1900000400, limitWindowSeconds: 604800 },
            hourly: { remainingPercent: 6, resetAt: 1900000500, limitWindowSeconds: 18000 },
          },
        },
        {
          id: "acct-healthiest-later",
          accessToken: "token-healthiest-later",
          addedAt: 0,
          isValid: true,
          quota: {
            weekly: { remainingPercent: 90, resetAt: 1900000600, limitWindowSeconds: 604800 },
            hourly: { remainingPercent: 90, resetAt: 1900000700, limitWindowSeconds: 18000 },
          },
        },
      ],
    },
    args: ["switch"],
  });

  assert.match(stdout, /已手动切换至账号: acct-next-ok/);
});

test("clean command removes banned accounts by default", async () => {
  const { stdout } = await runCliWithConfig({
    config: {
      currentIndex: 0,
      cooldownUntil: 0,
      accounts: [
        { id: "acct-1", accessToken: "token-1", addedAt: 0, isValid: true, isBanned: true },
        { id: "acct-2", accessToken: "token-2", addedAt: 0, isValid: true, isBanned: false },
      ],
    },
    args: ["clean"],
  });

  assert.match(stdout, /已清理 1 个被封禁账号，剩余账号数: 1/);
});

test("clean command with 'all' removes all accounts", async () => {
  const { stdout } = await runCliWithConfig({
    config: {
      currentIndex: 0,
      cooldownUntil: 0,
      accounts: [
        { id: "acct-1", accessToken: "token-1", addedAt: 0, isValid: true, isBanned: true },
        { id: "acct-2", accessToken: "token-2", addedAt: 0, isValid: true, isBanned: false },
      ],
    },
    args: ["clean", "all"],
  });

  assert.match(stdout, /已清理所有账号，共 2 个/);
});

test("clean command with specific name removes that account", async () => {
  const { stdout } = await runCliWithConfig({
    config: {
      currentIndex: 0,
      cooldownUntil: 0,
      accounts: [
        { id: "acct-1", accessToken: "token-1", addedAt: 0, isValid: true, isBanned: false },
        { id: "acct-2", accessToken: "token-2", addedAt: 0, isValid: true, isBanned: false, email: "test@example.com" },
      ],
    },
    args: ["clean", "test"],
  });

  assert.match(stdout, /已清理账号 \[test\]，剩余账号数: 1/);
});
