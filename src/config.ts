import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type JsonRecord = Record<string, unknown>;

export interface QuotaWindow {
  remainingPercent: number;
  resetAt?: number;
  /** 窗口周期秒数，稳定标识窗口类型：~18000=Hourly，~604800=Weekly */
  limitWindowSeconds?: number;
}

export interface QuotaStatus {
  hourly?: QuotaWindow;
  weekly?: QuotaWindow;
  fetchedAt?: number;
}

// The structure of an account in the token pool
export interface Account {
  id: string; // Unique nickname or chatgpt_account_id
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAt?: number;
  email?: string;
  planType?: string;
  quota?: QuotaStatus;
  addedAt: number;
  isValid: boolean;
  isBanned?: boolean; // 永久封号标记（无法通过 refresh 恢复）
}

export interface CopilotConfig {
  enabled: boolean;
  mode: "passthrough" | "strict" | "interval";
  billingInterval: number;
  setRequiredHeaders: boolean;
  forceOverrideInitiator: boolean;
  debug: boolean;
}

export interface TeamsConfig {
  currentIndex: number;
  cooldownUntil: number; // 冷却截止时间戳（ms），在此之前不允许切换
  accounts: Account[];
  copilot: CopilotConfig;
}

// 冷却时长常量（秒），切换后随机取 [MIN, MAX] 即完成
export const COOLDOWN_MIN_SEC = 60;
export const COOLDOWN_MAX_SEC = 90;

export function randomCooldownMs(): number {
  return (COOLDOWN_MIN_SEC + Math.floor(Math.random() * (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC + 1))) * 1000;
}

const OPENCODE_DIR = path.join(os.homedir(), ".opencode");
const CONFIG_FILE = path.join(OPENCODE_DIR, "teams-switch.json");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_REFRESH_SKEW_SECONDS = 30;

function toRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function toBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function normalizeUnixTimestamp(raw: number): number {
  if (raw > 1_000_000_000_000) {
    return Math.floor(raw / 1000);
  }
  return Math.floor(raw);
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function normalizeUsedPercent(rawUsedPercent: unknown): number | undefined {
  const usedPercent = toNumberValue(rawUsedPercent);
  if (usedPercent === undefined) {
    return undefined;
  }
  return 100 - clampPercent(usedPercent);
}

function normalizeStoredRemainingPercent(rawRemainingPercent: unknown): number | undefined {
  const remainingPercent = toNumberValue(rawRemainingPercent);
  if (remainingPercent === undefined) {
    return undefined;
  }
  return clampPercent(remainingPercent);
}

function normalizePlanType(rawPlanType: string | undefined): string | undefined {
  const normalized = rawPlanType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("enterprise")) return "enterprise";
  if (normalized.includes("business") || normalized.includes("team")) return "team";
  if (normalized.includes("plus")) return "plus";
  if (normalized.includes("pro")) return "pro";
  if (normalized.includes("basic")) return "basic";
  if (normalized.includes("free")) return "free";
  return normalized;
}

function normalizeResetAt(rawResetAt: unknown, rawResetAfterSeconds: unknown): number | undefined {
  const resetAt = toNumberValue(rawResetAt);
  if (resetAt !== undefined && resetAt > 0) {
    return normalizeUnixTimestamp(resetAt);
  }

  const resetAfterSeconds = toNumberValue(rawResetAfterSeconds);
  if (resetAfterSeconds === undefined || resetAfterSeconds < 0) {
    return undefined;
  }

  return Math.floor(Date.now() / 1000) + Math.floor(resetAfterSeconds);
}

function normalizeQuotaWindow(value: unknown): QuotaWindow | undefined {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }

  const remainingPercent =
    normalizeUsedPercent(record.used_percent) ??
    normalizeStoredRemainingPercent(record.remainingPercent);
  if (remainingPercent === undefined) {
    return undefined;
  }

  const resetAt = normalizeResetAt(record.reset_at ?? record.resetAt, record.reset_after_seconds ?? record.resetAfterSeconds);
  const limitWindowSeconds = toNumberValue(record.limit_window_seconds);

  if (resetAt === undefined && limitWindowSeconds === undefined) {
    return { remainingPercent };
  }

  return {
    remainingPercent,
    resetAt,
    limitWindowSeconds,
  };
}

