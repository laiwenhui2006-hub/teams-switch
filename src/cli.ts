#!/usr/bin/env node
import { loadConfig, saveConfig, readOpencodeAuth } from "./config.js";

const cmd = process.argv[2];

if (cmd === "add") {
  const accountId = process.argv[3] || `account-${Date.now()}`;
  const auth = readOpencodeAuth("openai");
  if (!auth || !auth.access) {
    console.error("未在系统 (auth.json) 中找到 openai 提供者的有效授权。");
    console.log("请先尝试执行: `opencode auth login --provider openai` 进行登录，然后再执行本命令添加到池中。");
    process.exit(1);
  }

  const config = loadConfig();
  if (config.accounts.find(a => a.accessToken === auth.access)) {
    console.log("该 Token 已经存在账号池中。");
    process.exit(0);
  }

  config.accounts.push({
    id: accountId,
    accessToken: auth.access,
    refreshToken: auth.refresh,
    addedAt: Date.now(),
    isValid: true
  });
  saveConfig(config);
  console.log(`成功提取授权并添加帐号 [${accountId}] 到 Teams Switch 池中。`);
} else if (cmd === "status") {
  const config = loadConfig();
  console.log(`Teams Switch 状态:`);
  console.log(`总账号数: ${config.accounts.length}`);
  config.accounts.forEach((acc, i) => {
    const activeStr = config.currentIndex === i ? " (当前生效)" : "";
    const statusStr = acc.isValid ? "有效" : "失效或限流(标记为无效)";
    console.log(` - [${i}] ${acc.id} : ${statusStr}${activeStr}`);
  });
} else if (cmd === "switch") {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    console.log("账号池为空。");
    process.exit(0);
  }
  config.currentIndex = (config.currentIndex + 1) % config.accounts.length;
  saveConfig(config);
  console.log(`已手动切换至账号: ${config.accounts[config.currentIndex].id}`);
} else if (cmd === "clean") {
  const config = loadConfig();
  config.accounts = config.accounts.filter(a => a.isValid);
  config.currentIndex = 0;
  saveConfig(config);
  console.log(`已清理失效账号，剩余有效账号数: ${config.accounts.length}`);
} else {
  console.log("Teams Switch 命令行工具");
  console.log("用法:");
  console.log("  opencode teams add [名称]   # 从当前 opencode auth 中提取 openai (codex) 的授权存入池");
  console.log("  opencode teams status       # 查看账号池状态及健康度");
  console.log("  opencode teams switch       # 手动强制切换至池中下一个账号");
  console.log("  opencode teams clean        # 清理所有标记为失效或无可用量的账号");
}
