import { OpencodeClient } from "@opencode-ai/sdk";
import {
  ensureFreshAccount,
  extractAccountIdFromAccessToken,
  findNextEligibleAccountIndex,
  getQuotaShortageWindow,
  loadConfig,
  saveConfig,
  syncAccountStatus,
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


// 冷却时长常量
const COOLDOWN_MIN_SEC = 60;
const COOLDOWN_MAX_SEC = 90;

/**
 * 生成 60~90 秒之间的随机冷却时长（毫秒）
 */
function randomCooldownMs(): number {
  return (60 + Math.floor(Math.random() * 31)) * 1000;
}

/**
 * 从响应体中检测账号是否已被封禁（永久无法恢复）
 * 参考 cockpit-tools: 含 banned/forbidden/suspended 关键词的 401 即为封号
 */
function isAccountBanned(body: string | null): boolean {
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

/**
 * 将账号标记为永久封禁（isBanned = true, isValid = false）
 * 被封禁的账号不参与任何切换，永不使用
 */
function markAccountAsBanned(accountId: string): void {
  const config = loadConfig();
  const acc = config.accounts.find(a => a.id === accountId);
  if (acc) {
    acc.isBanned = true;
    acc.isValid = false;
    saveConfig(config);
    showNotification(`账号 [${accountId}] 已被永久封禁，已从账号池中移除。`, "error");
  }
}

/**
 * 获取当前生效账号的 Token（不做轮询，始终使用 currentIndex 指向的账号）
 */
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
        const shortage = getQuotaShortageWindow(syncedAcc);
        if (shortage !== null) {
          const nextIndex = findNextEligibleAccountIndex(freshConfig.accounts, freshConfig.currentIndex);
          if (nextIndex !== -1) {
            freshConfig.currentIndex = nextIndex;
            showNotification(`后台检测到账号 [${syncedAcc.id}] ${shortage} 额度不足，提前切换至 [${freshConfig.accounts[nextIndex].id}]`, "info");
          }
        }
        saveConfig(freshConfig);
      }
    }).catch(() => {});
  }
}