function normalizeAccount(value: unknown, index: number): Account | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const accessToken = toStringValue(record.accessToken) ?? toStringValue(record.access);
  if (!accessToken) {
    return null;
  }

  const id =
    toStringValue(record.id) ??
    toStringValue(record.accountId) ??
    `account-${index + 1}`;

  const quotaRecord = toRecord(record.quota);
  const hourlyQuota = normalizeQuotaWindow(quotaRecord?.hourly);
  const weeklyQuota = normalizeQuotaWindow(quotaRecord?.weekly);
  const quotaFetchedAt = toNumberValue(quotaRecord?.fetchedAt);
  const hasQuota = hourlyQuota !== undefined || weeklyQuota !== undefined || quotaFetchedAt !== undefined;

  return {
    id,
    accessToken,
    refreshToken: toStringValue(record.refreshToken) ?? toStringValue(record.refresh),
    accountId:
      toStringValue(record.accountId) ??
      toStringValue(record.account_id) ??
      extractAccountIdFromAccessToken(accessToken),
    expiresAt:
      toNumberValue(record.expiresAt) ??
      toNumberValue(record.expires) ??
      extractExpiryFromAccessToken(accessToken),
    email:
      toStringValue(record.email) ??
      toStringValue(record.emailAddress) ??
      extractEmailFromAccessToken(accessToken),
    planType:
      normalizePlanType(toStringValue(record.planType)) ??
      normalizePlanType(toStringValue(record.plan_type)) ??
      normalizePlanType(extractPlanTypeFromAccessToken(accessToken)),
    quota: hasQuota
      ? {
          hourly: hourlyQuota,
          weekly: weeklyQuota,
          fetchedAt: quotaFetchedAt,
        }
      : undefined,
    addedAt: Math.floor(toNumberValue(record.addedAt) ?? Date.now()),
    isValid: typeof record.isValid === "boolean" ? record.isValid : true,
    isBanned: toBooleanValue(record.isBanned),
  };
}

function normalizeCopilotConfig(value: unknown): CopilotConfig {
  const record = toRecord(value);
  const modeStr = toStringValue(record?.mode);
  const mode = (modeStr === "passthrough" || modeStr === "strict" || modeStr === "interval") ? modeStr : "strict";
  
  return {
    enabled: toBooleanValue(record?.enabled) ?? true,
    mode,
    billingInterval: toNumberValue(record?.billingInterval) ?? 5,
    setRequiredHeaders: toBooleanValue(record?.setRequiredHeaders) ?? true,
    forceOverrideInitiator: toBooleanValue(record?.forceOverrideInitiator) ?? false,
    debug: toBooleanValue(record?.debug) ?? false,
  };
}

function normalizeConfig(value: unknown): TeamsConfig {
  const record = toRecord(value);
  if (!record) {
    return { currentIndex: 0, cooldownUntil: 0, accounts: [], copilot: normalizeCopilotConfig(null) };
  }

  const rawAccounts = Array.isArray(record.accounts) ? record.accounts : [];
  const accounts: Account[] = rawAccounts
    .map((item, index) => normalizeAccount(item, index))
    .filter((item): item is Account => item !== null);

  const rawCurrentIndex = Math.floor(toNumberValue(record.currentIndex) ?? 0);
  const boundedIndex =
    accounts.length === 0 ? 0 : Math.max(0, Math.min(rawCurrentIndex, accounts.length - 1));

  // 兼容旧字段 lastSwitchTime → 转为 cooldownUntil
  const cooldownUntil = Math.max(
    0,
    Math.floor(toNumberValue(record.cooldownUntil) ?? 0),
  );

  return {
    currentIndex: boundedIndex,
    cooldownUntil,
    accounts,
    copilot: normalizeCopilotConfig(record.copilot),
  };
}

// Ensure opencode dir exists (usually it does)
function ensureConfigDir() {
  if (!fs.existsSync(OPENCODE_DIR)) {
    fs.mkdirSync(OPENCODE_DIR, { recursive: true });
  }
}

// Load configurations
export function loadConfig(): TeamsConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return normalizeConfig(null);
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch (err) {
    console.error("[Teams Switch] Failed to load config, returning default.", err);
    return normalizeConfig(null);
  }
}

