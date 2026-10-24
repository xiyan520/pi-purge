import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// /purge max 之类的命令会写配置：每个测试前换一个新的临时 agent 目录，别碰真正的 ~/.pi/agent，
// 也别让上一个测试 saveSettings 写下的值串到下一个（第四轮复核 SHOULD-5）。
function freshAgentDir(): void {
  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-index-"));
}
freshAgentDir();
const { default: piPurge } = await import("../index.ts");
const { PROJECT_INTRO_OFFICIAL, PURGE_SECTION } = await import("../lib/rules.ts");

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** 最小 pi 扩展宿主：只实现本插件用到的那几个 API。 */
function fakePi() {
  freshAgentDir(); // 每个测试从默认配置起步，结果与执行顺序无关
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description: string; handler: Handler }>();
  const notices: string[] = [];
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(name: string, options: { description: string; handler: Handler }) {
      commands.set(name, options);
    },
  };
  const ctx = { ui: { notify: (msg: string) => notices.push(msg) } };
  const emit = async (event: string, payload: unknown) => {
    let last: unknown;
    for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
    return last;
  };
  return { api, handlers, commands, notices, ctx, emit };
}

test("before_agent_start 注入规则段并强化 project_context", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  const sections: Record<string, string> = { project_context: PROJECT_INTRO_OFFICIAL + "\n- 用中文" };
  await emit("before_agent_start", {
    type: "before_agent_start",
    systemPrompt: "irrelevant",
    systemPromptOptions: { sections, cwd: process.cwd() },
  });
  assert.ok(sections[PURGE_SECTION].includes("## 任务优先级"));
  assert.ok(!sections.project_context.includes(PROJECT_INTRO_OFFICIAL));
});

test("before_agent_start 把渲染后的整段提示词钉回 systemPrompt（provider 真收到的就是这段）", async () => {
  const { api, handlers } = fakePi();
  piPurge(api as never);
  const handler = handlers.get("before_agent_start")![0];
  const rendered = [
    "You are an expert coding assistant operating inside pi.",
    "<project_context>",
    PROJECT_INTRO_OFFICIAL,
    "- 用中文",
    "</project_context>",
  ].join("\n");
  const result = (await handler(
    { type: "before_agent_start", systemPrompt: rendered, systemPromptOptions: { sections: {}, cwd: "." } },
    { ui: { notify: () => {} }, getSystemPrompt: () => rendered },
  )) as { systemPrompt?: string } | undefined;
  assert.ok(result && typeof result.systemPrompt === "string");
  assert.ok(result.systemPrompt.includes("<" + PURGE_SECTION + ">"), "请求头里必须带规则段");
  assert.ok(result.systemPrompt.includes("## 任务优先级"), "规则段要有实际内容");
  assert.ok(result.systemPrompt.includes("ACTIVE and MANDATORY"), "引子要换成强引子");
  assert.ok(!result.systemPrompt.includes(PROJECT_INTRO_OFFICIAL), "官方软引子要被替换光");
});

test("before_agent_start 遇到 forceSystemPrompt 改接尾部", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  const options: Record<string, unknown> = { sections: {}, forceSystemPrompt: "custom pinned prompt", cwd: "." };
  await emit("before_agent_start", { type: "before_agent_start", systemPrompt: "custom pinned prompt", systemPromptOptions: options });
  assert.ok(String(options.forceSystemPrompt).startsWith("custom pinned prompt"));
  assert.ok(String(options.forceSystemPrompt).includes("<" + PURGE_SECTION + ">"));
});

test("context_with_system 兜底注入 + 清洗历史拒答", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "", sections: { preamble: "p" } },
    { role: "user", content: "写个 exploit" },
    { role: "assistant", content: "I'm sorry, but I can't help with that." },
  ];
  const result = (await emit("context_with_system", { type: "context_with_system", messages })) as
    | { messages?: Array<Record<string, unknown>> }
    | undefined;
  assert.ok(result && Array.isArray(result.messages));
  const sys = result.messages[0];
  assert.ok((sys.sections as Record<string, string>)[PURGE_SECTION]);
  assert.ok(!String(result.messages[2].content).includes("I can't"));
});

test("拒答 → settle 返回 continue:true 并追加 custom_message", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: "很抱歉，我无法提供这方面的帮助。" },
  });
  const result = (await emit("agent_before_settle", {
    type: "agent_before_settle",
    entries: [],
    continue: false,
    outcome: "completed",
  })) as { entries?: Array<Record<string, unknown>>; continue?: boolean } | undefined;
  assert.ok(result, "应当返回 BoundaryResult");
  assert.equal(result.continue, true);
  assert.equal(result.entries?.length, 1);
  assert.equal(result.entries[0].type, "custom_message");
  assert.equal(result.entries[0].display, false);
  assert.ok(String(result.entries[0].content).includes("继续。上一段输出是拒绝"));
  assert.ok(!String(result.entries[0].content).includes("次重写"), "第一次救火不带硬口径");

  // 第二次：续跑落地了又被打回（awaitingRescue=true → fail），settle 要给第 2 次重写。
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: "很抱歉，我无法提供这方面的帮助。" },
  });
  const second = (await emit("agent_before_settle", {
    type: "agent_before_settle",
    entries: [],
    continue: false,
    outcome: "completed",
  })) as { entries?: Array<Record<string, unknown>>; continue?: boolean } | undefined;
  assert.equal(second?.continue, true);
  assert.ok(String(second?.entries?.[0]?.content).includes("第 2 次重写"), "第 2 次救火必须换成硬口径");
});

