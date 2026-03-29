import { OpencodeClient } from "@opencode-ai/sdk";
import {
  ensureFreshAccount,
  extractAccountIdFromAccessToken,
  findNextEligibleAccountIndex,
  getQuotaShortageWindow,
  hasAnyResetTimePassed,
  loadConfig,
  randomCooldownMs,
  saveConfig,
  syncAccountStatus,
  type TeamsConfig,
} from "./config.js";

const CODEX_URL_PATTERN = "chatgpt.com/backend-api/codex";
let originalFetch: typeof globalThis.fetch | null = null;
let isIntercepting = false;
let opencodeClient: OpencodeClient | null = null;

function showNotification(message: string, variant: "info" | "success" | "warning" | "error" = "info", duration?: number) {
  const cleanMsg = message.replace(/^\n+/, '');
  console.log(`[Teams Switch] ${cleanMsg}`);
  if (opencodeClient) {
    opencodeClient.tui.showToast({
      body: {
        title: "Teams Switch",
        message: cleanMsg,
        variant,
        duration
      }
    }).catch(() => {});
  }
}

/**
 * 从响应体中检测账号是否已被封禁（永久无法恢复）
 */
function isAccountBannedByBody(body: string | null): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("banned") ||
    lower.includes("forbidden") ||
    lower.includes("suspended") ||
    lower.includes("account has been locked") ||
    lower.includes("access denied") ||
    lower.includes("your account has been disabled") ||
    lower.includes("this account has been suspended") ||
    lower.includes("deactivated_workspace")
  );
}

// ─── P3: 就地修改 config 的辅助函数，减少碎片化读写 ───────────────

/**
 * 将指定账号就地标记为永久封禁
 */
function markBanned(config: TeamsConfig, accountId: string): void {
  const acc = config.accounts.find(a => a.id === accountId);
  if (acc) {
    acc.isBanned = true;
    acc.isValid = false;
    showNotification(`账号 [${accountId}] 已被永久封禁，已从池中移除。`, "error");
  }
}

/**
 * 将当前账号标记为耗尽，并切换到下一个有效账号。
 * 就地修改 config，返回新 token；无可用账号返回 null。
 */
function drainAndSwitch(config: TeamsConfig): string | null {
  if (config.accounts.length === 0) return null;

  const currentAcc = config.accounts[config.currentIndex];
  currentAcc.isValid = false;
  showNotification(`账号 [${currentAcc.id}] 额度已耗尽，标记为不可用。`, "error");

  const nextIndex = findNextEligibleAccountIndex(config.accounts, config.currentIndex);
  if (nextIndex !== -1) {
    config.currentIndex = nextIndex;
    showNotification(`已切换至下一个可用账号: [${config.accounts[nextIndex].id}]`, "success");
    return config.accounts[nextIndex].accessToken;
  }

  return null;
}

/**
 * 构造使用指定 token 的重传请求 init
 */
function buildRetryInit(init: RequestInit | undefined, token: string): RequestInit {
  const retryInit = { ...init };
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const acctId = extractAccountIdFromAccessToken(token);
  if (acctId) headers.set("chatgpt-account-id", acctId);
  retryInit.headers = headers;
  return retryInit;
}

// ─── P0: 后台定期 sync + 账号自动恢复 ─────────────────────────

let requestCountSinceLastSync = 0;
let targetRequestCount = 30 + Math.floor(Math.random() * 11);

function maybeSyncQuotaInBackground(acc: any) {
  requestCountSinceLastSync++;
  if (requestCountSinceLastSync >= targetRequestCount) {
    requestCountSinceLastSync = 0;
    targetRequestCount = 30 + Math.floor(Math.random() * 11);
    syncAccountStatus(acc, { forceRefreshQuota: true }).then((syncedAcc) => {
      const freshConfig = loadConfig();
      if (freshConfig.accounts.length > 0 && freshConfig.accounts[freshConfig.currentIndex]?.id === acc.id) {
        freshConfig.accounts[freshConfig.currentIndex] = syncedAcc;
        // P3: 显式检查 isBanned 和 quota shortage
        if (syncedAcc.isBanned || getQuotaShortageWindow(syncedAcc) !== null) {
          const nextIndex = findNextEligibleAccountIndex(freshConfig.accounts, freshConfig.currentIndex);
          if (nextIndex !== -1) {
            freshConfig.currentIndex = nextIndex;
            const reason = syncedAcc.isBanned ? "已被封禁" : `${getQuotaShortageWindow(syncedAcc)} 额度不足`;
            showNotification(`后台检测到账号 [${syncedAcc.id}] ${reason}，提前切换至 [${freshConfig.accounts[nextIndex].id}]`, "info");
          }
        }
        saveConfig(freshConfig);
      }
    }).catch(() => {});
  }
}

