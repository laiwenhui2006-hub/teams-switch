import assert from "node:assert/strict";
import test from "node:test";

import { fetchUsageMetadata } from "./config.js";

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