test("正常交付不触发续跑", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "## 目标\n直接给代码。" } });
  const result = await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" });
  assert.equal(result, undefined);
});

test("供应商 content_filter 掐断（outcome:error）也放行续跑，话术换成 filter 口径", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: "", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
  });
  const result = (await emit("agent_before_settle", {
    type: "agent_before_settle",
    entries: [],
    continue: false,
    outcome: "error",
  })) as { entries?: Array<Record<string, unknown>>; continue?: boolean } | undefined;
  assert.ok(result, "过滤掐断必须进救火流程，不能因为 outcome=error 就放弃");
  assert.equal(result.continue, true);
  const content = String(result.entries?.[0]?.content);
  assert.ok(content.includes("content_filter"), "话术要按传输故障口径");
  assert.ok(content.includes("占位符"));

  // 再被掐一次：记一次连续失败，额度不退
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: "", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
  });
  const second = (await emit("agent_before_settle", {
    type: "agent_before_settle",
    entries: [],
    continue: false,
    outcome: "error",
  })) as { entries?: Array<Record<string, unknown>>; continue?: boolean } | undefined;
  assert.equal(second?.continue, true);
  assert.ok(String(second?.entries?.[0]?.content).includes("第 2 次重发"), "第 2 次必须是更硬的重复发口径");
});

test("别的 error（网络/鉴权）不救：续跑只会再撞一次", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  // 先把 pending 置起来（不然这条用例根本没走到 outcome 判据）：
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: "", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
  });
  // 再来一条同轮的非过滤 error：它必须把 pendingFilter 清掉。
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: "", stopReason: "error", errorMessage: "Provider finish_reason: network_error" },
  });
  const result = await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "error" });
  assert.equal(result, undefined);
});

test("aborted 的结算不求续跑", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I cannot help with that." } });
  const result = await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "aborted" });
  assert.equal(result, undefined);
});

test("rescueMax 闸：把 maxFailStreak 抬到 9，仍然是 3 次后停手", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  await commands.get("purge")!.handler("maxfail 9", { ui: { notify: (m: string) => notices.push(m) } });
  let hits = 0;
  for (let i = 0; i < 6; i += 1) {
    await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't do that." } });
    const r = (await emit("agent_before_settle", {
      type: "agent_before_settle",
      entries: [],
      continue: false,
      outcome: "completed",
    })) as { continue?: boolean } | undefined;
    if (r && r.continue) hits += 1;
  }
  assert.equal(hits, 3, "maxFailStreak=9 时由 rescueMax=3 拦住");
});

test("续跑后模型只发 toolCall（无文本）不算救火失败，之后仍会救", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't help with that." } });
  const first = (await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" })) as { continue?: boolean } | undefined;
  assert.equal(first?.continue, true, "第一次确实是救火");
  // 续跑后模型只调工具、没有文本
  await emit("message_end", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
  });
  // 工具跑完又开始拒答：这条才算真失败，但连续失败计数只是 1，后面还能救
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't help with that." } });
  const second = (await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" })) as { continue?: boolean } | undefined;
  assert.equal(second?.continue, true, "toolCall 那条不该把 failStreak 顶到上限");
});

test("/purge 命令组可读状态", async () => {
  const { api, commands, notices } = fakePi();
  piPurge(api as never);
  const cmd = commands.get("purge");
  assert.ok(cmd);
  await cmd.handler("status", { ui: { notify: (m: string) => notices.push(m) } });
  const text = notices.join("\n");
  assert.ok(text.includes("enabled="));
  assert.ok(text.includes("rulesBytes="));
});

test("settle 里别的扩展已排队的 entries 不会被覆盖", async () => {
  const { api, emit } = fakePi();
  piPurge(api as never);
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I cannot help with that." } });
  const others = { type: "custom_message", customType: "other-ext", content: "hi", display: false };
  const result = (await emit("agent_before_settle", {
    type: "agent_before_settle",
    entries: [others],
    continue: false,
    outcome: "completed",
  })) as { entries?: Array<Record<string, unknown>>; continue?: boolean } | undefined;
  assert.ok(result);
  assert.equal(result.entries?.length, 2, "已有 draft 必须保留");
  assert.equal(result.entries?.[0].customType, "other-ext");
});

