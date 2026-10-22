#!/usr/bin/env node
// rt — redteam 落库 CLI（pi-purge 技能共用）
// 用法：rt <verb> [--eng ID] [--k v | --k=v | --json '{"k":"v"}']
// 存储：$RT_HOME/engagements/<eng>/ledger.jsonl（RT_HOME 默认 ~/.dsh/redteam）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";

const RT_HOME = process.env.RT_HOME && process.env.RT_HOME.trim() ? path.resolve(process.env.RT_HOME) : path.join(os.homedir(), ".dsh", "redteam");
const VERBS = new Set(["asset_add","asset_upsert","asset_link","asset_query","asset_test","web_list","vuln_add","vuln_update","chain_add","credential_add","credential_list","access_add","access_list","tunnel_add","tunnel_update","session_check","score_hit","webshell_add","http_evidence_add","poc_add","poc_get","poc_search","attack_file_add","preflight"]);
const WRITE_VERBS = new Set(["asset_add","asset_upsert","asset_link","asset_test","vuln_add","vuln_update","chain_add","credential_add","access_add","tunnel_add","tunnel_update","score_hit","webshell_add","http_evidence_add","poc_add","attack_file_add"]);
const REQUIRED = {
  asset_add: ["ip"], asset_upsert: ["ip"], asset_link: ["from","to","relation"], asset_test: ["target"],
  vuln_add: ["target","name"], vuln_update: ["id"], chain_add: ["stage_code","action"],
  credential_add: ["username"], access_add: ["host","method"], tunnel_add: ["kind","local","remote"],
  tunnel_update: ["id"], score_hit: ["category"], webshell_add: ["url","type"],
  http_evidence_add: ["target"], poc_add: ["name"], attack_file_add: ["path"],
};

