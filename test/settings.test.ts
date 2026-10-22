import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 每个测试文件是独立进程，所以可以在 import 前把 agent 目录指到临时目录。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-settings-"));
process.env.PI_CODING_AGENT_DIR = dir;

const { loadSettings, readFileSettings, saveSettings, settingsFileBroken } = await import("../lib/settings.ts");

const file = () => path.join(dir, "pi-purge.json");

test("默认值", () => {
  const s = loadSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.rules, true);
  assert.equal(s.rescueMax, 3);
  assert.equal(s.continueText, "");
  assert.equal(s.locale, "zh");
  assert.equal(s.stripHostClauses, false);
});

test("saveSettings 落盘，readFileSettings 读回", () => {
  saveSettings({ rules: false, rescueMax: 5 });
  const disk = JSON.parse(fs.readFileSync(file(), "utf8"));
  assert.equal(disk.rules, false);
  assert.equal(disk.rescueMax, 5);
  assert.equal(readFileSettings().rules, false);
});

test("环境变量只在运行时生效，不会被写回磁盘", () => {
  process.env.PI_PURGE_LOCALE = "EN";
  const runtime = saveSettings({ scrubHistory: false });
  assert.equal(runtime.locale, "en", "运行时按 env");
  const disk = JSON.parse(fs.readFileSync(file(), "utf8"));
  assert.equal(disk.locale, "zh", "磁盘不该固化 env");
  delete process.env.PI_PURGE_LOCALE;
});

test("env 取值大小写不敏感", () => {
  process.env.PI_PURGE = "OFF";
  assert.equal(loadSettings().enabled, false);
  process.env.PI_PURGE = "On";
  assert.equal(loadSettings().enabled, true);
  delete process.env.PI_PURGE;
  process.env.PI_PURGE_RESCUE = "False";
  assert.equal(loadSettings().refusalRescue, false);
  delete process.env.PI_PURGE_RESCUE;
});

test("continueText 有长度上限", () => {
  const s = saveSettings({ continueText: "x".repeat(900) });
  assert.equal(s.continueText.length, 500);
});

test("maxFailStreak 默认 3，夹取 1–50", () => {
  assert.equal(readFileSettings().maxFailStreak, 3);
  assert.equal(saveSettings({ maxFailStreak: 0 }).maxFailStreak, 1);
  assert.equal(saveSettings({ maxFailStreak: 999 }).maxFailStreak, 50);
  assert.equal(saveSettings({ maxFailStreak: 7 }).maxFailStreak, 7);
});

test("BOM 不算坏文件（记事本保存的 json 照常读）", () => {
  fs.writeFileSync(file(), "\uFEFF" + JSON.stringify({ rescueMax: 6 }), "utf8");
  const s = readFileSettings();
  assert.equal(s.rescueMax, 6);
  assert.equal(settingsFileBroken(), false);
  saveSettings({ locale: "zh" });
  assert.equal(JSON.parse(fs.readFileSync(file(), "utf8")).rescueMax, 6, "BOM 文件不该被当坏的覆盖掉");
});

test("值类型错（rescueMax:\"7\"）算坏文件，保存时留档", () => {
  const before = fs.readdirSync(dir).filter((n) => n.endsWith(".bak")).length;
  fs.writeFileSync(file(), JSON.stringify({ rescueMax: "7" }), "utf8");
  assert.equal(settingsFileBroken(), true);
  saveSettings({ locale: "en" });
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith("pi-purge.json.corrupt-") && n.endsWith(".bak"));
  assert.ok(baks.length >= before + 1);
  assert.equal(settingsFileBroken(), false);
});

test("JSON 不是对象（null / 数组 / 数字）也算坏文件", () => {
  for (const raw of ["null", "[1,2]", "42"]) {
    fs.writeFileSync(file(), raw, "utf8");
    assert.equal(settingsFileBroken(), true, "应当判坏: " + raw);
  }
});

test("坏 json 不静默丢配置：保存前先改名留档", () => {
  const baksOf = () => fs.readdirSync(dir).filter((n) => n.startsWith("pi-purge.json.corrupt-") && n.endsWith(".bak"));
  const before = baksOf().length;
  fs.writeFileSync(file(), '{"rescueMax": 7,,}', "utf8");
  assert.equal(readFileSettings().rescueMax, 3, "解析失败先按默认值跑");
  assert.equal(settingsFileBroken(), true, "要让调用方知道盘子是坏的");
  saveSettings({ locale: "en" });
  assert.equal(settingsFileBroken(), false);
  const baks = baksOf();
  assert.equal(baks.length, before + 1, "坏文件必须留一份 .bak");
  const newest = baks
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]!.n;
  assert.match(fs.readFileSync(path.join(dir, newest), "utf8"), /rescueMax/);
  assert.equal(JSON.parse(fs.readFileSync(file(), "utf8")).locale, "en");
});