// Save configurations
export function saveConfig(config: TeamsConfig) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function decodeJwtPayload(token: string): JsonRecord | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    return toRecord(JSON.parse(decoded));
  } catch {
    return null;
  }
}

export function extractAccountIdFromAccessToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;

  const authData = toRecord(payload["https://api.openai.com/auth"]);
  return (
    toStringValue(authData?.chatgpt_account_id) ??
    toStringValue(authData?.account_id) ??
    toStringValue(payload.chatgpt_account_id) ??
    toStringValue(payload.account_id)
  );
}

export function extractPlanTypeFromAccessToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;

  const profileData = toRecord(payload["https://api.openai.com/profile"]);
  const authData = toRecord(payload["https://api.openai.com/auth"]);

  return (
    toStringValue(profileData?.chatgpt_plan_type) ??
    toStringValue(authData?.chatgpt_plan_type) ??
    toStringValue(payload.chatgpt_plan_type)
  );
}

export function extractEmailFromAccessToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;

  const profileData = toRecord(payload["https://api.openai.com/profile"]);
  return toStringValue(profileData?.email) ?? toStringValue(payload.email);
}

export function extractExpiryFromAccessToken(accessToken: string): number | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;

  const exp = toNumberValue(payload.exp);
  return exp !== undefined ? normalizeUnixTimestamp(exp) : undefined;
}