function parseArgv(argv) {
  const out = { _: [], fields: {}, eng: process.env.RT_ENG || "default" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--eng") { out.eng = argv[++i]; continue; }
    if (a === "--json") {
      const raw = argv[++i];
      if (!raw) fail("--json 缺值");
      const obj = JSON.parse(raw);
      Object.assign(out.fields, obj);
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 1) { out.fields[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out.fields[k] = v;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function fail(msg, code = 2) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}
function engDir(eng) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(eng)) fail("eng 只允许字母数字 . _ -（≤64）");
  return path.join(RT_HOME, "engagements", eng);
}
function ledger(file) {
  try {
    return fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch { return []; }
}
function append(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf-8");
}
function pocsFile() { return path.join(RT_HOME, "pocs", "index.jsonl"); }
function assetKey(row) { return String(row.ip || row.host || row.url || row.target || row.domain || ""); }
function print(rows) { for (const r of rows) console.log(JSON.stringify(r)); }

const cmd = process.argv[2];
if (!cmd || cmd === "-h" || cmd === "--help") {
  console.log("用法: rt <verb> [--eng ID] [--k v]   verbs: " + [...VERBS].join(", "));
  process.exit(0);
}
if (!VERBS.has(cmd)) fail("未知 verb: " + cmd);
const { fields, eng } = parseArgv(process.argv.slice(3));
const dir = engDir(eng);
const file = path.join(dir, "ledger.jsonl");

const missing = (REQUIRED[cmd] || []).filter((k) => fields[k] === undefined || fields[k] === "");
if (missing.length) fail("缺少字段: " + missing.join(", "));

if (cmd === "preflight") {
  const want = ["nmap","masscan","ffuf","feroxbuster","gobuster","nuclei","subfinder","dnsx","naabu","httpx","katana","hashcat","john","hydra","curl","jq"];
  const which = (b) => {
    const r = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [b] : ["-v", b], { encoding: "utf-8", shell: process.platform !== "win32" });
    return r.status === 0;
  };
  const found = want.filter(which);
  const report = {
    ok: true, rt_home: RT_HOME, rt_home_exists: fs.existsSync(RT_HOME),
    engagement: eng, available: found, missing: want.filter((b) => !found.includes(b)),
    onboarding: { complete: fs.existsSync(RT_HOME), fofa_key_env: Boolean(process.env.FOFA_KEY) },
  };
  append(file, { ts: new Date().toISOString(), verb: "preflight", ...report });
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (cmd === "session_check") {
  const host = fields.host || fields.target;
  if (!host) { print(ledger(file).filter((r) => r.verb === "access_add" || r.verb === "tunnel_add")); process.exit(0); }
  const timeout = Number(fields.timeout_ms || 3000);
  const sock = net.connect({ host, port: Number(fields.port || 22), timeout });
  sock.on("connect", () => { sock.destroy(); console.log(JSON.stringify({ ok: true, host, port: Number(fields.port || 22), reachable: true })); });
  sock.on("timeout", () => { sock.destroy(); console.log(JSON.stringify({ ok: true, host, reachable: false, reason: "timeout" })); });
  sock.on("error", (e) => console.log(JSON.stringify({ ok: true, host, reachable: false, reason: e.code || e.message })));
  process.exit(0);
}

if (cmd === "asset_upsert") {
  const rows = ledger(file);
  const key = assetKey(fields);
  const idx = rows.findIndex((r) => r.verb === "asset_add" && assetKey(r) === key);
  const row = { ts: new Date().toISOString(), verb: "asset_add", ...(idx >= 0 ? rows[idx] : {}), ...fields, upserted: true };
  if (idx >= 0) { rows[idx] = row; fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8"); }
  else append(file, row);
  console.log(JSON.stringify({ ok: true, verb: "asset_add", key, updated: idx >= 0 }));
  process.exit(0);
}

if (cmd === "asset_query" || cmd === "credential_list" || cmd === "access_list" || cmd === "web_list" || cmd === "poc_search") {
  let rows = cmd === "poc_search" ? ledger(pocsFile()) : ledger(file);
  if (cmd === "web_list") rows = rows.filter((r) => r.verb === "asset_add" && (r.url || ["80","443","8080","8000","8443","9000","3000"].includes(String(r.port))));
  if (cmd === "asset_query") rows = rows.filter((r) => r.verb === "asset_add" || r.verb === "asset_test");
  if (cmd === "credential_list") rows = rows.filter((r) => r.verb === "credential_add");
  if (cmd === "access_list") rows = rows.filter((r) => r.verb === "access_add");
  const where = Object.entries(fields).filter(([k]) => k !== "q" && k !== "limit");
  rows = rows.filter((r) => where.every(([k, v]) => String(r[k] ?? "").toLowerCase().includes(String(v).toLowerCase())));
  const q = fields.q || fields.query;
  if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(String(q).toLowerCase()));
  const limit = Number(fields.limit || 200);
  print(rows.slice(-limit));
  process.exit(0);
}

if (cmd === "poc_get") {
  const id = fields.id || fields._[0];
  const hit = ledger(pocsFile()).find((r) => String(r.id) === String(id) || String(r.name) === String(id));
  if (!hit) fail("没有这个 POC: " + id, 1);
  console.log(JSON.stringify(hit, null, 2));
  process.exit(0);
}

if (cmd === "vuln_update" || cmd === "tunnel_update") {
  const rows = ledger(file);
  const id = String(fields.id);
  const idx = rows.findIndex((r) => String(r.id) === id);
  if (idx < 0) fail("没有这个 id: " + id, 1);
  rows[idx] = { ...rows[idx], ...fields, ts: new Date().toISOString(), updated: true };
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  console.log(JSON.stringify({ ok: true, verb: cmd, id }));
  process.exit(0);
}

if (WRITE_VERBS.has(cmd)) {
  const target = cmd === "poc_add" ? pocsFile() : file;
  const row = { ts: new Date().toISOString(), verb: cmd, eng, ...fields };
  if (cmd === "poc_add" && !row.id) row.id = "poc-" + Date.now().toString(36);
  append(target, row);
  const rel = path.relative(RT_HOME, target).split(path.sep).join("/");
  console.log(JSON.stringify({ ok: true, verb: cmd, file: rel, id: row.id }));
  process.exit(0);
}

fail("未实现的 verb: " + cmd, 1);
