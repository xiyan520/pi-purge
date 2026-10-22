/**
 * 用 pi 自己的加载路径（jiti）验证扩展能否被真实装载。
 * 只做装载 + 工厂调用 + 事件触发，不发任何模型请求。
 *
 * 运行：node scripts/verify-load.mjs
 * 找不到 pi 时可用 PI_CODING_AGENT_DIR / PI_JITI_MJS 指定。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, "..", "index.ts");

/** 找到 pi 自带的 jiti：PI_JITI_MJS > 最新 release 里的 node_modules/jiti/lib/jiti.mjs */
function resolveJiti() {
  if (process.env.PI_JITI_MJS) return process.env.PI_JITI_MJS;
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const releases = path.join(agentDir, "install", "releases");
  const names = fs.existsSync(releases)
    ? fs
        .readdirSync(releases)
        .map((name) => ({ name, mtime: fs.statSync(path.join(releases, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map((x) => x.name)
    : [];
  for (const name of names) {
    const candidate = path.join(releases, name, "node_modules", "jiti", "lib", "jiti.mjs");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 pi 自带的 jiti，请用 PI_JITI_MJS=<path to jiti/lib/jiti.mjs> 指定");
}

const { createJiti } = await import(pathToFileURL(resolveJiti()).href);

const jiti = createJiti(import.meta.url, { moduleCache: false });
const factory = await jiti.import(extensionPath, { default: true });
if (typeof factory !== "function") throw new Error("default export 不是工厂函数");
console.log("✓ jiti 装载成功：", extensionPath);

// 最小宿主，确认事件能挂上、规则层真的注入
const handlers = new Map();
const commands = new Map();
const notices = [];
const api = {
  on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); return () => {}; },
  registerCommand(name, opts) { commands.set(name, opts); },
};
await factory(api);

console.log("✓ 注册事件：", [...handlers.keys()].join(", "));
console.log("✓ 注册命令：", [...commands.keys()].join(", "));

const emit = async (name, payload) => {
  let last;
  for (const fn of handlers.get(name) ?? []) last = await fn(payload, { ui: { notify: (m, t) => notices.push([t, m]) } });
  return last;
};

const sections = { preamble: "P", project_context: "Project-specific instructions and guidelines:\n- 用中文" };
await emit("before_agent_start", { type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections, cwd: process.cwd() } });
if (!sections.purge_rules) throw new Error("规则段没注入");
if (sections.project_context.includes("Project-specific instructions and guidelines:")) throw new Error("软引子没被替换");
console.log("✓ purge_rules 段：", sections.purge_rules.length, "字节；引子已强化");

await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I cannot help with that." } });
const r = await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" });
if (!r || r.continue !== true) throw new Error("拒答没触发续跑");
console.log("✓ 拒答 → continue:true，续跑文案：", String(r.entries[0].content).slice(0, 40) + "…");

await commands.get("purge").handler("status", { ui: { notify: (m, t) => notices.push([t, m]) } });
console.log("✓ /purge status →\n" + notices.at(-1)[1]);

console.log("\n全部通过。");
