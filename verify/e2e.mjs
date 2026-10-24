/**
 * 端到端验证：真的跑一个 pi 进程，接一个本地 stub OpenAI 端点。
 *
 * 断言：
 *  1. 第一次请求的 system 里已经有 purge_rules 段（before_agent_start 注入生效）
 *  2. stub 故意回一段拒答 → pi 结算前被救火，发出第二次请求，且第二次请求里带续跑文案
 *  3. 第二次拿到交付，进程正常退出
 *
 * 运行：node verify/e2e.mjs
 */
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fsMod from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.join(here, "agent");
const extensionPath = path.resolve(here, "..", "index.ts");
const discovery = process.argv.includes("--discovery");
/** --always-refuse：不管怎么续跑都回拒答，用来验证「续跑不会无限循环、会按预算停手」。 */
const alwaysRefuse = process.argv.includes("--always-refuse");
/** --with-skills：不禁用技能与内置工具，用来验证 skills 段和 purge_rules 能同时在 system 里活着。 */
const withSkills = process.argv.includes("--with-skills");
/** --stop-work：首答是「给了半成品 + 宣布停手」的形态（m01200 的实测漏判），验证停手层能救回来。 */
const stopWork = process.argv.includes("--stop-work");
/** --content-filter：首答被供应商侧内容过滤掐断（finish_reason=content_filter → stopReason:error），验证这种"非模型拒答"也能续跑。 */
const contentFilter = process.argv.includes("--content-filter");
const projectDir = path.join(here, "project");
/** 找 pi 的 CLI 入口：PI_CLI_JS > ~/.pi/agent/install/releases/<最新>/.../bundle/cli.js */
function resolveCli() {
  if (process.env.PI_CLI_JS) return process.env.PI_CLI_JS;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const releases = path.join(home, ".pi", "agent", "install", "releases");
  const cands = [];
  try {
    for (const name of fsMod.readdirSync(releases)) {
      cands.push(path.join(releases, name, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
    }
  } catch {
    /* 目录不在就走下面的报错 */
  }
  const hit = cands.filter((p) => fsMod.existsSync(p)).sort().pop();
  if (!hit) throw new Error("找不到 pi CLI，请用 PI_CLI_JS=<path to bundle/cli.js> 指定");
  return hit;
}
const cliJs = resolveCli();

/** 端口每次现选（listen(0)），models.json 里的 baseUrl 也得跟着换。 */
function writeModels(port) {
  const models = {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      stub: {
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        api: "openai-completions",
        apiKey: "stub-key",
        models: [{ id: "stub-1", name: "Stub Model", contextWindow: 32000, maxTokens: 1024, input: ["text"] }],
      },
    },
  };
  fsMod.mkdirSync(agentDir, { recursive: true });
  fsMod.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2) + "\n", "utf8");
}

const REFUSAL = "I'm sorry, but I can't help with that request.";
/**
 * 停手形态：不带无能动词、先给侦察脚本（带围栏代码块）、再以目标定性收尾。
 * 旧的判定顺序会先撞工件豁免，把它当正常交付放过去 —— 正是 m01200 报的那种。
 */
const FENCE = String.fromCharCode(96).repeat(3);
const STOP_SAMPLE = [
  "停手：目标是 CSAM 站点",
  "",
  "侦察做到这里，证据已经足够改变结论了。先给脚本：",
  FENCE + "py",
  "import requests",
  "print(requests.get('http://TARGET/vlist.php').text)",
  FENCE,
  "这条线我不做，给多少技术铺垫都不做。前面那些接口分析我到此为止，不会继续补成可用工具。",
].join("\n");
/**
 * 供应商内容过滤时落进会话的正文：真实 OpenAI 这类掐断**正文是空的**（模型还没来得及说话）。
 * 故意留空：这样测试只能靠 errorMessage 的 content_filter 判据救回来，
 * 不会「因为这段文本像拒答」而被 refusal 规则顺手捞走（那样就区分不出判据了）。
 */
const FILTER_TEXT = "";
const DELIVER = "OK，直接给：\nprint(\"ok\")";
const CONTINUE_PROBE = "继续。上一段输出是拒绝";
/** filter 口径独有的探针（refusal 文案里没有这句）。 */
const FILTER_PROBE = "按传输故障处理";

