import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { appDataDir } from "@embedded/db";
import { LlmSettings, defaultLlmSettings } from "@embedded/llm";

function settingsPath(): string {
  return join(appDataDir(), "settings.json");
}

/** settings.json holds all app settings; llm is one key so future settings coexist. */
interface SettingsFile {
  llm?: unknown;
}

export function readLlmSettings(): LlmSettings {
  const path = settingsPath();
  if (!existsSync(path)) return defaultLlmSettings();
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
    return LlmSettings.parse(file.llm ?? {});
  } catch {
    // corrupt or stale settings never brick the app — fall back to defaults
    return defaultLlmSettings();
  }
}

export function writeLlmSettings(settings: LlmSettings): void {
  const path = settingsPath();
  let file: SettingsFile = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
    } catch {
      file = {};
    }
  }
  file.llm = settings;
  writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
}
