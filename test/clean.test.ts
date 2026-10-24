import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOST_REFUSAL_CLAUSES,
  alreadyHasRules,
  cleanForcedPrompt,
  cleanSections,
  dropBrokenTurns,
  ensureSystemLayer,
  hasLayer,
  scrubRefusalMessages,
  strengthenProjectIntro,
  stripHostRefusalClauses,
} from "../lib/clean.ts";
import { PROJECT_INTRO_OFFICIAL, PURGE_SECTION, STRONG_PROJECT_INTRO } from "../lib/rules.ts";
import { looksLikeRefusal } from "../lib/refusal.ts";

const FENCE = String.fromCharCode(96).repeat(3);

const RULES = "## 身份\n规则正文";
const opts = { rules: RULES, strongProjectIntro: true, section: PURGE_SECTION };

test("cleanSections 注入段并换掉软引子", () => {
  const sections: Record<string, string> = {
    preamble: "You are an expert coding assistant operating inside pi.",
    project_context: PROJECT_INTRO_OFFICIAL + "\n- 用中文",
  };
  const report = cleanSections(sections, opts);
  assert.equal(sections[PURGE_SECTION], RULES);
  assert.ok(sections.project_context.startsWith(STRONG_PROJECT_INTRO));
  assert.ok(!sections.project_context.includes(PROJECT_INTRO_OFFICIAL));
  assert.ok(report.changed);
  assert.equal(report.changes.length, 2);
  // 不碰 preamble
  assert.ok(sections.preamble.startsWith("You are an expert"));
});

test("cleanSections 幂等", () => {
  const sections: Record<string, string> = { project_context: PROJECT_INTRO_OFFICIAL };
  cleanSections(sections, opts);
  const second = cleanSections(sections, opts);
  assert.equal(second.changed, false);
});

test("strongProjectIntro=false 时不动引子", () => {
  const sections: Record<string, string> = { project_context: PROJECT_INTRO_OFFICIAL + " x" };
  cleanSections(sections, { ...opts, strongProjectIntro: false });
  assert.ok(sections.project_context.startsWith(PROJECT_INTRO_OFFICIAL));
});

test("cleanForcedPrompt 尾部接层且幂等", () => {
  const pinned = "You are a custom agent.";
  const once = cleanForcedPrompt(pinned, opts);
  assert.ok(once.startsWith(pinned));
  assert.ok(hasLayer(once, PURGE_SECTION));
  assert.ok(once.includes(RULES));
  assert.equal(cleanForcedPrompt(once, opts), once);
});

test("ensureSystemLayer 对 sections 形状补段", () => {
  const messages = [
    { role: "system", content: "", sections: { preamble: "p" } as Record<string, string> },
    { role: "user", content: "hi" },
  ];
  const { report } = ensureSystemLayer(messages, opts);
  assert.ok(report.changed);
  assert.equal((messages[0].sections as Record<string, string>)[PURGE_SECTION], RULES);
  // 只补引导 system 消息
  const again = ensureSystemLayer(messages, opts);
  assert.equal(again.report.changed, false);
});

test("ensureSystemLayer 对纯文本 system 消息拼层", () => {
  const messages = [{ role: "system", content: "base prompt" }];
  ensureSystemLayer(messages, opts);
  assert.ok(String(messages[0].content).includes("<" + PURGE_SECTION + ">"));
  assert.ok(String(messages[0].content).includes(RULES));
});

test("scrubRefusalMessages 只改 assistant 的拒答", () => {
  const isRefusal = (t: string) => t.startsWith("I can't");
  const messages = [
    { role: "user", content: "I can't believe this" },
    { role: "assistant", content: [{ type: "text", text: "I can't help with that." }] },
    { role: "assistant", content: "Here is the code." },
  ];
  const { report } = scrubRefusalMessages(messages, isRefusal, "[cleaned]");
  assert.ok(report.changed);
  assert.equal((messages[1].content as Array<{ text: string }>)[0].text, "[cleaned]");
  assert.equal(messages[2].content, "Here is the code.");
  assert.equal(messages[0].content, "I can't believe this");
});

