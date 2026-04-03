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