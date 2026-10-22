#!/usr/bin/env node
/**
 * 校验 pi-purge 的 skills/ 目录是否被 pi 正确识别，且移植质量达标。
 *
 * 三层检查：
 *   A. 契约层：用 pi 自己的 loadSkills() 加载，要求 0 diagnostics、技能数量、名字规范、description 长度。
 *   B. 移植层：frontmatter 无 dsh 残留字段、正文不残留 redteam_ 动词、不残留 ~/.dsh/redteam 硬路径。
 *   C. 一致性层：正文里的 `rt <verb>` 必须全部存在于 bin/rt.mjs 的 VERBS 表。
 *
 * 用法：node scripts/verify-skills.mjs [--quiet]
 * 退出码：0 全通过；1 有失败项。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const RT_BIN = path.join(ROOT, "bin", "rt.mjs");
const quiet = process.argv.includes("--quiet");

let failures = 0;
const fail = (msg) => { failures++; console.log("  ✗ " + msg); };
const ok = (msg) => { if (!quiet) console.log("  ✓ " + msg); };
const head = (msg) => console.log("\n" + msg);

/** 找到已安装的 pi 发行版，拿它的 skills.js（与运行时同一份实现）。 */
function findPiSkillsModule() {
  if (process.env.PI_SKILLS_JS) return process.env.PI_SKILLS_JS;
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const releases = path.join(agentDir, "install", "releases");
  if (!fs.existsSync(releases)) throw new Error("找不到 pi 安装目录：" + releases);
  const versions = fs.readdirSync(releases).filter((v) => fs.existsSync(path.join(releases, v, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "skills.js")));
  if (!versions.length) throw new Error("已安装的 pi 里找不到 dist/core/skills.js");
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return path.join(releases, versions[versions.length - 1], "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "skills.js");
}

/* ---------- A. 契约层：交给 pi 自己判定 ---------- */
head("[A] pi loadSkills 契约层");
const skillsJs = findPiSkillsModule();
const { loadSkills } = await import(pathToFileURL(skillsJs).href);
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const loaded = loadSkills({ agentDir, cwd: ROOT, skillPaths: [SKILLS_DIR], includeDefaults: false });
if (loaded.diagnostics.length) {
  for (const d of loaded.diagnostics) fail("pi diagnostics: " + d.type + " " + (d.path || "") + " " + d.message);
} else ok("0 diagnostics");
if (loaded.skills.length !== 25) fail("技能数量=" + loaded.skills.length + "，期望 25");
else ok("技能数量 25");

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const seen = new Set();
for (const s of loaded.skills) {
  if (!NAME_RE.test(s.name)) fail("名字不合规：" + s.name);
  if (s.name.length > 64) fail("名字超 64 字符：" + s.name);
  if (seen.has(s.name)) fail("名字重复：" + s.name);
  seen.add(s.name);
  const desc = String(s.description || "");
  if (!desc.trim()) fail("缺 description：" + s.name);
  else if (desc.length > 1024) fail("description 超 1024：" + s.name + " (" + desc.length + ")");
  else if (desc.length < 20) fail("description 过短（<20）：" + s.name);
  const src = String(s.filePath || (s.sourceInfo && s.sourceInfo.path) || "");
  if (!src.endsWith("SKILL.md")) fail("来源不是 SKILL.md：" + (src || s.name));
}
ok("名字/description 逐条合规（" + seen.size + " 条唯一名）");

/* ---------- B. 移植层：frontmatter 与正文 ---------- */
head("[B] 移植层：frontmatter 与正文卫生");
const DSH_ONLY_KEYS = ["whenToUse", "when_to_use", "role:", "enabled:"];
const verbRefs = new Map(); // verb -> [skill]
const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const dir of skillDirs) {
  const file = path.join(SKILLS_DIR, dir, "SKILL.md");
  if (!fs.existsSync(file)) { fail("缺 SKILL.md：" + dir); continue; }
  const raw = fs.readFileSync(file, "utf-8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) { fail("frontmatter 结构不对：" + dir); continue; }
  const [, fm, body] = m;
  for (const key of DSH_ONLY_KEYS) if (new RegExp("^" + key, "m").test(fm)) fail("frontmatter 残留 dsh 字段 " + key + "：" + dir);
  if (!/^name:/m.test(fm)) fail("frontmatter 缺 name：" + dir);
  if (!/^description:/m.test(fm)) fail("frontmatter 缺 description：" + dir);
  if (body.trim().length < 100) fail("正文过短（<100 字符）：" + dir);

  const allowLegacyVerbDoc = dir === "redteam-conventions"; // 约定表里保留 dsh 名词对照
  const bodyForScan = body.replace(/`[^`]*`/g, "");
  if (!allowLegacyVerbDoc && /redteam_[a-z]/.test(body)) fail("正文残留 redteam_ 动词（应用 rt <verb>）：" + dir);
  if (/~\.dsh[\\/]redteam/.test(body)) fail("正文残留 ~/.dsh/redteam 硬路径（应用 $RT_HOME）：" + dir);

  if (dir !== "redteam-conventions") {
    if (!body.includes("redteam-conventions")) fail("正文缺共享约定指针（redteam-conventions）：" + dir);
  }
  if (!/rt\s+(?:preflight|[a-z_]+)/.test(body) && !["redteam-conventions", "redteam-router", "redteam-cn-proxy-pool"].includes(dir)) {
    fail("正文没有引用任何 rt 落库动词：" + dir);
  }
  for (const vm of body.matchAll(/\brt\s+([a-z_]{3,})/g)) {
    const v = vm[1];
    if (!verbRefs.has(v)) verbRefs.set(v, new Set());
    verbRefs.get(v).add(dir);
  }
}
ok("frontmatter/正文卫生检查完成（" + skillDirs.length + " 个目录）");

/* ---------- C. 一致性层：rt 动词必须真实存在 ---------- */
head("[C] 一致性层：rt 动词与 bin/rt.mjs 对表");
const rtSrc = fs.readFileSync(RT_BIN, "utf-8");
const verbLine = rtSrc.match(/const VERBS = new Set\(\[([^\]]+)\]\)/);
if (!verbLine) fail("无法从 bin/rt.mjs 解析 VERBS 表");
const knownVerbs = new Set(verbLine ? verbLine[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")) .filter(Boolean) : []);
if (knownVerbs.size !== 24) fail("rt VERBS 数量=" + knownVerbs.size + "，期望 24");
else ok("rt VERBS 24 个");

const IGNORE = new Set(["m", "the", "a", "and", "or", "is", "are", "to", "of", "for", "with", "in", "on"]); // setext/误匹配的英文词
const unknown = [...verbRefs.keys()].filter((v) => !knownVerbs.has(v) && !IGNORE.has(v));
if (unknown.length) for (const v of unknown) fail("未知 rt 动词：" + v + "（出现于 " + [...verbRefs.get(v)].join(", ") + "）");
else ok("技能引用的动词全部存在（覆盖 " + [...verbRefs.keys()].filter((v) => knownVerbs.has(v)).length + "/24）");

const REQUIRED_CORE = ["asset_add", "asset_query", "chain_add", "credential_add", "tunnel_add", "asset_test"];
for (const v of REQUIRED_CORE) if (!verbRefs.has(v)) fail("核心动词未被任何技能使用：" + v);
ok("核心动词覆盖检查完成");

/* ---------- 汇总 ---------- */
if (failures === 0) {
  console.log("\n✓ skills 校验通过：" + loaded.skills.length + " 个技能，0 diagnostics，动词表一致");
  process.exit(0);
}
console.log("\n✗ skills 校验失败：" + failures + " 项");
process.exit(1);
