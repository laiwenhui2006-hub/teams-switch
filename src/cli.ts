#!/usr/bin/env node
import {
  createAccountFromAuth,
  deriveAccountValidity,
  loadConfig,
  readOpencodeAuth,
  saveConfig,
  syncAccountStatus,
  type Account,
} from "./config.js";

function formatResetTimestamp(unixSeconds?: number): string | undefined {
  if (unixSeconds === undefined) {
    return undefined;
  }

  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  const pad = (value: number) => String(value).padStart(2, "0");
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatAccountName(account: Account): string {
  const email = account.email?.trim();
  if (!email) {
    return account.id;
  }

  const [localPart] = email.split("@");
  return localPart?.trim() || email;
}

function formatResetSummary(account: Account): string | undefined {
  const hourlyReset = formatResetTimestamp(account.quota?.hourly?.resetAt);
  const weeklyReset = formatResetTimestamp(account.quota?.weekly?.resetAt);
  const hourlyZero = account.quota?.hourly?.remainingPercent === 0;
  const weeklyZero = account.quota?.weekly?.remainingPercent === 0;

  if (hourlyZero && hourlyReset) return `Hourly ${hourlyReset}`;
  if (weeklyZero && weeklyReset) return `Weekly ${weeklyReset}`;
  if (!hourlyZero && !weeklyZero && hourlyReset) return `Hourly ${hourlyReset}`;
  if (!hourlyZero && !weeklyZero && weeklyReset) return `Weekly ${weeklyReset}`;
  return undefined;
}

function renderAccountLine(account: Account, index: number, isActive: boolean): string {
  const headParts = [`[${index}]`];
  if (account.planType?.trim()) {
    headParts.push(account.planType.trim().toLowerCase());
  }
  headParts.push(formatAccountName(account));

  const detailParts: string[] = [];
  if (account.quota?.hourly) {
    detailParts.push(`Hourly ${account.quota.hourly.remainingPercent}%`);
  }
  if (account.quota?.weekly) {
    detailParts.push(`Weekly ${account.quota.weekly.remainingPercent}%`);
  }

  const resetSummary = formatResetSummary(account);
  if (resetSummary) {
    detailParts.push(`[重置时间: ${resetSummary}]`);
  }

  // 账号状态优先级：封号(永久) > 失效(可恢复) > 有效
  if (account.isBanned) {
    detailParts.push("(已封号)");
  } else {
    detailParts.push(`(${deriveAccountValidity(account) ? "有效" : "失效"})`);
  }
  if (isActive) {
    detailParts.push("(当前生效)");
  }

  return `${headParts.join(" ")} : ${detailParts.join("  ")}`;
}

function findNextEligibleAccountIndex(accounts: Account[], currentIndex: number): number {
  for (let offset = 1; offset < accounts.length; offset += 1) {
    const nextIndex = (currentIndex + offset) % accounts.length;
    if (deriveAccountValidity(accounts[nextIndex])) {
      return nextIndex;
    }
  }

  return -1;
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === "add") {
    const auth = readOpencodeAuth("openai");
    if (!auth || !auth.access) {
      console.error("未在系统 (auth.json) 中找到 openai 提供者的有效授权。");
      console.log("请先尝试执行: `opencode auth login --provider openai` 进行登录，然后再执行本命令添加到池中。");
      process.exit(1);
    }

    const config = loadConfig();
    if (config.accounts.find((account) => account.accessToken === auth.access)) {
      console.log("该 Token 已经存在账号池中。");
      process.exit(0);
    }

    const accountId = process.argv[3] || auth.accountId || `account-${Date.now()}`;
    config.accounts.push(await syncAccountStatus(createAccountFromAuth(accountId, auth)));
    saveConfig(config);
    console.log(`成功提取授权并添加帐号 [${accountId}] 到 Teams Switch 池中。`);
    return;
  }

  if (cmd === "status") {
    const config = loadConfig();
    config.accounts = await Promise.all(
      config.accounts.map((account) => syncAccountStatus(account, { forceRefreshQuota: true })),
    );
    if (config.currentIndex >= config.accounts.length) {
      config.currentIndex = 0;
    }
    saveConfig(config);

    console.log("Teams 状态:");
    console.log(`总账号数: ${config.accounts.length}`);
    config.accounts.forEach((account, index) => {
      console.log(renderAccountLine(account, index, config.currentIndex === index));
    });
    return;
  }

  if (cmd === "switch") {
    const config = loadConfig();
    if (config.accounts.length === 0) {
      console.log("账号池为空。");
      process.exit(0);
    }

    const nextIndex = findNextEligibleAccountIndex(config.accounts, config.currentIndex);
    if (nextIndex === -1) {
      console.log("没有找到额度不低于 5% 的其他可用账号。");
      process.exit(0);
    }

    config.currentIndex = nextIndex;
    saveConfig(config);
    console.log(`已手动切换至账号: ${config.accounts[config.currentIndex].id}`);
    return;
  }

  if (cmd === "clean") {
    const config = loadConfig();
    const before = config.accounts.length;
    config.accounts = config.accounts.filter((account) => !account.isBanned);
    const removed = before - config.accounts.length;
    if (removed > 0) {
      config.currentIndex = 0;
      saveConfig(config);
      console.log(`已清理 ${removed} 个被封禁账号，剩余账号数: ${config.accounts.length}`);
    } else {
      console.log("没有发现被封禁的账号");
    }
    return;
  }

  console.log("Teams Switch 命令行工具");
  console.log("用法:");
  console.log("  opencode teams add [名称]   # 从当前 opencode auth 中提取 openai (codex) 的授权存入池");
  console.log("  opencode teams status       # 查看账号池状态及健康度");
  console.log("  opencode teams switch       # 手动强制切换至池中下一个账号");
  console.log("  opencode teams clean        # 清理所有被封禁的账号（isBanned=true）");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Teams Switch] 命令执行失败: ${message}`);
  process.exit(1);
});
