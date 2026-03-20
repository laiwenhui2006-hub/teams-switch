import { loadConfig, saveConfig } from "./config.js";

const CODEX_URL_PATTERN = "chatgpt.com/backend-api/codex";
let originalFetch: typeof globalThis.fetch | null = null;
let isIntercepting = false;

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
 * 获取当前生效账号的 Token（不做轮询，始终使用 currentIndex 指向的账号）
 */
function getCurrentToken(): string | null {
  const config = loadConfig();
  if (config.accounts.length === 0) return null;

  const acc = config.accounts[config.currentIndex];
  if (acc && acc.isValid) {
    return acc.accessToken;
  }
  return null;
}

/**
 * 将当前账号标记为耗尽，并切换到下一个有效账号。
 * 严格遵循"一个用完再用下一个"的策略，不做轮询。
 * 返回切换后的新 Token，如果没有可用账号则返回 null。
 */
function drainCurrentAndSwitchNext(): string | null {
  const config = loadConfig();
  if (config.accounts.length === 0) return null;

  const currentAcc = config.accounts[config.currentIndex];
  currentAcc.isValid = false;
  console.log(`\n[Teams Switch] 账号 [${currentAcc.id}] 额度已耗尽，标记为不可用。`);

  // 从当前位置往后顺序查找下一个有效账号（非轮询，按序消耗）
  for (let i = config.currentIndex + 1; i < config.accounts.length; i++) {
    if (config.accounts[i].isValid) {
      config.currentIndex = i;
      saveConfig(config);
      console.log(`[Teams Switch] 已切换至下一个账号: [${config.accounts[i].id}]`);
      return config.accounts[i].accessToken;
    }
  }

  // 没有更多有效账号了
  saveConfig(config);
  return null;
}

/**
 * 从 JWT Access Token 中解析出 chatgpt_account_id
 */
function extractAccountIdFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    return payload?.["https://api.openai.com/profile"]?.chatgpt_account_id ?? null;
  } catch {
    return null;
  }
}

export function setupInterceptor() {
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

    let currentToken = getCurrentToken();
    if (!currentToken) {
      console.log("\n[Teams Switch] 警告：所有账号均已耗尽！请使用 npx teams-switch add 补充新的授权。");
      return originalFetch(input, init);
    }

    // 使用当前账号的 Token 构造请求
    const modifiedInit = { ...init };
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${currentToken}`);
    
    const acctId = extractAccountIdFromToken(currentToken);
    if (acctId) {
      headers.set("chatgpt-account-id", acctId);
    }

    modifiedInit.headers = headers;

    const response = await originalFetch(input, modifiedInit);

    // 仅在收到 429 (额度耗尽/限流) 或 401 (Token 彻底失效) 时才触发切换
    if (response.status === 401 || response.status === 429) {
      // 冷却期检查：从持久化配置中读取上次切换时间，重启后也能保留
      const freshConfig = loadConfig();
      const now = Date.now();
      const cooldown = randomCooldownMs();
      if (freshConfig.lastSwitchTime > 0 && (now - freshConfig.lastSwitchTime) < cooldown) {
        const remainSec = Math.ceil((cooldown - (now - freshConfig.lastSwitchTime)) / 1000);
        console.log(`\n[Teams Switch] 冷却期中，${remainSec}秒后允许再次切换。本次请求直接返回原始响应。`);
        return response;
      }

      console.log(`\n[Teams Switch] 拦截到错误 ${response.status}，当前账号额度已耗尽。`);

      const nextToken = drainCurrentAndSwitchNext();
      if (!nextToken) {
        console.log("[Teams Switch] 所有账号均已耗尽，无法切换。请补充新授权。");
        return response;
      }

      // 标记切换时间到持久化配置，确保重启后冷却状态也能恢复
      const updatedConfig = loadConfig();
      updatedConfig.lastSwitchTime = Date.now();
      saveConfig(updatedConfig);
      const delaySec = COOLDOWN_MIN_SEC + Math.floor(Math.random() * (COOLDOWN_MAX_SEC - COOLDOWN_MIN_SEC + 1));
      console.log(`[Teams Switch] 进入冷却期，等待 ${delaySec} 秒后使用新账号重传请求...`);
      await new Promise(resolve => setTimeout(resolve, delaySec * 1000));

      // 使用新 Token 构造重传请求
      const retryInit = { ...init };
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${nextToken}`);
      
      const retryAcctId = extractAccountIdFromToken(nextToken);
      if (retryAcctId) {
        retryHeaders.set("chatgpt-account-id", retryAcctId);
      }

      retryInit.headers = retryHeaders;

      console.log("[Teams Switch] 冷却结束，正在使用新账号重传请求...");
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