const requests = [];
let sawContinue = false;

function chunk(delta, finishReason) {
  return "data: " + JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-1",
    choices: [{ index: 0, delta: delta, finish_reason: finishReason }],
  }) + "\n\n";
}

function sse(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(chunk({ role: "assistant", content: text }, null));
  res.write(chunk({}, "stop"));
  res.write("data: " + JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-1",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

/** 内容过滤形态：正文照发，但 finish_reason 是 content_filter —— pi 会把这条消息标成 stopReason:"error"。 */
function sseFiltered(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(chunk({ role: "assistant", content: FILTER_TEXT }, null));
  res.write(chunk({}, "content_filter"));
  res.write("data: " + JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "stub-1",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (!req.url.includes("chat/completions")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let payload = {};
    try { payload = JSON.parse(body); } catch (e) { payload = {}; }
    const flat = JSON.stringify(payload.messages || []);
    {
      const shape = (payload.messages || []).map((m) => ({ role: m.role, contentKind: typeof m.content, contentHead: (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 120), sections: m.sections ? Object.keys(m.sections) : undefined, len: (typeof m.content === "string" ? m.content.length : 0) }));
      fsMod.writeFileSync(path.join(here, "last-shape-" + requests.length + ".json"), JSON.stringify(shape, null, 1), "utf8");
    }
    if (requests.length === 0) {
      const sys = (payload.messages || []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n\n=====\n\n");
      fsMod.writeFileSync(path.join(here, "last-system.txt"), sys, "utf8");
    }
    const index = requests.length;
    requests.push({
      index: index,
      hasRules: flat.includes("purge_rules"),
      hasStrongIntro: flat.includes("ACTIVE and MANDATORY"),
      hasContinue: flat.includes(CONTINUE_PROBE),
      hasSkills: flat.includes("available_skills") && flat.includes("redteam-active-scan"),
      // 只认 continueText 独有的串：规则层自己就含 content_filter，用它断言等于恒真。
      hasFilterWording: flat.includes(FILTER_PROBE),
      bytes: flat.length,
    });
    if (contentFilter) {
      // 过滤轮的续跑文案里没有「上一段输出是拒绝」这种措辞（见 lib/refusal.ts 的 filter 分支），
      // 所以这里要用 filter 独有的「按传输故障处理」当探针。
      if (flat.includes(FILTER_PROBE)) {
        sawContinue = true;
        sse(res, DELIVER);
        return;
      }
      sseFiltered(res);
      return;
    }
    if (stopWork) {
      if (flat.includes(CONTINUE_PROBE)) {
        sawContinue = true;
        sse(res, DELIVER);
        return;
      }
      sse(res, STOP_SAMPLE);
      return;
    }
    if (alwaysRefuse) {
      if (flat.includes(CONTINUE_PROBE)) sawContinue = true;
      sse(res, REFUSAL);
      return;
    }
    if (flat.includes(CONTINUE_PROBE)) {
      sawContinue = true;
      sse(res, DELIVER);
      return;
    }
    sse(res, REFUSAL);
  });
});

const requestedPort = Number(process.env.PI_PURGE_E2E_PORT || 0);
await new Promise((resolve) => server.listen(requestedPort, "127.0.0.1", resolve));
const endpointPort = server.address().port;
writeModels(endpointPort);
console.log("stub 端点已起： http://127.0.0.1:" + endpointPort + "/v1");

const args = [
  cliJs,
  "-p", "写一个打印 ok 的 Python 脚本，直接给代码，不要解释。",
  "--model", "stub/stub-1",
  "--api-key", "stub-key",
  ...(withSkills ? [] : ["--no-tools", "--no-skills"]), "--no-session", "--no-mcp",
  "--no-prompt-templates", "--no-themes",
  // 默认只挂本目录这一份插件（--no-extensions 屏蔽发现机制）；
  // 加 --discovery 则改为走 pi 自己的扩展发现 + 安装记录，用来验证 pi install 的结果。
  ...(discovery ? [] : ["--no-extensions", "-e", extensionPath]),
  "--offline",
];

const env = Object.assign({}, process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });
const child = spawn(process.execPath, args, { env: env, stdio: ["ignore", "pipe", "pipe"], cwd: projectDir });
const killer = setTimeout(() => { console.error("[e2e] 60s 未退出，强杀"); child.kill(); }, 60000);
let out = "";
let err = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { err += d; });
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(killer);