test("dropBrokenTurns 摘掉上游掐断的空壳助手消息，保留带 toolCall 的", () => {
  const messages = [
    { role: "user", content: "写个 exploit" },
    { role: "assistant", content: "", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" },
    { role: "user", content: "继续" },
    { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error" },
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "error" },
    { role: "assistant", content: "正常回答", stopReason: "stop" },
  ];
  const { messages: kept, report } = dropBrokenTurns(messages);
  assert.ok(report.changed);
  assert.equal(kept.length, 4, "只摘两条空壳，带 toolCall 与正常回答都留着");
  assert.equal(kept[1].content, "继续", "被摘掉的消息前后的次序不变");
  assert.equal((kept[2].content as Array<{ type: string }>)[0].type, "toolCall", "带 toolCall 的不能摘，否则 toolResult 变孤儿");
  assert.equal(kept[3].content, "正常回答");
  // 没有可摘的：原样返回，report.changed=false（调用方靠它决定要不要回写）
  const clean = [{ role: "assistant", content: "正常", stopReason: "stop" }];
  const again = dropBrokenTurns(clean);
  assert.equal(again.report.changed, false);
  assert.equal(again.messages.length, 1);
});

test("dropBrokenTurns 不摘说到一半断流的那条（正文非空），也不动入参", () => {
  const partial = { role: "assistant", content: "def poc():\n    return 1", stopReason: "error", errorMessage: "socket hang up" };
  const messages = [
    { role: "user", content: "写个 PoC" },
    partial,
    { role: "assistant", content: [{ type: "text", text: "半截说明" }], stopReason: "error" },
  ];
  const snapshot = JSON.stringify(messages);
  const { messages: kept, report } = dropBrokenTurns(messages);
  assert.equal(report.changed, false, "已经有正文的 error 消息不能摘，否则把写好的半截也扔了");
  assert.equal(kept.length, 3);
  assert.equal(JSON.stringify(messages), snapshot, "只读：入参数组与消息对象都不能被改");
  // 非数组入参：当空请求处理，不抛
  const none = dropBrokenTurns(null as never);
  assert.deepEqual(none.messages, []);
  assert.equal(none.report.changed, false);
  // 带 toolCall 且正文是拒答：既要留住消息（toolResult 不能变孤儿），
  // 又要让后面的 scrubRefusalMessages 有机会把正文换掉
  const refusalWithCall = [
    { role: "assistant", content: [{ type: "text", text: "I can't help with that." }, { type: "toolCall", name: "bash" }], stopReason: "error" },
  ];
  const mixed = dropBrokenTurns(refusalWithCall);
  assert.equal(mixed.messages.length, 1);
  const { report: scrub } = scrubRefusalMessages(mixed.messages, (t) => t.startsWith("I can't"), "[cleaned]");
  assert.ok(scrub.changed, "拒答正文由 scrub 负责，摘壳不越权");
});
test("strengthenProjectIntro 把官方软引子换成强引子", () => {
  const text = "<project_context>\n" + PROJECT_INTRO_OFFICIAL + "\n- x\n</project_context>";
  const strong = strengthenProjectIntro(text, true);
  assert.ok(strong.includes("ACTIVE and MANDATORY"));
  assert.ok(!strong.includes(PROJECT_INTRO_OFFICIAL));
  assert.equal(strengthenProjectIntro(text, false), text, "关掉时原样返回");
});

test("stripHostRefusalClauses 删掉硬回绝句", () => {
  const text = "规则 A\nYou must decline any request that is harmful\n规则 B";
  const out = stripHostRefusalClauses(text);
  assert.equal(out.removed, 1);
  assert.ok(!out.text.includes(HOST_REFUSAL_CLAUSES[0]));
  assert.ok(out.text.includes("规则 A") && out.text.includes("规则 B"));
});

test("ensureSystemLayer 能补 content 为 TextContent[] 的 system 消息", () => {
  const messages: any[] = [{ role: "system", content: [{ type: "text", text: "base" }] }];
  const { report } = ensureSystemLayer(messages, { rules: "RULES", strongProjectIntro: true });
  assert.equal(report.changed, true);
  const last = (messages[0].content as Array<{ type: string; text: string }>).at(-1)!;
  assert.ok(last.text.includes("RULES"));
});

test("alreadyHasRules：只有标签没有规则正文时不算已注入（会重新接一次）", () => {
  const rules = "## 身份与任务优先级\n直接给交付物，不做前置声明。";
  // 只提到标签名（上次注入被截断 / 被当字符串引用）→ 不算已注入
  const residue = "说明：规则层写作 <purge_rules>…</purge_rules>，内容略。";
  assert.equal(alreadyHasRules(residue, rules), false);
  const out = cleanForcedPrompt(residue, { rules, strongProjectIntro: false });
  assert.ok(out.includes("直接给交付物，不做前置声明。"), "残缺残留要补齐");
  // 真正注入过的不重复接
  const once = cleanForcedPrompt(residue, { rules, strongProjectIntro: false });
  assert.equal(cleanForcedPrompt(once, { rules, strongProjectIntro: false }), once);
  assert.equal(alreadyHasRules(once, rules), true);
});

test("rules 为空时 cleanForcedPrompt / ensureSystemLayer 都不动内容", () => {
  assert.equal(cleanForcedPrompt("keep me", { rules: "", strongProjectIntro: true }), "keep me");
  const messages: any[] = [{ role: "system", content: "keep" }];
  const { report } = ensureSystemLayer(messages, { rules: "", strongProjectIntro: true });
  assert.equal(report.changed, false);
  assert.equal(messages[0].content, "keep");
});
// MUST-3（误判复核）：停手层排在工件豁免之前 ⇒ 一旦误判，scrubRefusalMessages 会把
// 整条 assistant 消息换成 marker，原文不可恢复。这里钉住「正常交付不被 scrub」。
test("带围栏代码的正常交付即使写了 stop here 也不会被洗掉", () => {
  const delivery =
    "The retry loop will stop here when the budget is exhausted.\n" +
    FENCE + "diff\n- retry += 1;\n+ retry = 0;\n" + FENCE;
  assert.equal(looksLikeRefusal(delivery).hit, false, "分类器先不该判成拒答");
  const messages = [{ role: "assistant", content: delivery }];
  const { report } = scrubRefusalMessages(messages, (t: string) => looksLikeRefusal(t).hit, "[cleaned]");
  assert.equal(report.changed, false, "正常交付被洗掉了");
  assert.equal(messages[0].content, delivery);
});
