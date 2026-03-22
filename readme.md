# Teams Switch

多 ChatGPT 账号（Session/Token）池化管理插件，支持 OpenCode CLI。

## 功能特性

- **多账号池管理**：通过配置文件管理多个 ChatGPT 授权 Token
- **无缝自动切换**：检测到 401/429/402 错误时自动切换到下一个健康账号
- **预防性切换**：账号额度低于 5% 时主动提前切换，避免真正耗尽
- **手动切换命令**：支持强制切换，手动切换时同样跳过额度不足 5% 的账号
- **冷却机制**：切换后等待 60~90 秒冷却期，防止频繁触发
- **封号检测**：自动识别并标记永久封禁账号（401 banned / 402 deactivated）

## 安装

```bash
cd teams-switch
npm install
npm link
```

## 使用方法

在**终端（非 TUI）**执行以下命令：

```bash
# 查看账号池状态（显示每个账号的 Hourly/Weekly 剩余额度及状态）
opencode teams status

# 手动强制切换至下一个可用账号（自动跳过额度 < 5% 的账号）
opencode teams switch

# 从当前 opencode auth 中提取 openai (codex) 授权添加入池
opencode teams add [名称]

# 清理被永久封禁的账号
opencode teams clean
```

## 账号选择规则

- **自动切换**：优先选择有效账号中额度最充足的候选
- **手动切换**：按轮询顺序，跳过额度低于 5% 的账号
- **5% 阈值**：账号任一窗口（Hourly / Weekly）低于 5% 即视为不健康

## 工作原理

插件通过拦截 `chatgpt.com/backend-api/codex` 请求实现 Token 动态注入：

1. 加载账号池配置
2. 发起请求时自动注入当前账号的 Bearer Token
3. 响应为 401/429/402 时，自动切换到下一个健康账号并重试
4. 冷却期内不重复切换

## License

MIT © laiwenhui2006-hub
