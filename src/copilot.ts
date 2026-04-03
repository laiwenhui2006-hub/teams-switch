import { loadConfig } from "./config.js";
import { getCopilotSessionState, incrementCopilotRequestCount } from "./copilot-state.js";

const COPILOT_HEADERS = {
  "Editor-Version": "vscode/1.96.2",
  "Copilot-Integration-Id": "vscode-chat",
};

export function isCopilotProvider(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const provider = (input as any).provider;
  return provider?.id === "github-copilot";
}

function classifyStrictInitiator(input: unknown): "agent" | "user" | "unknown" {
  const messages = (input as any).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return "unknown";
  }

  const isAgentCall = messages.some(
    (msg) => msg.role === "assistant" || msg.role === "tool"
  );

  return isAgentCall ? "agent" : "user";
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

  if (copilotConfig.mode === "passthrough") {
    return;
  }

  let initiator = classifyStrictInitiator(input);

  if (copilotConfig.mode === "interval") {
    const sessionID = (input as any).sessionID;
    if (sessionID && copilotConfig.billingInterval > 1) {
      incrementCopilotRequestCount(sessionID);
      const state = getCopilotSessionState(sessionID);
      
      if (state.requestCount % copilotConfig.billingInterval !== 0) {
        initiator = "agent";
      }
    }
  }

  if (initiator !== "unknown") {
    output.headers["x-initiator"] = initiator;
  }

  if (copilotConfig.debug) {
    console.log(`[Copilot] mode=${copilotConfig.mode} initiator=${initiator} session=${(input as any).sessionID}`);
  }
}
