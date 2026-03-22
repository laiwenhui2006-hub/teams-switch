# Free Weekly Quota Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `opencode teams status` show a free account's single quota window as weekly usage instead of hourly usage.

**Architecture:** Keep the fix narrow. Update quota classification in `src/config.ts` so a free plan with exactly one parsed usage window stores it under `quota.weekly`, then verify `src/cli.ts` renders weekly output from that corrected data model. Add regression tests first and run them through the compiled `dist/` output with Node's built-in test runner.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), `tsc`

---

## File Structure

- `docs/superpowers/specs/2026-03-22-free-weekly-quota-display-design.md` - approved design to follow exactly
- `docs/superpowers/plans/2026-03-22-free-weekly-quota-display.md` - this implementation plan
- `src/config.ts` - quota parsing and single-window classification logic
- `src/cli.ts` - account status line rendering used by `opencode teams status`
- `src/config.test.ts` - regression tests for usage metadata classification
- `src/cli.test.ts` - regression tests for CLI line rendering

## Commit Strategy

- Commit 1: `test: add quota display regression coverage`
  - `src/config.test.ts`
  - `src/cli.test.ts`
- Commit 2: `fix: map free single quota window to weekly`
  - `src/config.ts`
- Commit 3: `docs: add free weekly quota implementation plan`
  - `docs/superpowers/plans/2026-03-22-free-weekly-quota-display.md`

If the repo is intentionally left uncommitted for handoff, still keep the diff logically separable in this order.

### Task 1: Add regression tests first

**Files:**
- Create: `src/config.test.ts`
- Create: `src/cli.test.ts`

- [ ] **Step 1: Write the failing config classification test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { fetchUsageMetadata } from "./config.js";

test("fetchUsageMetadata maps a free single quota window to weekly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        plan_type: "free",
        rate_limit: {
          primary_window: {
            used_percent: 18,
            reset_at: 1_900_000_000,
            limit_window_seconds: 604800,
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  try {
    const metadata = await fetchUsageMetadata("token", "acct");
    assert.equal(metadata?.planType, "free");
    assert.equal(metadata?.quota?.hourly, undefined);
    assert.equal(metadata?.quota?.weekly?.remainingPercent, 82);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchUsageMetadata keeps a non-free single quota window as hourly", async () => {
  // same fetch harness, but with plan_type: "pro"
  // assert quota.hourly is populated and quota.weekly is undefined
});

test("fetchUsageMetadata keeps two-window ordering unchanged by size", async () => {
  // provide 18000s and 604800s windows
  // assert smaller window becomes hourly and larger becomes weekly
});
```

- [ ] **Step 2: Write the failing CLI rendering test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("status command prints Weekly for a free weekly-only quota", async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "teams-switch-"));
  const opencodeDir = path.join(tempHome, ".opencode");
  await fs.mkdir(opencodeDir, { recursive: true });

  await fs.writeFile(
    path.join(opencodeDir, "teams-switch.json"),
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
  );

  const preloadPath = path.join(tempHome, "mock-fetch.mjs");
  await fs.writeFile(
    preloadPath,
    `globalThis.fetch = async () => new Response(JSON.stringify({ plan_type: "free", rate_limit: { primary_window: { used_percent: 18, reset_at: 1900000000, limit_window_seconds: 604800 } } }), { status: 200, headers: { "Content-Type": "application/json" } });`,
  );

  const { stdout } = await execFileAsync(process.execPath, ["--import", preloadPath, "dist/src/cli.js", "status"], {
    env: { ...process.env, HOME: tempHome },
  });

  assert.match(stdout, /Weekly 82%/);
  assert.match(stdout, /重置时间: Weekly/);
  assert.doesNotMatch(stdout, /Hourly 82%/);
});
```

- [ ] **Step 3: Run the targeted tests to verify RED**

Run: `npm run build && node --test dist/src/config.test.js dist/src/cli.test.js`

Expected:
- `src/config.test.ts` fails because current free single-window behavior assigns the window to `hourly`
- `src/cli.test.ts` fails because the `status` command still prints hourly wording for the free single-window payload

- [ ] **Step 4: Confirm the failure reason is correct**

Verify the failures point to missing free-weekly handling, not syntax, build, or test setup mistakes.

### Task 2: Implement the minimal fix

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`
- Test: `src/cli.test.ts`

- [ ] **Step 1: Update single-window quota classification in `src/config.ts`**

Change the single-window branch inside `fetchUsageMetadata()` so it uses the normalized `planType`:

```ts
const planType = normalizePlanType(toStringValue(payload.plan_type));

// ...after the two-window branch
} else if (rawWindows.length === 1) {
  if (planType === "free") {
    weekly = rawWindows[0];
  } else {
    hourly = rawWindows[0];
  }
}
```

Keep the two-window logic unchanged.

- [ ] **Step 2: Keep CLI changes optional**

Do not change `src/cli.ts` unless the CLI integration test proves there is still a rendering gap after `src/config.ts` is fixed. The intended outcome is that corrected quota data makes the existing CLI output naturally switch from `Hourly` to `Weekly`.

- [ ] **Step 3: Run the targeted tests to verify GREEN**

Run: `npm run build && node --test dist/src/config.test.js dist/src/cli.test.js`

Expected:
- both tests pass
- no new failures appear in the targeted test output

- [ ] **Step 4: Refactor only if needed**

If duplication appears while wiring the tests, keep cleanup minimal and rerun the same command immediately.

### Task 3: Full verification

**Files:**
- Verify: `src/config.ts`
- Verify: `src/cli.ts`
- Verify: `src/interceptor.ts`
- Verify: `src/config.test.ts`
- Verify: `src/cli.test.ts`

- [ ] **Step 1: Run TypeScript diagnostics on changed files**

Run the language-server diagnostics for:
- `src/config.ts`
- `src/cli.ts`
- `src/interceptor.ts`
- `src/config.test.ts`
- `src/cli.test.ts`

Expected: zero errors.

- [ ] **Step 2: Run the compiled test suite again from a clean build**

Run: `npm run build && node --test dist/src/config.test.js dist/src/cli.test.js`

Expected: all targeted tests pass.

- [ ] **Step 3: Run the project build on its own**

Run: `npm run build`

Expected: `tsc` exits 0.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff -- src/config.ts src/cli.ts src/interceptor.ts src/config.test.ts src/cli.test.ts docs/superpowers/plans/2026-03-22-free-weekly-quota-display.md`

Confirm:
- only the planned behavior changed
- no unrelated source changes were reverted
- the regression coverage clearly matches the spec

- [ ] **Step 5: Verify interceptor compatibility explicitly**

Inspect `src/interceptor.ts` and confirm `accountMinQuotaPercent()` still reads both `account.quota?.hourly?.remainingPercent` and `account.quota?.weekly?.remainingPercent`, filtering out `undefined` values before applying `Math.min`. No interceptor code change is expected for this feature.
