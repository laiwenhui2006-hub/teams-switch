import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { setupInterceptor } from "./src/interceptor.js";
import { loadConfig, saveConfig, readOpencodeAuth } from "./src/config.js";

export const TeamsSwitchPlugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
  // 插件加载时启动全局 Fetch 拦截，用于自动重传失效及限流的 Codex API 请求
  setupInterceptor(_input.client);

  return {
    "chat.headers": async (input, output) => {
      // TODO: delegate to copilot header handler
    },
  };
};

export default TeamsSwitchPlugin;
