import assert from "node:assert/strict";
import test from "node:test";
import { TeamsSwitchPlugin } from "../index.js";
import type { PluginInput } from "@opencode-ai/plugin";

test("TeamsSwitchPlugin returns chat.headers hook", async () => {
  const mockInput = {
    client: {
      tui: {
        showToast: async () => {},
      },
    },
  } as unknown as PluginInput;

  const hooks = await TeamsSwitchPlugin(mockInput);
  
  assert.ok(hooks, "Plugin should return hooks object");
  assert.ok(hooks["chat.headers"], "Plugin should expose chat.headers hook");
  assert.equal(typeof hooks["chat.headers"], "function", "chat.headers should be a function");
});

test("Copilot session state tracking", async () => {
  const { getCopilotSessionState, incrementCopilotRequestCount, clearCopilotSessionState } = await import("./copilot-state.js");

  const session1 = "sess-1";
  const session2 = "sess-2";

  // Initial state
  let state1 = getCopilotSessionState(session1);
  assert.equal(state1.requestCount, 0);

  // Increment
  incrementCopilotRequestCount(session1);
  incrementCopilotRequestCount(session1);
  state1 = getCopilotSessionState(session1);
  assert.equal(state1.requestCount, 2);

  // Isolation
  const state2 = getCopilotSessionState(session2);
  assert.equal(state2.requestCount, 0);

  // Clear
  clearCopilotSessionState(session1);
  state1 = getCopilotSessionState(session1);
  assert.equal(state1.requestCount, 0);
});
test("Copilot config defaults", async () => {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  
  assert.ok(config.copilot);
  assert.equal(config.copilot.enabled, true);
  assert.equal(config.copilot.mode, "strict");
  assert.equal(config.copilot.billingInterval, 5);
  assert.equal(config.copilot.setRequiredHeaders, true);
  assert.equal(config.copilot.forceOverrideInitiator, false);
  assert.equal(config.copilot.debug, false);
});
test("Copilot provider detection and header strategy core", async () => {
  const { isCopilotProvider, applyCopilotHeaders } = await import("./copilot.js");

  // Test isCopilotProvider
  assert.equal(isCopilotProvider({ provider: { id: "github-copilot" } }), true);
  assert.equal(isCopilotProvider({ provider: { id: "openai" } }), false);
  assert.equal(isCopilotProvider({}), false);

  // Test applyCopilotHeaders no-op for non-copilot
  const output1 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "openai" } }, output1);
  assert.equal(Object.keys(output1.headers).length, 0);

  // Test applyCopilotHeaders sets required headers
  const output2 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" } }, output2);
  assert.equal(output2.headers["Editor-Version"], "vscode/1.96.2");
  assert.equal(output2.headers["Copilot-Integration-Id"], "vscode-chat");

  // Test applyCopilotHeaders preserves existing x-initiator if forceOverrideInitiator=false
  const output3 = { headers: { "x-initiator": "user" } as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" } }, output3);
  assert.equal(output3.headers["x-initiator"], "user");

  // Test applyCopilotHeaders skips override if npm is @ai-sdk/github-copilot
  const output4 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" }, model: { api: { npm: "@ai-sdk/github-copilot" } } }, output4);
  assert.equal(output4.headers["x-initiator"], undefined);
});
test("Copilot passthrough and strict modes", async () => {
  const { applyCopilotHeaders } = await import("./copilot.js");
  const { saveConfig, loadConfig } = await import("./config.js");

  // Setup config for passthrough
  const config = loadConfig();
  config.copilot.mode = "passthrough";
  saveConfig(config);

  const output1 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" } }, output1);
  assert.equal(output1.headers["x-initiator"], undefined);

  // Setup config for strict
  config.copilot.mode = "strict";
  saveConfig(config);

  // Strict mode: user message
  const output2 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" }, messages: [{ role: "user" }] }, output2);
  assert.equal(output2.headers["x-initiator"], "user");

  // Strict mode: agent message
  const output3 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" }, messages: [{ role: "user" }, { role: "assistant" }] }, output3);
  assert.equal(output3.headers["x-initiator"], "agent");

  // Strict mode: tool message
  const output4 = { headers: {} as Record<string, string> };
  await applyCopilotHeaders({ provider: { id: "github-copilot" }, messages: [{ role: "user" }, { role: "tool" }] }, output4);
  assert.equal(output4.headers["x-initiator"], "agent");
});