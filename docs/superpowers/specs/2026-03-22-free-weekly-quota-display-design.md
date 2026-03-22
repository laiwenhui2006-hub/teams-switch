---
title: Free Weekly Quota Display Design
date: 2026-03-22
status: draft
---

# Free Weekly Quota Display Design

## Goal

Adjust `opencode teams status` so a `free` account that only has one quota window is shown with weekly quota semantics instead of being mislabeled as hourly quota.

## Background

The current CLI output is assembled in `src/cli.ts`, and quota window parsing happens in `src/config.ts`.

Today, `fetchUsageMetadata()` maps a single returned quota window to `hourly` by default. That means a free account that only exposes one weekly window from `/backend-api/wham/usage` is rendered like this:

```text
free alice : Hourly 82%  [重置时间: Hourly 2026-03-25 10:00:00]  (有效)
```

This conflicts with the intended meaning from the request: free accounts only have weekly quota, so the display should reflect weekly usage and weekly reset time.

## Decision

Use a plan-specific rule:

- If `planType === "free"` and the usage payload yields exactly one quota window, store that window as `weekly`.
- Do not populate `hourly` for that case.
- Keep existing two-window behavior unchanged.
- Keep existing non-free single-window behavior unchanged.

This is the narrowest change that fixes the reported issue without altering other plan types.

## Why This Approach

### Option A: Free-only single-window maps to weekly (chosen)

- Fixes both data semantics and display semantics.
- Preserves current behavior for non-free plans.
- Keeps downstream logic in `src/interceptor.ts` aligned with the corrected quota meaning.

### Option B: Any single window maps to weekly

- Simpler implementation.
- Rejected because it changes behavior for non-free accounts without evidence that they should also be weekly-only.

### Option C: Only rewrite the CLI label for free accounts

- Smallest visual diff.
- Rejected because `src/config.ts` would still store the window as `hourly`, leaving inconsistent semantics for account health and switching logic.

## Scope

### Files to modify

- `src/config.ts`
  - Change single-window classification in `fetchUsageMetadata()`.
  - When `planType` is `free`, map the sole window to `weekly` instead of `hourly`.
- `src/cli.ts`
  - No structural change expected if quota normalization is corrected.
  - Verify `formatResetSummary()` and `renderAccountLine()` naturally render `Weekly ...` once only `weekly` is present.

### Files to verify

- `src/interceptor.ts`
  - Confirm that `accountMinQuotaPercent()` continues to work correctly when a free account has only `weekly` quota.

## Expected Behavior After Change

For a free account with a single quota window:

```text
free alice : Weekly 82%  [重置时间: Weekly 2026-03-25 10:00:00]  (有效)
```

For plans with two windows, output remains unchanged:

```text
pro alice : Hourly 61%  Weekly 74%  [重置时间: Hourly 2026-03-22 16:00:00]  (有效)
```

For non-free plans with one window, current behavior remains unchanged unless later evidence shows they should also be treated as weekly.

## Risks

- If backend payloads mark some non-free plans with a single weekly window, those plans will still display as hourly until a broader rule is introduced.
- This design assumes the reported product rule is accurate: free accounts only have weekly quota.

## Validation

- Add or update a focused test around single-window quota parsing.
- Verify a free single-window payload yields `quota.weekly` and leaves `quota.hourly` undefined.
- Verify CLI rendering prints `Weekly` and weekly reset text for that account.
- Run TypeScript build after the change.

## Out of Scope

- Reworking quota behavior for non-free plans.
- Renaming display labels globally.
- Changing account switching thresholds or cooldown behavior.
