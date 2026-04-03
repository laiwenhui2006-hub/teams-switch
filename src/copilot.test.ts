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