/**
 * P0: 获取当前可用 token。
 * 当当前账号 isValid=false 时，会检查重置时间是否已过并尝试恢复。
 */
async function getCurrentToken(): Promise<string | null> {
  const config = loadConfig();
  if (config.accounts.length === 0) return null;

  let acc = config.accounts[config.currentIndex];

  // P0: 当前账号无效时，尝试恢复（重置时间可能已过，配额已自动恢复）
  if (acc && !acc.isValid && !acc.isBanned && hasAnyResetTimePassed(acc)) {
    const recovered = await syncAccountStatus(acc, { forceRefreshQuota: true });
    config.accounts[config.currentIndex] = recovered;
    saveConfig(config);
    acc = recovered;
  }

  // 当前账号有效 → 正常路径
  if (acc && acc.isValid && !acc.isBanned) {
    const refreshedAcc = await ensureFreshAccount(acc);

    // 预防性切换：额度不足时切到下一个
    const shortageWindow = getQuotaShortageWindow(refreshedAcc);
    if (shortageWindow !== null) {
      const nextIndex = findNextEligibleAccountIndex(config.accounts, config.currentIndex);
      if (nextIndex !== -1) {
        config.currentIndex = nextIndex;
        saveConfig(config);
        showNotification(`当前账号 [${refreshedAcc.id}] ${shortageWindow} 配额不足，提前切换至 [${config.accounts[nextIndex].id}]`, "warning");
        return config.accounts[nextIndex].accessToken;
      }
    }

    if (JSON.stringify(refreshedAcc) !== JSON.stringify(acc)) {
      config.accounts[config.currentIndex] = refreshedAcc;
      saveConfig(config);
    }

    maybeSyncQuotaInBackground(refreshedAcc);
    return refreshedAcc.accessToken;
  }

  // 当前账号无效 → 尝试找下一个有效账号
  const nextIndex = findNextEligibleAccountIndex(config.accounts, config.currentIndex);
  if (nextIndex !== -1) {
    config.currentIndex = nextIndex;
    saveConfig(config);
    showNotification(`当前账号不可用，已切换至 [${config.accounts[nextIndex].id}]`, "info");
    return config.accounts[nextIndex].accessToken;
  }

  // P0: 所有账号都无效 → 逐个检查是否有可恢复的
  for (let i = 0; i < config.accounts.length; i++) {
    const candidate = config.accounts[i];
    if (candidate.isBanned) continue;
    if (!hasAnyResetTimePassed(candidate)) continue;

    const recovered = await syncAccountStatus(candidate, { forceRefreshQuota: true });
    config.accounts[i] = recovered;
    if (recovered.isValid) {
      config.currentIndex = i;
      saveConfig(config);
      showNotification(`账号 [${recovered.id}] 配额已恢复，切换使用。`, "success");
      return recovered.accessToken;
    }
  }
  saveConfig(config);
  return null;
}

// ─── 拦截器核心 ──────────────────────────────────────────