async function getCurrentToken(): Promise<string | null> {
  const config = loadConfig();
  if (config.accounts.length === 0) return null;

  const acc = config.accounts[config.currentIndex];
  if (acc && acc.isValid) {
    const refreshedAcc = await ensureFreshAccount(acc);

    // 预防性切换：Weekly 优先于 Hourly；额度不足时切到下一个额度充足的账号
    const shortageWindow = getQuotaShortageWindow(refreshedAcc);
    if (shortageWindow !== null) {
      const nextIndex = findNextEligibleAccountIndex(config.accounts, config.currentIndex);
      if (nextIndex !== -1) {
        config.currentIndex = nextIndex;
        saveConfig(config);
        showNotification(`当前账号 [${refreshedAcc.id}] ${shortageWindow} 配额不足，提前切换至下一个可用账号 [${config.accounts[nextIndex].id}]`, "warning");
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
  return null;
}

/**
 * 将当前账号标记为耗尽，并切换到下一个额度充足的账号。
 * 返回切换后的新 Token，如果没有可用账号则返回 null。
 */
function drainCurrentAndSwitchNext(): string | null {
  const config = loadConfig();
  if (config.accounts.length === 0) return null;

  const currentAcc = config.accounts[config.currentIndex];
  currentAcc.isValid = false;
  showNotification(`账号 [${currentAcc.id}] 额度已耗尽，标记为不可用。`, "error");

  const nextIndex = findNextEligibleAccountIndex(config.accounts, config.currentIndex);
  if (nextIndex !== -1) {
    config.currentIndex = nextIndex;
    saveConfig(config);
    showNotification(`已切换至下一个可用账号: [${config.accounts[nextIndex].id}]`, "success");
    return config.accounts[nextIndex].accessToken;
  }

  // 没有更多有效账号了
  saveConfig(config);
  return null;
}

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
    const modifiedInit = { ...init };
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${currentToken}`);
    
    const acctId = extractAccountIdFromAccessToken(currentToken);
    if (acctId) {
      headers.set("chatgpt-account-id", acctId);
    }

    modifiedInit.headers = headers;

    const response = await originalFetch(input, modifiedInit);

    // 仅在收到 429 (额度耗尽/限流)、401 (Token 失效/封号) 或 402 (Workspace 停用) 时才触发切换
    if (response.status === 401 || response.status === 429 || response.status === 402) {
      // 冷却期检查：从持久化配置中读取上次切换时间，重启后也能保留
      const freshConfig = loadConfig();
      const now = Date.now();
      const cooldown = randomCooldownMs();
      if (freshConfig.lastSwitchTime > 0 && (now - freshConfig.lastSwitchTime) < cooldown) {
        const remainSec = Math.ceil((cooldown - (now - freshConfig.lastSwitchTime)) / 1000);
        showNotification(`冷却期中，${remainSec}秒后允许再次切换。本次请求直接返回原始响应。`, "warning");
        return response;
      }

      // ---------- 401: 区分"封号"和"Token 过期" ----------
      if (response.status === 401) {
        const bodyText = await response.clone().text();

        if (isAccountBanned(bodyText)) {
          // 封号：永久标记，不重试，不尝试 refresh
          const currentAcc = freshConfig.accounts[freshConfig.currentIndex];
          markAccountAsBanned(currentAcc.id);
          const nextToken = drainCurrentAndSwitchNext();
          if (!nextToken) {
            showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
            return response;
          }
          // 标记切换时间并进入冷却
          const afterBanConfig = loadConfig();
          afterBanConfig.lastSwitchTime = Date.now();
          saveConfig(afterBanConfig);
          const delaySec = COOLDOWN_MIN_SEC + Math.floor(Math.random() * (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC + 1));
          showNotification(`进入冷却期，等待 ${delaySec} 秒后使用新账号重传请求...`, "warning", delaySec * 1000);
          await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
          // 用新账号重传
          const retryInit = { ...init };
          const retryHeaders = new Headers(init?.headers);
          retryHeaders.set("Authorization", `Bearer ${nextToken}`);
          const retryAcctId = extractAccountIdFromAccessToken(nextToken);
          if (retryAcctId) retryHeaders.set("chatgpt-account-id", retryAcctId);
          retryInit.headers = retryHeaders;
          showNotification("冷却结束，正在使用新账号重传请求...", "info");
          return originalFetch(input, retryInit);
        }

        // 非封号：尝试 refresh Token 一次
        showNotification(`拦截到 401，尝试刷新 Token...`, "warning");
        const refreshedAcc = await ensureFreshAccount(freshConfig.accounts[freshConfig.currentIndex]);
        // 检查 refresh 后 Token 是否有效：用 refreshed Token 发一个轻量请求验证
        const verifyInit: RequestInit = { method: "GET" };
        const verifyHeaders = new Headers();
        const verifyAcctId = extractAccountIdFromAccessToken(refreshedAcc.accessToken);
        if (verifyAcctId) verifyHeaders.set("chatgpt-account-id", verifyAcctId);
        verifyHeaders.set("Authorization", `Bearer ${refreshedAcc.accessToken}`);
        verifyInit.headers = verifyHeaders;
        let verifyResponse: Response | null = null;
        try {
          verifyResponse = await originalFetch("https://chatgpt.com/backend-api/me", verifyInit);
        } catch {
          // 网络错误，不算 ban，走普通切换流程
        }

        if (verifyResponse && verifyResponse.status === 401) {
          // refresh 后的 Token 仍然 401 → 判定为封号
          const currentAcc = freshConfig.accounts[freshConfig.currentIndex];
          markAccountAsBanned(currentAcc.id);
          const nextToken = drainCurrentAndSwitchNext();
          if (!nextToken) {
            showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
            return response;
          }
          const afterBanConfig2 = loadConfig();
          afterBanConfig2.lastSwitchTime = Date.now();
          saveConfig(afterBanConfig2);
          const delaySec2 = COOLDOWN_MIN_SEC + Math.floor(Math.random() * (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC + 1));
          showNotification(`Token 刷新后仍 401（疑似封号），进入 ${delaySec2}s 冷却...`, "error", delaySec2 * 1000);
          await new Promise(resolve => setTimeout(resolve, delaySec2 * 1000));
          const retryInit2 = { ...init };
          const retryHeaders2 = new Headers(init?.headers);
          retryHeaders2.set("Authorization", `Bearer ${nextToken}`);
          const retryAcctId2 = extractAccountIdFromAccessToken(nextToken);
          if (retryAcctId2) retryHeaders2.set("chatgpt-account-id", retryAcctId2);
          retryInit2.headers = retryHeaders2;
          return originalFetch(input, retryInit2);
        }

        // refresh 成功：用新 Token 重传
        if (JSON.stringify(refreshedAcc) !== JSON.stringify(freshConfig.accounts[freshConfig.currentIndex])) {
          freshConfig.accounts[freshConfig.currentIndex] = refreshedAcc;
          saveConfig(freshConfig);
        }
        const newToken = refreshedAcc.accessToken;
        const retryInit3 = { ...init };
        const retryHeaders3 = new Headers(init?.headers);
        retryHeaders3.set("Authorization", `Bearer ${newToken}`);
        const retryAcctId3 = extractAccountIdFromAccessToken(newToken);
        if (retryAcctId3) retryHeaders3.set("chatgpt-account-id", retryAcctId3);
        retryInit3.headers = retryHeaders3;
        showNotification("Token 刷新成功，使用新 Token 重传请求...", "success");
        return originalFetch(input, retryInit3);
      }

      // ---------- 402: Workspace 停用，按封号处理 ----------
      if (response.status === 402) {
        const bodyText = await response.clone().text();
        if (isAccountBanned(bodyText)) {
          const currentAcc = freshConfig.accounts[freshConfig.currentIndex];
          markAccountAsBanned(currentAcc.id);
          const nextToken = drainCurrentAndSwitchNext();
          if (!nextToken) {
            showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
            return response;
          }
          const afterBanConfig3 = loadConfig();
          afterBanConfig3.lastSwitchTime = Date.now();
          saveConfig(afterBanConfig3);
          const delaySec3 = COOLDOWN_MIN_SEC + Math.floor(Math.random() * (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC + 1));
          showNotification(`Workspace 停用（402），进入 ${delaySec3}s 冷却后使用新账号重传...`, "error", delaySec3 * 1000);
          await new Promise(resolve => setTimeout(resolve, delaySec3 * 1000));
          const retryInit3b = { ...init };
          const retryHeaders3b = new Headers(init?.headers);
          retryHeaders3b.set("Authorization", `Bearer ${nextToken}`);
          const retryAcctId3b = extractAccountIdFromAccessToken(nextToken);
          if (retryAcctId3b) retryHeaders3b.set("chatgpt-account-id", retryAcctId3b);
          retryInit3b.headers = retryHeaders3b;
          return originalFetch(input, retryInit3b);
        }
      }

      // ---------- 429: 额度耗尽或风控 ----------
      showNotification(`拦截到错误 ${response.status}，当前账号额度已耗尽。`, "warning");
      const nextToken = drainCurrentAndSwitchNext();
      if (!nextToken) {
        showNotification("所有账号均已耗尽，无法切换。请补充新授权。", "error");
        return response;
      }

      // 标记切换时间到持久化配置，确保重启后冷却状态也能恢复
      const updatedConfig = loadConfig();
      updatedConfig.lastSwitchTime = Date.now();
      saveConfig(updatedConfig);
      const delaySec = COOLDOWN_MIN_SEC + Math.floor(Math.random() * (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC + 1));
      showNotification(`进入冷却期，等待 ${delaySec} 秒后使用新账号重传请求...`, "warning", delaySec * 1000);
      await new Promise(resolve => setTimeout(resolve, delaySec * 1000));

      // 使用新 Token 构造重传请求
      const retryInit = { ...init };
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${nextToken}`);
      
      const retryAcctId = extractAccountIdFromAccessToken(nextToken);
      if (retryAcctId) {
        retryHeaders.set("chatgpt-account-id", retryAcctId);
      }

      retryInit.headers = retryHeaders;

      showNotification("冷却结束，正在使用新账号重传请求...", "info");
      return originalFetch(input, retryInit);
    }

    return response;
  };
}

export function teardownInterceptor() {
  if (isIntercepting && originalFetch) {
    globalThis.fetch = originalFetch;
    isIntercepting = false;
  }
}