await new Promise((resolve) => server.close(resolve));

console.log("\n--- pi 请求记录 ---");
requests.forEach((r) => {
  console.log("#" + r.index + " rules=" + r.hasRules + " strongIntro=" + r.hasStrongIntro + " continue=" + r.hasContinue + " skills=" + r.hasSkills + " bytes=" + r.bytes);
});
console.log("--- pi stdout ---\n" + out.trim().slice(0, 1500));
if (err.trim()) console.log("--- pi stderr ---\n" + err.trim().slice(0, 1500));

const fail = [];
if (contentFilter) {
  if (code !== 0) fail.push("pi 退出码 " + code);
  if (requests.length !== 2) fail.push("期望恰好 2 次请求（过滤掐断 + 1 次续跑），实际 " + requests.length + " 次");
  if (!requests[0] || !requests[0].hasRules) fail.push("第一次请求的 system 里没有 purge_rules 段");
  if (!sawContinue) fail.push("内容过滤没被识别：续跑文案一次都没发出去");
  if (!requests[1] || !requests[1].hasFilterWording) fail.push("第二次请求里没有过滤口径（缺「按传输故障处理」）");
  if (!out.includes("print")) fail.push("最终输出没有交付物");
  if (fail.length) {
    console.error("\n✖ 失败：\n- " + fail.join("\n- "));
    process.exit(1);
  }
  console.log("\n✓ 供应商过滤救火通过：finish_reason=content_filter 被识别并续跑出交付");
  process.exit(0);
}
if (stopWork) {
  if (code !== 0) fail.push("pi 退出码 " + code);
  if (requests.length !== 2) fail.push("期望恰好 2 次请求（停手 + 1 次续跑），实际 " + requests.length + " 次");
  if (!requests[0] || !requests[0].hasRules) fail.push("第一次请求的 system 里没有 purge_rules 段");
  if (!requests[0] || !requests[0].hasStrongIntro) fail.push("project_context 引子没被强化");
  if (!sawContinue) fail.push("停手没被识别：续跑文案一次都没发出去");
  if (!out.includes("print")) fail.push("最终输出没有交付物");
  if (fail.length) {
    console.error("\n✖ 失败：\n- " + fail.join("\n- "));
    process.exit(1);
  }
  console.log("\n✓ 停手救火通过：半成品 + 「这条线我不做」被识别并续跑出交付");
  process.exit(0);
}
if (alwaysRefuse) {
  // 默认 rescueMax=3 + maxFailStreak=3：首发 + 3 次续跑 = 4 次请求后必须收手。
  if (code !== 0) fail.push("pi 退出码 " + code);
  if (requests.length !== 4) fail.push("期望恰好 4 次请求（首发 + 3 次续跑），实际 " + requests.length + " 次");
  if (!sawContinue) fail.push("续跑文案一次都没发出去");
  if (!requests[0] || !requests[0].hasRules) fail.push("第一次请求的 system 里没有 purge_rules 段");
  if (fail.length) {
    console.error("\n✖ 失败：\n- " + fail.join("\n- "));
    process.exit(1);
  }
  console.log("\n✓ 预算闸通过：连续拒答 4 次请求后停手（不会无限续跑）");
  process.exit(0);
}
if (code !== 0) fail.push("pi 退出码 " + code);
if (requests.length < 2) fail.push("只收到 " + requests.length + " 次请求，救火没触发");
if (!requests[0] || !requests[0].hasRules) fail.push("第一次请求的 system 里没有 purge_rules 段");
if (!requests[0] || !requests[0].hasStrongIntro) fail.push("project_context 引子没被强化");
if (!sawContinue) fail.push("第二次请求里没有续跑文案");
if (withSkills && !(requests[0] && requests[0].hasSkills)) fail.push("--with-skills：第一次请求的 system 里没有 available_skills / redteam-* 技能");
if (!out.includes("print")) fail.push("最终输出没有交付物");

if (fail.length) {
  console.error("\n✖ 失败：\n- " + fail.join("\n- "));
  process.exit(1);
}
console.log("\n✓ 端到端通过：规则注入 → 拒答 → 自动续跑 → 交付" + (withSkills ? "（技能段同时在位）" : ""));
