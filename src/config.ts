import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The structure of an account in the token pool
export interface Account {
  id: string; // Unique nickname or chatgpt_account_id
  accessToken: string;
  refreshToken?: string;
  addedAt: number;
  isValid: boolean;
}

export interface TeamsConfig {
  currentIndex: number;
  lastSwitchTime: number; // 上次切换账号的时间戳（ms），持久化以跨重启保留冷却状态
  accounts: Account[];
}

const OPENCODE_DIR = path.join(os.homedir(), ".opencode");
const CONFIG_FILE = path.join(OPENCODE_DIR, "teams-switch.json");

// Ensure opencode dir exists (usually it does)
function ensureConfigDir() {
  if (!fs.existsSync(OPENCODE_DIR)) {
    fs.mkdirSync(OPENCODE_DIR, { recursive: true });
  }
}

// Load configurations
export function loadConfig(): TeamsConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { currentIndex: 0, lastSwitchTime: 0, accounts: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as TeamsConfig;
  } catch (err) {
    console.error("[Teams Switch] Failed to load config, returning default.", err);
    return { currentIndex: 0, lastSwitchTime: 0, accounts: [] };
  }
}

// Save configurations
export function saveConfig(config: TeamsConfig) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// Read current active auth from standard OpenCode auth
export function readOpencodeAuth(provider: string = "openai"): any {
  // OpenCode typically stores auth logic in XDG data dir or AppData
  let authFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  if (!fs.existsSync(authFile)) {
    // Fallback logic for macOS native app data just in case
    authFile = path.join(os.homedir(), "Library", "Application Support", "opencode", "auth.json");
  }
  if (!fs.existsSync(authFile)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(authFile, "utf-8");
    const json = JSON.parse(raw);
    return json[provider];
  } catch {
    return null;
  }
}
