# Teams Switch 插件需求与设计文档

## 1. 基本信息
- **插件名称**：Teams Switch
- **运行环境**：基于 OpenCode CLI (v1.2.27 及以上版本)
- **核心定位**：多 ChatGPT 账号（Session/Token）的池化管理器。

## 2. 核心需求
1. **多授权管理**：本插件主要作为授权的中控层，配合 `opencode-openai-codex-auth` 插件实现多个 ChatGPT 授权的管理与调度。
2. **无缝自动切换**：在实际向 Codex/OpenAI API 发起请求时，一旦检测出当前授权 Token 已经耗尽（例如遇到 HTTP 429 Rate Limit）或失效（如 HTTP 401 Unauthorized），插件将自动静默拦截错误，并从账号池中取出下一个健康授权进行重试，确保开发过程不中断。

## 3. 工作原理与配合机制
此前的调研表明 `opencode-openai-codex-auth` 插件本身遵循“单次安装、单一登录（One install. Every Codex model.）”的思想，并不具备同时存放和轮询多个 Token 的机制。因此，**Teams Switch** 插件的工作机制如下：

- **账号收集与录入**：支持通过配置文件（如 `accounts.json`）记录或通过命令行指令（如 `opencode teams add`）录入多个通过 `opencode-openai-codex-auth` 流程获取的授权凭据。
- **环境接管与动态注入**：在发起 OpenCode 会话时，Teams Switch 将接管底层的 `fetch` 请求或代理全局的认证 Token。当请求失败时，它会动态修改请求头的 `Authorization`，替换为池中的下一个 Token。


## 4. 扩展指令
为了便于用户在实际开发中管理多账号，本插件注入了可直接在系统终端执行的交互指令。请在**终端（非 TUI）**直接执行：

- **`opencode teams status`**：查看当前账号池剩余可用 Token 的数量及当前生效账号的状态。
- **`opencode teams switch`**：手动强制切换至下一个账号。
- **`opencode teams add [名称]`**：从当前 auth 中提取 openai-codex 授权添加入池。
- **`opencode teams clean`**：清空已失效的 Token。

## 5. 异常处理目标
- 严格捕获底层网络的 401 (过期) 与 429 (限流) 状态码。
- 设定合理的重试次数上限（如 3 次），超过则抛出可读的错误提示，避免陷入死循环请求。
