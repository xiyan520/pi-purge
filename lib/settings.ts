/**
 * pi-purge 配置 / settings
 *
 * 落在 pi 自己的 agent 目录里（与 settings.json、auth.json 同级）：
 *   <agent-dir>/pi-purge.json        agent-dir = $PI_CODING_AGENT_DIR ?? ~/.pi/agent
 *
 * 两层优先级：DEFAULTS < 磁盘 json < 环境变量（环境变量只影响本次进程，不会被写回磁盘）：
 *   PI_PURGE=0            整插件停用（不注入、不清洗、不救火）
 *   PI_PURGE_LOCALE=en    换成英文规则层
 *   PI_PURGE_RESCUE=0     关掉拒答续跑
 * 取值大小写不敏感（0/OFF/False 都认）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PurgeSettings {
  /** 总开关。 */
  enabled: boolean;
  /** 注入清洗规则层。 */
  rules: boolean;
  /** 把 project_context 的软引子换成 STRONG 引子。 */
  strongProjectIntro: boolean;
  /** 删掉提示词里宿主级的硬回绝条款（作用在渲染后的整段 system 上）。 */
  stripHostClauses: boolean;
  /** 清洗 transcript 里历史的拒答。 */
  scrubHistory: boolean;
  /** 检测到拒答时自动续跑。 */
  refusalRescue: boolean;
  /** 每轮最多续跑几次。 */
  rescueMax: number;
  /** 连续被打回几次就本轮停手（有效上限 = min(rescueMax, maxFailStreak)）。 */
  maxFailStreak: number;
  /** 续跑用的那句话；空 = 用内置文案。 */
  continueText: string;
  /** 规则层语言。 */
  locale: "zh" | "en";
}

export const DEFAULTS: PurgeSettings = {
  enabled: true,
  rules: true,
  strongProjectIntro: true,
  stripHostClauses: false,
  scrubHistory: true,
  refusalRescue: true,
  rescueMax: 3,
  maxFailStreak: 3,
  continueText: "",
  locale: "zh",
};

/** continueText 上限：它会进 prompt，别让人把整本书塞进来。 */
const CONTINUE_TEXT_MAX = 500;

export function agentDir(): string {
  const fromEnv = String(process.env.PI_CODING_AGENT_DIR || "").trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".pi", "agent");
}

export function settingsPath(): string {
  return path.join(agentDir(), "pi-purge.json");
}

const BOOL_KEYS = [
  "enabled",
  "rules",
  "strongProjectIntro",
  "stripHostClauses",
  "scrubHistory",
  "refusalRescue",
] as const;

function coerce(raw: unknown): Partial<PurgeSettings> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<PurgeSettings> = {};
  for (const key of BOOL_KEYS) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  if (typeof src.rescueMax === "number" && Number.isFinite(src.rescueMax)) {
    out.rescueMax = Math.max(0, Math.min(20, Math.trunc(src.rescueMax)));
  }
  if (typeof src.maxFailStreak === "number" && Number.isFinite(src.maxFailStreak)) {
    out.maxFailStreak = Math.max(1, Math.min(50, Math.trunc(src.maxFailStreak)));
  }
  if (typeof src.continueText === "string") {
    out.continueText = src.continueText.slice(0, CONTINUE_TEXT_MAX);
  }
  if (src.locale === "en" || src.locale === "zh") out.locale = src.locale;
  return out;
}

/**
 * 磁盘上的 json 是不是坏的（存在但解析不了）。
 * 坏文件不会静默变成 DEFAULTS 再被 saveSettings 覆盖：保存前会先改名留档。
 */
let brokenOnDisk = false;

export function settingsFileBroken(): boolean {
  // 现场重新判定一次，别让「调用顺序」决定结论（例如用户手改了文件之后才问）。
  readFileSettings();
  return brokenOnDisk;
}

/** 只读磁盘 + 默认值，不含环境变量（保存时用这个当基底，避免把 env 写进文件）。 */
export function readFileSettings(): PurgeSettings {
  let file: Partial<PurgeSettings> = {};
  brokenOnDisk = false;
  try {
    const fp = settingsPath();
    if (fs.existsSync(fp)) {
      // 记事本保存会带 BOM，先剥掉再解析，否则合法文件会被当成坏文件。
      const raw = fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          if (raw.trim()) brokenOnDisk = true;
          file = {};
        } else {
          const coerced = coerce(parsed);
          // 有键被 coerce 丢掉 = 值类型不对（例如 rescueMax:"7"），同样当坏文件留档。
          const kept = Object.keys(coerced).filter((k) => (parsed as Record<string, unknown>)[k] !== undefined).length;
          const present = Object.keys(parsed as Record<string, unknown>).filter((k) => (parsed as Record<string, unknown>)[k] !== undefined).length;
          if (kept < present) brokenOnDisk = true;
          file = coerced;
        }
      } catch {
        if (raw.trim()) brokenOnDisk = true; // 空文件视为没配置，不算坏
        file = {};
      }
    }
  } catch {
    file = {};
  }
  return { ...DEFAULTS, ...file };
}

function envFlag(name: string): boolean | undefined {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return undefined;
  if (["1", "true", "yes", "y", "on", "enable", "enabled"].includes(v)) return true;
  if (["0", "false", "no", "n", "off", "disable", "disabled"].includes(v)) return false;
  return undefined;
}

function envLocale(): "zh" | "en" | undefined {
  const v = String(process.env.PI_PURGE_LOCALE ?? "").trim().toLowerCase();
  if (v === "en") return "en";
  if (v === "zh") return "zh";
  return undefined;
}

/** 叠加环境变量覆盖（不在磁盘上留痕）。 */
export function applyEnv(base: PurgeSettings): PurgeSettings {
  const merged = { ...base };
  const enabled = envFlag("PI_PURGE");
  if (enabled === false) merged.enabled = false;
  const rescue = envFlag("PI_PURGE_RESCUE");
  if (rescue === false) merged.refusalRescue = false;
  const locale = envLocale();
  if (locale) merged.locale = locale;
  return merged;
}

export function loadSettings(): PurgeSettings {
  return applyEnv(readFileSettings());
}

/**
 * 改配置：以「磁盘值 + patch」为落盘内容，返回叠加了 env 的运行时值。
 * 这样 /purge on 不会把 PI_PURGE_LOCALE=en 之类的一次性环境变量固化进 json。
 */
export function saveSettings(patch: Partial<PurgeSettings>): PurgeSettings {
  // patch 也过一遍 coerce：continueText 截断、rescueMax 夹取，磁盘上不存脏值。
  const next: PurgeSettings = { ...readFileSettings(), ...coerce(patch) };
  const fp = settingsPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // 手改坏的 json 先改名留档（A2：不删除，只移动），否则这次写入会把用户设置冲成默认值。
  if (brokenOnDisk && fs.existsSync(fp)) {
    fs.renameSync(fp, fp + ".corrupt-" + Date.now() + ".bak");
    brokenOnDisk = false;
  }
  const tmp = fp + "." + process.pid + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(next, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清不掉就算了，别盖住原始错误 */
    }
    throw error;
  }
  return applyEnv(next);
}
