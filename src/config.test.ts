import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAccountValidity,
  fetchUsageMetadata,
  findNextEligibleAccountIndex,
  getQuotaShortageWindow,
  type Account,
} from "./config.js";

interface MockQuotaWindow {
  used_percent: number;
  reset_at: number;
  limit_window_seconds: number;
}

function createWindow(usedPercent: number, resetAt: number, limitWindowSeconds: number): MockQuotaWindow {
  return {
    used_percent: usedPercent,
    reset_at: resetAt,
    limit_window_seconds: limitWindowSeconds,
  };
}

async function withMockedFetch(
  payload: object,
  callback: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const mockFetch: typeof fetch = async (_input, _init) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = mockFetch;
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? "acct",
    accessToken: overrides.accessToken ?? "token",
    addedAt: overrides.addedAt ?? 0,
    isValid: overrides.isValid ?? true,
    isBanned: overrides.isBanned,
    quota: overrides.quota,
    refreshToken: overrides.refreshToken,
    accountId: overrides.accountId,
    expiresAt: overrides.expiresAt,
    email: overrides.email,
    planType: overrides.planType,
  };
}

test("fetchUsageMetadata maps a free single quota window to weekly", async () => {
  await withMockedFetch(
    {
      plan_type: "free",
      rate_limit: {
        primary_window: createWindow(18, 1_900_000_000, 604800),
      },
    },
    async () => {
      const metadata = await fetchUsageMetadata("token", "acct");

      assert.equal(metadata?.planType, "free");
      assert.equal(metadata?.quota?.hourly, undefined);
      assert.equal(metadata?.quota?.weekly?.remainingPercent, 82);
      assert.equal(metadata?.quota?.weekly?.limitWindowSeconds, 604800);
    },
  );
});

test("fetchUsageMetadata keeps a non-free single quota window as hourly", async () => {
  await withMockedFetch(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: createWindow(37, 1_900_000_100, 604800),
      },
    },
    async () => {
      const metadata = await fetchUsageMetadata("token", "acct");

      assert.equal(metadata?.planType, "pro");
      assert.equal(metadata?.quota?.hourly?.remainingPercent, 63);
      assert.equal(metadata?.quota?.hourly?.limitWindowSeconds, 604800);
      assert.equal(metadata?.quota?.weekly, undefined);
    },
  );
});

test("fetchUsageMetadata keeps two-window ordering based on window size", async () => {
  await withMockedFetch(
    {
      plan_type: "team",
      rate_limit: {
        primary_window: createWindow(40, 1_900_000_200, 604800),
        secondary_window: createWindow(25, 1_900_000_300, 18000),
      },
    },
    async () => {
      const metadata = await fetchUsageMetadata("token", "acct");

      assert.equal(metadata?.planType, "team");
      assert.equal(metadata?.quota?.hourly?.remainingPercent, 75);
      assert.equal(metadata?.quota?.hourly?.limitWindowSeconds, 18000);
      assert.equal(metadata?.quota?.weekly?.remainingPercent, 60);
      assert.equal(metadata?.quota?.weekly?.limitWindowSeconds, 604800);
    },
  );
});

test("getQuotaShortageWindow prioritizes weekly before hourly when both are below 5 percent", () => {
  const account = createAccount({
    quota: {
      weekly: { remainingPercent: 4, resetAt: 1_900_000_000, limitWindowSeconds: 604800 },
      hourly: { remainingPercent: 3, resetAt: 1_900_000_100, limitWindowSeconds: 18000 },
    },
  });

  assert.equal(getQuotaShortageWindow(account), "weekly");
  assert.equal(deriveAccountValidity(account), false);
});

test("findNextEligibleAccountIndex picks the next valid account instead of the healthiest later account", () => {
  const accounts = [
    createAccount({
      id: "acct-current",
      quota: {
        weekly: { remainingPercent: 80, resetAt: 1_900_000_000, limitWindowSeconds: 604800 },
        hourly: { remainingPercent: 80, resetAt: 1_900_000_100, limitWindowSeconds: 18000 },
      },
    }),
    createAccount({
      id: "acct-weekly-low",
      quota: {
        weekly: { remainingPercent: 4, resetAt: 1_900_000_200, limitWindowSeconds: 604800 },
        hourly: { remainingPercent: 95, resetAt: 1_900_000_300, limitWindowSeconds: 18000 },
      },
    }),
    createAccount({
      id: "acct-next-ok",
      quota: {
        weekly: { remainingPercent: 8, resetAt: 1_900_000_400, limitWindowSeconds: 604800 },
        hourly: { remainingPercent: 6, resetAt: 1_900_000_500, limitWindowSeconds: 18000 },
      },
    }),
    createAccount({
      id: "acct-healthiest-later",
      quota: {
        weekly: { remainingPercent: 90, resetAt: 1_900_000_600, limitWindowSeconds: 604800 },
        hourly: { remainingPercent: 90, resetAt: 1_900_000_700, limitWindowSeconds: 18000 },
      },
    }),
  ];

  assert.equal(findNextEligibleAccountIndex(accounts, 0), 2);
});