export interface OpenCodeAuth {
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

// Read current active auth from standard OpenCode auth
export function readOpencodeAuth(provider: string = "openai"): OpenCodeAuth | null {
  // OpenCode typically stores auth logic in XDG data dir or AppData
  let authFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  if (!fs.existsSync(authFile)) {
    // Fallback logic for macOS native app data just in case
    authFile = path.join(os.homedir(), "Library", "Application Support", "opencode", "auth.json");
  }
  if (!fs.existsSync(authFile)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(authFile, "utf-8");
    const json = toRecord(JSON.parse(raw));
    const providerRecord = toRecord(json?.[provider]);
    if (!providerRecord) {
      return null;
    }

    return {
      access: toStringValue(providerRecord.access),
      refresh: toStringValue(providerRecord.refresh),
      expires: toNumberValue(providerRecord.expires),
      accountId: toStringValue(providerRecord.accountId),
    };
  } catch {
    return null;
  }
}

export interface UsageMetadata {
  planType?: string;
  quota?: QuotaStatus;
}

export async function fetchUsageMetadata(
  accessToken: string,
  accountId?: string,
): Promise<UsageMetadata | null> {
  const normalizedToken = accessToken.trim();
  if (!normalizedToken) {
    return null;
  }

  const effectiveAccountId = accountId ?? extractAccountIdFromAccessToken(normalizedToken);
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${normalizedToken}`);
  headers.set("Accept", "application/json");
  if (effectiveAccountId) {
    headers.set("ChatGPT-Account-Id", effectiveAccountId);
  }

  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      method: "GET",
      headers,
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let payload: JsonRecord | null;
  try {
    payload = toRecord(await response.json());
  } catch {
    payload = null;
  }

  if (!payload) {
    return null;
  }

  const rateLimit = toRecord(payload.rate_limit);
  const rawWindows = [
    normalizeQuotaWindow(rateLimit?.primary_window),
    normalizeQuotaWindow(rateLimit?.secondary_window),
  ].filter((w): w is QuotaWindow => w !== undefined);
  const planType = normalizePlanType(toStringValue(payload.plan_type));

  // Determine Hourly vs Weekly by limit_window_seconds (stable identifier):
  // Hourly ~18000s (5h), Weekly ~604800s (7d). Use the smaller value as Hourly.
  let hourly: QuotaWindow | undefined;
  let weekly: QuotaWindow | undefined;
  if (rawWindows.length === 2) {
    const [w0, w1] = rawWindows;
    const l0 = w0.limitWindowSeconds ?? Infinity;
    const l1 = w1.limitWindowSeconds ?? Infinity;
    if (l0 <= l1) {
      hourly = w0;
      weekly = w1;
    } else {
      hourly = w1;
      weekly = w0;
    }
  } else if (rawWindows.length === 1) {
    if (planType === "free") {
      weekly = rawWindows[0];
    } else {
      hourly = rawWindows[0];
    }
  }

  const quota =
    hourly || weekly
      ? {
          hourly,
          weekly,
          fetchedAt: Math.floor(Date.now() / 1000),
        }
      : undefined;

  if (!planType && !quota) {
    return null;
  }

  return {
    planType: normalizePlanType(planType),
    quota,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<OpenCodeAuth | null> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = toRecord(await response.json());
  const access = toStringValue(payload?.access_token);
  const refresh = toStringValue(payload?.refresh_token);
  const expiresIn = toNumberValue(payload?.expires_in);
  if (!access || !refresh || expiresIn === undefined) {
    return null;
  }

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    accountId: extractAccountIdFromAccessToken(access),
  };
}

export function createAccountFromAuth(id: string, auth: OpenCodeAuth): Account {
  const accessToken = auth.access?.trim() ?? "";

  return {
    id,
    accessToken,
    refreshToken: auth.refresh,
    accountId: auth.accountId ?? extractAccountIdFromAccessToken(accessToken),
    expiresAt: auth.expires ?? extractExpiryFromAccessToken(accessToken),
    email: extractEmailFromAccessToken(accessToken),
    planType: normalizePlanType(extractPlanTypeFromAccessToken(accessToken)),
    addedAt: Date.now(),
    isValid: true,
  };
}

// 低于此阈值的窗口视为不健康，预防性切换阈值
const QUOTA_LOW_THRESHOLD = 5;

export function getQuotaShortageWindow(account: Account): "weekly" | "hourly" | null {
  if ((account.quota?.weekly?.remainingPercent ?? Infinity) < QUOTA_LOW_THRESHOLD) {
    return "weekly";
  }

  if ((account.quota?.hourly?.remainingPercent ?? Infinity) < QUOTA_LOW_THRESHOLD) {
    return "hourly";
  }

  return null;
}

export function deriveAccountValidity(account: Account): boolean {
  // 封禁账号永远无效
  if (account.isBanned) return false;

  const hasQuota = account.quota?.hourly !== undefined || account.quota?.weekly !== undefined;

  if (hasQuota) {
    // Weekly 优先于 Hourly；任一窗口低于阈值即视为无效，避免真正耗尽到 0% 才切换
    return getQuotaShortageWindow(account) === null;
  }

  return account.isValid;
}

export function findNextEligibleAccountIndex(accounts: Account[], currentIndex: number): number {
  for (let offset = 1; offset < accounts.length; offset += 1) {
    const nextIndex = (currentIndex + offset) % accounts.length;
    if (deriveAccountValidity(accounts[nextIndex])) {
      return nextIndex;
    }
  }

  return -1;
}

const refreshPromises = new Map<string, Promise<Account>>();

export async function ensureFreshAccount(account: Account): Promise<Account> {
  const nextAccount: Account = {
    ...account,
    accountId: account.accountId ?? extractAccountIdFromAccessToken(account.accessToken),
    expiresAt: account.expiresAt ?? extractExpiryFromAccessToken(account.accessToken),
    email: account.email ?? extractEmailFromAccessToken(account.accessToken),
    planType: normalizePlanType(account.planType ?? extractPlanTypeFromAccessToken(account.accessToken)),
  };

  const expiresAtSeconds = nextAccount.expiresAt;
  if (
    expiresAtSeconds === undefined ||
    expiresAtSeconds > Math.floor(Date.now() / 1000) + TOKEN_REFRESH_SKEW_SECONDS ||
    !nextAccount.refreshToken
  ) {
    return nextAccount;
  }

  if (refreshPromises.has(account.id)) {
    return refreshPromises.get(account.id)!;
  }

  const refreshPromise = (async () => {
    const refreshedAuth = await refreshAccessToken(nextAccount.refreshToken!);
    if (!refreshedAuth?.access) {
      return nextAccount;
    }

    return {
      ...nextAccount,
      accessToken: refreshedAuth.access,
      refreshToken: refreshedAuth.refresh ?? nextAccount.refreshToken,
      accountId: refreshedAuth.accountId ?? extractAccountIdFromAccessToken(refreshedAuth.access),
      expiresAt:
        (refreshedAuth.expires !== undefined ? Math.floor(refreshedAuth.expires / 1000) : undefined) ??
        extractExpiryFromAccessToken(refreshedAuth.access),
      email: extractEmailFromAccessToken(refreshedAuth.access) ?? nextAccount.email,
      planType: normalizePlanType(extractPlanTypeFromAccessToken(refreshedAuth.access)) ?? nextAccount.planType,
    };
  })();

  refreshPromises.set(account.id, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshPromises.delete(account.id);
  }
}

/**
 * 检查配额窗口是否"过期未恢复"：
 * - remainingPercent 为 0（已耗尽）
 * - 当前时间已经超过 resetAt（重置时间已过）
 * 满足以上条件说明该配额窗口理论上应已重置，但实际配额仍为 0%，
 * 账号大概率已被封禁或永久失效。
 */
export function isQuotaWindowExpiredAndUnrecovered(window?: QuotaWindow): boolean {
  if (window?.remainingPercent !== 0) return false;
  if (window?.resetAt === undefined) return false;
  return Math.floor(Date.now() / 1000) > window.resetAt;
}

/**
 * 检查账号是否有任一配额窗口的重置时间已过（无论 remainingPercent 是否为 0）。
 * 用于在 isValid=false 时判断是否值得重新 sync 一次。
 */
export function hasAnyResetTimePassed(account: Account): boolean {
  const now = Math.floor(Date.now() / 1000);
  const hourlyReset = account.quota?.hourly?.resetAt;
  const weeklyReset = account.quota?.weekly?.resetAt;
  if (hourlyReset !== undefined && now > hourlyReset) return true;
  if (weeklyReset !== undefined && now > weeklyReset) return true;
  return false;
}

/**
 * 检查缓存的配额窗口是否已经稳定无需刷新：
 * - 该窗口 remainingPercent 为 0（即已耗尽）
 * - 当前时间尚未到达 resetAt（下次重置时间还没到）
 * 满足以上条件时，缓存结果在 resetAt 之前不会变化，无需再调 API。
 */
function isQuotaWindowStable(window?: QuotaWindow): boolean {
  if (window?.remainingPercent !== 0) return false;
  if (window?.resetAt === undefined) return false;
  return Math.floor(Date.now() / 1000) < window.resetAt;
}

export async function syncAccountStatus(
  account: Account,
  options?: { forceRefreshQuota?: boolean },
): Promise<Account> {
  const nextAccount = await ensureFreshAccount(account);

  // 如果 Hourly 或 Weekly 已经耗尽且尚未到达重置时间，跳过 API 调用直接复用缓存
  const hourlyStable = isQuotaWindowStable(nextAccount.quota?.hourly);
  const weeklyStable = isQuotaWindowStable(nextAccount.quota?.weekly);
  const cacheStable =
    !options?.forceRefreshQuota &&
    (hourlyStable || weeklyStable) &&
    nextAccount.quota?.fetchedAt !== undefined;

  let metadata = cacheStable ? null : await fetchUsageMetadata(nextAccount.accessToken, nextAccount.accountId);

  if (!metadata && nextAccount.refreshToken) {
    const forcedRefreshAccount = await ensureFreshAccount({
      ...nextAccount,
      expiresAt: 0,
    });

    if (forcedRefreshAccount.accessToken !== nextAccount.accessToken) {
      metadata = await fetchUsageMetadata(forcedRefreshAccount.accessToken, forcedRefreshAccount.accountId);
    }
  }

  const mergedAccount: Account = {
    ...nextAccount,
    planType: normalizePlanType(metadata?.planType) ?? nextAccount.planType,
    quota: metadata?.quota ?? nextAccount.quota,
  };

  // 重置时间已过但配额仍为 0%，判定为永久失效（封号/Token 不可恢复）
  const expiredHourly = isQuotaWindowExpiredAndUnrecovered(mergedAccount.quota?.hourly);
  const expiredWeekly = isQuotaWindowExpiredAndUnrecovered(mergedAccount.quota?.weekly);
  if (expiredHourly || expiredWeekly) {
    return {
      ...mergedAccount,
      isBanned: true,
      isValid: false,
    };
  }

  return {
    ...mergedAccount,
    isValid: deriveAccountValidity(mergedAccount),
  };
}