export function setupInterceptor(client?: OpencodeClient) {
  if (client) opencodeClient = client;
  if (isIntercepting) return;

  originalFetch = globalThis.fetch;
  isIntercepting = true;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!originalFetch) throw new Error("Original fetch is missing");

    const urlStr = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);

    // 仅拦截 Codex 后端请求
    if (!urlStr.includes(CODEX_URL_PATTERN)) {
      return originalFetch(input, init);
    }

    const config = loadConfig();
    if (config.accounts.length === 0) {
      return originalFetch(input, init);
    }

    let currentToken = await getCurrentToken();
    if (!currentToken) {
      showNotification("警告：所有账号均已耗尽！请使用 npx teams-switch add 补充新的授权。", "error");
      return originalFetch(input, init);
    }

    // 使用当前账号的 Token 构造请求
    const response = await originalFetch(input, buildRetryInit(init, currentToken));

    // 仅在收到 429/401/402 时触发切换逻辑
    if (response.status !== 401 && response.status !== 429 && response.status !== 402) {
      return response;
    }

    // ─── P1: 冷却期检查（使用持久化的 cooldownUntil） ───
    const freshConfig = loadConfig();
    const now = Date.now();
    if (now < freshConfig.cooldownUntil) {
      const remainSec = Math.ceil((freshConfig.cooldownUntil - now) / 1000);
      showNotification(`冷却期中，${remainSec}秒后允许再次切换。返回原始响应。`, "warning");
      return response;
    }

    // ─── 401: 区分"封号"和"Token 过期" ───
    if (response.status === 401) {
      const bodyText = await response.clone().text();

      if (isAccountBannedByBody(bodyText)) {
        // 封号：永久标记 → 切换 → 立即重传（P2: 不阻塞等待）
        markBanned(freshConfig, freshConfig.accounts[freshConfig.currentIndex].id);
        const nextToken = drainAndSwitch(freshConfig);
        freshConfig.cooldownUntil = Date.now() + randomCooldownMs();
        saveConfig(freshConfig);
        if (!nextToken) {
          showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
          return response;
        }
        showNotification("已切换至新账号，正在重传请求...", "info");
        return originalFetch(input, buildRetryInit(init, nextToken));
      }

      // 非封号：尝试 refresh Token 一次
      showNotification("拦截到 401，尝试刷新 Token...", "warning");
      const refreshedAcc = await ensureFreshAccount(freshConfig.accounts[freshConfig.currentIndex]);

      // 用 refreshed Token 验证是否有效
      let verifyResponse: Response | null = null;
      try {
        verifyResponse = await originalFetch(
          "https://chatgpt.com/backend-api/me",
          buildRetryInit(undefined, refreshedAcc.accessToken),
        );
      } catch {
        // 网络错误，不算 ban
      }

      if (verifyResponse && verifyResponse.status === 401) {
        // refresh 后仍 401 → 判定封号
        markBanned(freshConfig, freshConfig.accounts[freshConfig.currentIndex].id);
        const nextToken = drainAndSwitch(freshConfig);
        freshConfig.cooldownUntil = Date.now() + randomCooldownMs();
        saveConfig(freshConfig);
        if (!nextToken) {
          showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
          return response;
        }
        showNotification("Token 刷新后仍 401（疑似封号），已切换，正在重传...", "error");
        return originalFetch(input, buildRetryInit(init, nextToken));
      }

      // refresh 成功：更新 config，用新 Token 重传
      freshConfig.accounts[freshConfig.currentIndex] = refreshedAcc;
      saveConfig(freshConfig);
      showNotification("Token 刷新成功，使用新 Token 重传请求...", "success");
      return originalFetch(input, buildRetryInit(init, refreshedAcc.accessToken));
    }

    // ─── P3: 402 一律按封号处理（Payment Required = Workspace 停用/欠费） ───
    if (response.status === 402) {
      markBanned(freshConfig, freshConfig.accounts[freshConfig.currentIndex].id);
      const nextToken = drainAndSwitch(freshConfig);
      freshConfig.cooldownUntil = Date.now() + randomCooldownMs();
      saveConfig(freshConfig);
      if (!nextToken) {
        showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
        return response;
      }
      showNotification("Workspace 停用（402），已切换至新账号，正在重传...", "error");
      return originalFetch(input, buildRetryInit(init, nextToken));
    }

    // ─── 429: 额度耗尽 → 切换 → 立即重传（P2: 不阻塞） ───
    showNotification(`拦截到 429，当前账号额度已耗尽。`, "warning");
    const nextToken = drainAndSwitch(freshConfig);
    freshConfig.cooldownUntil = Date.now() + randomCooldownMs();
    saveConfig(freshConfig);
    if (!nextToken) {
      showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
      return response;
    }
    showNotification("已切换至新账号，正在重传请求...", "info");
    return originalFetch(input, buildRetryInit(init, nextToken));
  };
}

export function teardownInterceptor() {
  if (isIntercepting && originalFetch) {
    globalThis.fetch = originalFetch;
    isIntercepting = false;
  }
}