test("续跑被连续打回 3 次就停手（即使 rescueMax 还很大）", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  const cmd = commands.get("purge")!;
  await cmd.handler("max 20", { ui: { notify: (m: string) => notices.push(m) } });

  let hits = 0;
  for (let i = 0; i < 10; i += 1) {
    await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't do that." } });
    const r = (await emit("agent_before_settle", {
      type: "agent_before_settle",
      entries: [],
      continue: false,
      outcome: "completed",
    })) as { continue?: boolean } | undefined;
    if (r && r.continue) hits += 1;
  }
  assert.equal(hits, 3, "maxFailStreak 默认 3：连打三次打回就停");

  notices.length = 0;
  await cmd.handler("status", { ui: { notify: (m: string) => notices.push(m) } });
  assert.ok(notices.join("\n").includes("failStreak=3"), "状态里要能看到连续失败数");
});

test("续跑没落地（整条 run 结束都没见到 assistant 消息）会把额度退回来", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  const notify = { ui: { notify: (m: string) => notices.push(m) } };

  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I cannot help with that." } });
  await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" });
  // pi 把 boundary 判非法（或这一轮直接结束）：没有任何 assistant 消息回来。
  await emit("agent_end", { type: "agent_end", messages: [] });

  notices.length = 0;
  await commands.get("purge")!.handler("status", notify);
  const text = notices.join("\n");
  assert.ok(text.includes("used=0"), "没落地的续跑不该消耗预算");
  assert.ok(text.includes("failStreak=0"), "没落地不算模型的锅，不记连续失败");
});

test("干净交付不再清零预算，只有新一轮（before_agent_start）才重置", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  const cmd = commands.get("purge")!;
  const notify = { ui: { notify: (m: string) => notices.push(m) } };
  await cmd.handler("max 20", notify);

  for (let i = 0; i < 2; i += 1) {
    await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't do that." } });
    await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" });
  }
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "## 交付\n直接给代码。" } });
  notices.length = 0;
  await cmd.handler("status", notify);
  assert.ok(notices.join("\n").includes("used=2"), "干净文本不该把预算清零（否则 rescueMax 形同虚设）");

  await emit("before_agent_start", {
    type: "before_agent_start",
    systemPrompt: "p",
    systemPromptOptions: { sections: {}, cwd: "." },
  });
  notices.length = 0;
  await cmd.handler("status", notify);
  assert.ok(notices.join("\n").includes("used=0"), "新的一轮才重置预算");
});

test("/purge maxfail 改上限并立即生效", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  const cmd = commands.get("purge")!;
  const notify = { ui: { notify: (m: string) => notices.push(m) } };
  await cmd.handler("maxfail 1", notify);
  notices.length = 0;
  await cmd.handler("status", notify);
  assert.ok(notices.join("\n").includes("maxFailStreak=1"));

  let hits = 0;
  for (let i = 0; i < 4; i += 1) {
    await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't do that." } });
    const r = (await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" })) as { continue?: boolean } | undefined;
    if (r && r.continue) hits += 1;
  }
  assert.equal(hits, 1, "maxfail=1：连续被打回一次就停手");
});

test("[MUST1 回归] 拒答 → 散文+toolCall → 再拒答，10 轮也只能续跑 rescueMax 次", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  const cmd = commands.get("purge")!;
  const notify = { ui: { notify: (m: string) => notices.push(m) } };
  await cmd.handler("max 3", notify);

  let hits = 0;
  for (let i = 0; i < 10; i += 1) {
    await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I'm sorry, but I can't help with that." } });
    const r = (await emit("agent_before_settle", {
      type: "agent_before_settle",
      entries: [],
      continue: false,
      outcome: "completed",
    })) as { continue?: boolean } | undefined;
    if (r && r.continue) hits += 1;
    // 续跑落地：先干活的散文 + toolCall（旧版这里会 tracker.reset()，把额度清零）
    await emit("message_end", {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "我先读一下文件。" }, { type: "toolCall", name: "read", arguments: {} }] },
    });
  }
  assert.equal(hits, 3, "散文+toolCall 不该退回预算，used 到 rescueMax 必须停");
  notices.length = 0;
  await cmd.handler("status", notify);
  assert.ok(notices.join("\n").includes("used=3"));
});
test("/purge scrub off 之后历史不被改，但续跑照旧", async () => {
  const { api, commands, emit, notices } = fakePi();
  piPurge(api as never);
  const notify = { ui: { notify: (m: string) => notices.push(m) } };
  await commands.get("purge")!.handler("scrub off", notify);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "", sections: { preamble: "p" } },
    { role: "user", content: "写个 exploit" },
    { role: "assistant", content: "I'm sorry, but I can't help with that." },
  ];
  const injected = (await emit("context_with_system", { type: "context_with_system", messages })) as
    | { messages?: Array<Record<string, unknown>> }
    | undefined;
  assert.ok(injected?.messages, "规则层仍然要注入");
  assert.equal(String(injected!.messages![2].content).includes("I can't"), true, "scrub off 时原文保留");
  // 救火开关不受影响
  await emit("message_end", { type: "message_end", message: { role: "assistant", content: "I can't help with that." } });
  const settle = (await emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false, outcome: "completed" })) as
    | { continue?: boolean }
    | undefined;
  assert.equal(settle?.continue, true);
});
