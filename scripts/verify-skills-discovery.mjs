#!/usr/bin/env node
/**
 * 用 pi 自己的资源加载器（DefaultResourceLoader + SettingsManager）证明：
 * 装成 package 之后，skills/ 里的 25 个 SKILL.md 真的进了 pi 的技能清单。
 *
 * 与 verify-skills.mjs 的区别：那个只证明"文件符合规范、pi 的 loadSkills 能解析"；
 * 这个证明"pi 的 package manifest 收集链路真的把 skills 资源解析出来了"（resolve → enabled → updateSkillsFromPaths）。
 *
 * 用法：node scripts/verify-skills-discovery.mjs [--agent-dir <dir>] [--cwd <dir>]
 * 默认 agent-dir = 环境变量 PI_CODING_AGENT_DIR 或 <repo>/verify/agent（里面 settings.json 的 packages 指向本仓库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const agentDir = path.resolve(opt("--agent-dir", process.env.PI_CODING_AGENT_DIR || path.join(ROOT, "verify", "agent")));
const cwd = path.resolve(opt("--cwd", ROOT));

function findDist() {
  if (process.env.PI_DIST) return process.env.PI_DIST;
  const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  if (!fs.existsSync(releases)) throw new Error("找不到 pi 安装目录：" + releases);
  const ok = fs.readdirSync(releases).filter((v) => fs.existsSync(path.join(releases, v, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "resource-loader.js")));
  ok.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!ok.length) throw new Error("已安装的 pi 里找不到 dist/core/resource-loader.js");
  return path.join(releases, ok[ok.length - 1], "node_modules", "@earendil-works", "pi-coding-agent", "dist");
}

const dist = findDist();
const importCore = (rel) => import(pathToFileURL(path.join(dist, "core", rel)).href);
const { DefaultResourceLoader } = await importCore("resource-loader.js");
const settingsMod = await importCore("settings.js").catch(() => ({}));

const settingsFile = path.join(agentDir, "settings.json");
if (!fs.existsSync(settingsFile)) {
  console.log("✗ " + settingsFile + " 不存在：先在这个 agent-dir 里 pi install 一次本包");
  process.exit(1);
}
const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
console.log("[env] agent-dir = " + agentDir);
console.log("[env] cwd       = " + cwd);
console.log("[env] packages  = " + JSON.stringify(settings.packages ?? []));

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  ...(settingsMod.SettingsManager ? {} : {}),
});
await loader.reload();

const { skills, diagnostics } = loader.getSkills();
const paths = loader.lastSkillPaths ?? [];
const names = skills.map((s) => s.name).sort();
const redteam = names.filter((n) => n.startsWith("redteam-"));

console.log("\n[pi 资源加载器]")
console.log("  skillPaths 条数 = " + paths.length);
for (const p of paths) console.log("    · " + p.replace(ROOT, "."));
console.log("  已加载技能 = " + skills.length + "（redteam-* " + redteam.length + "）");
console.log("  diagnostics = " + diagnostics.length);
for (const d of diagnostics) console.log("    ! " + (d.type || "?") + " " + (d.path || "") + " " + (d.message || ""));

const errors = diagnostics.filter((d) => d.type === "error");
const problems = [];
if (errors.length) problems.push("有 " + errors.length + " 条 error 级 diagnostics");
if (redteam.length !== 25) problems.push("redteam-* 技能数=" + redteam.length + "，期望 25（package manifest 的 pi.skills 没生效？）");
if (!paths.some((p) => p.includes("pi-purge") && p.includes("skills"))) problems.push("lastSkillPaths 里没有指向本包 skills/ 的条目");

if (problems.length) {
  for (const p of problems) console.log("  ✗ " + p);
  process.exit(1);
}
console.log("\n✓ 技能发现链路通过：package manifest → resolved skills → loadSkills → " + redteam.length + " 个 redteam-* 技能");
console.log("  前 5 个：" + redteam.slice(0, 5).join(", "));
