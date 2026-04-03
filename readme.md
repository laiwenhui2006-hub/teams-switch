# Teams Switch

多 ChatGPT 账号（Session/Token）池化管理插件，支持 OpenCode CLI。

## 功能特性

- **多账号池管理**：通过配置文件管理多个 ChatGPT 授权 Token
- **无缝自动切换**：检测到 401/429/402 错误时自动切换到下一个健康账号
- **预防性切换**：账号额度低于 5% 时主动提前切换，避免真正耗尽
- **手动切换命令**：支持强制切换，手动切换时同样跳过额度不足 5% 的账号
- **冷却机制**：切换后等待 60~90 秒冷却期，防止频繁触发
- **封号检测**：自动识别并标记永久封禁账号（401 banned / 402 deactivated）
- **GitHub Copilot 支持**：新增 Copilot 请求拦截与头策略层，支持 `passthrough` / `strict` / `interval` 三种模式，不影响现有 Codex 逻辑。

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

# 清理指定账号，all为清空，不传则清理被封禁账号
opencode teams clean [all|名称]
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

## GitHub Copilot 支持

插件新增了对 GitHub Copilot 请求的拦截与头策略层，通过 OpenCode 的 `chat.headers` hook 生效。Copilot 的运行时计数状态单独存放在内存中，不复用现有账号池、冷却、健康度逻辑。

### 模式说明

- **`strict` (默认)**：仅当明确检测到 agent/internal continuation 时才设置 `x-initiator=agent`，否则保留 `user` 或不覆盖。
- **`passthrough`**：完全不修改 `x-initiator`，仅补齐基础头。
- **`interval` (实验性)**：按 N 次 1 次“用户发起”节奏改写。例如 `billingInterval=5`，则每 5 次请求保留为 `user`，其余写为 `agent`。**注意：此模式为实验性功能，默认关闭，可能存在被服务端拒绝的风险。**

### 配置示例

在 `~/.opencode/teams-switch.json` 中添加 `copilot` 配置块：

```json
{
  "copilot": {
    "enabled": true,
    "mode": "strict",
    "billingInterval": 5,
    "setRequiredHeaders": true,
    "forceOverrideInitiator": false,
    "debug": false
  }
}
```

### 回滚方式

如果遇到问题，可以通过以下方式回滚：
- 设置 `copilot.enabled=false` 禁用 Copilot 拦截。
- 或者设置 `mode="passthrough"` 仅补齐基础头，不修改 `x-initiator`。

## License

MIT © laiwenhui2006-hub
