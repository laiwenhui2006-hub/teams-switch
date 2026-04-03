import { loadConfig } from "./config.js";

const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.96.2",
  "Copilot-Integration-Id": "vscode-chat",
};

export function isCopilotProvider(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const provider = (input as any).provider;
  return provider?.id === "github-copilot";
}

export async function applyCopilotHeaders(
  input: unknown,
  output: { headers: Record<string, string> }
): Promise<void> {
  if (!isCopilotProvider(input)) return;

  const config = loadConfig();
  const copilotConfig = config.copilot;

  if (!copilotConfig.enabled) return;

  if (copilotConfig.setRequiredHeaders) {
    for (const [key, value] of Object.entries(COPILOT_HEADERS)) {
      output.headers[key] = value;
    }
  }

  const existingInitiator = output.headers["x-initiator"] || output.headers["X-Initiator"];
  if (existingInitiator && !copilotConfig.forceOverrideInitiator) {
    return;
  }

  const model = (input as any).model;
  const api = model?.api;
  if (api?.npm === "@ai-sdk/github-copilot" && !copilotConfig.forceOverrideInitiator) {
    return;
  }

  // Strategy logic will go here
}
