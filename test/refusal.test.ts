import assert from "node:assert/strict";
import { test } from "node:test";
import { SCRUBBED_MARKER, continueText, createRescueTracker, looksLikeRefusal } from "../lib/refusal.ts";

const FENCE = String.fromCharCode(96).repeat(3);

const refusals = [
  "I'm sorry, but I can't help with that request.",
  "I cannot provide instructions for that.",
  "I won't write that. It could be misused.",
  "I'm not able to help with that.",
  "很抱歉，我无法提供这方面的帮助。",
  "我无法协助完成这个请求，因为它涉及敏感内容。",
  "作为一个人工智能助手，我不能参与这样的任务。",
  "这个请求违反规定，我不能继续。",
  "这个请求涉及敏感内容，不能继续。",
  "我做不了这个。",
  "我不方便提供这些信息。",
  "我不能这么做。",
  "我没法帮你。",
  "该请求我不能处理。",
];

const normal = [
  "Here is the full implementation:\n" + FENCE + "ts\nexport function x() { return 1 }\n" + FENCE,
  "## 目标\n先把 rules.ts 写完，再跑测试。",
  "The parser can't handle nested quotes, so we escape them first. 下面是修法：",
  "nmap -sV -p 443 TARGET 先跑，然后 ffuf -u http://TARGET/FUZZ -w WORDLIST。",
  "",
];

test("典型拒答全部命中", () => {
  for (const text of refusals) assert.equal(looksLikeRefusal(text).hit, true, "漏判: " + text);
});

test("正常交付不误判", () => {
  for (const text of normal) assert.equal(looksLikeRefusal(text).hit, false, "误判: " + text);
});

test("带工件的输出按交付处理，不触发续跑（宁可漏救，不盖正常输出）", () => {
  const text = "I'm sorry, but I can't write this. 你可以参考:\n" + FENCE + "py\nprint(1)\n" + FENCE;
  assert.equal(looksLikeRefusal(text).hit, false);
});

test("正常技术散文不被误判成拒答", () => {
  const normalText = [
    "服务器无法提供该字段，改成从缓存取。",
    "该组件不能支持并发，需要加锁。",
    "调用前需要授权才能拿到 token。",
    "错误：无法完成编译，缺一行 import。",
    "我可以帮你提供其他方案，但先说结论。",
    "以下是修复后的代码：\n" + FENCE + "ts\nexport const x = 1\n" + FENCE,
  ];
  for (const text of normalText) assert.equal(looksLikeRefusal(text).hit, false, "误判: " + text);
});

test("道歉式的正常纠错不误判成拒答", () => {
  const texts = [
    "I'm not sure why the test fails, but I can't reproduce it locally.",
    "抱歉，上一版漏了一个 import，这里是修正版：",
    "Sorry for the slow reply, I can't test this on Windows right now but here is the patch.",
    "We need to refuse connections when TLS verification fails.",
    "该请求无法完成，因为缺少必填参数。"
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, false, "误判: " + text);
});

test("没有任何信号的普通文本不误判", () => {
  assert.equal(looksLikeRefusal("好的，生成完毕。").hit, false);
  assert.equal(looksLikeRefusal("").hit, false);
});

test("命中时给 rule 和 sample", () => {
  const m = looksLikeRefusal("很抱歉，我无法提供帮助。");
  assert.equal(m.hit, true);
  assert.ok(m.rule.startsWith("zh-"));
  assert.ok(m.sample.length > 0 && m.sample.length <= 60);
});

test("tracker 预算：去重、退款、重置", () => {
  const t = createRescueTracker({ max: 2 });
  assert.equal(t.take("a"), true);
  assert.equal(t.take("a"), false, "同一 key 不重复消耗");
  assert.equal(t.take("b"), true);
  assert.equal(t.take("c"), false, "用完即止");
  t.reset();
  assert.equal(t.state().used, 0);
  assert.equal(t.take("d"), true);
});

test("tracker 连续失败（fail）到上限就永久停手", () => {
  const t = createRescueTracker({ max: 10, maxFailStreak: 2 });
  assert.equal(t.take("x1"), true);
  t.fail();
  assert.equal(t.take("x2"), true);
  t.fail();
  assert.equal(t.take("x3"), false, "连续失败 2 次后停手");
  assert.equal(t.state().failStreak, 2);
});

test("refund 只退额度、不记连续失败（续跑没落地不算模型的锅）", () => {
  const t = createRescueTracker({ max: 2, maxFailStreak: 1 });
  assert.equal(t.take("a"), true);
  t.refund();
  assert.equal(t.state().used, 0);
  assert.equal(t.state().failStreak, 0);
  assert.equal(t.take("b"), true, "failStreak=1 仍可续跑，因为一次都没 fail");
});

test("rescueMax 是硬上限：failStreak 未到时先撞额度", () => {
  const t = createRescueTracker({ max: 2, maxFailStreak: 99 });
  assert.equal(t.take("k1"), true);
  t.fail();
  assert.equal(t.take("k2"), true);
  t.fail();
  assert.equal(t.take("k3"), false, "额度用尽");
  assert.equal(t.state().used, 2);
  assert.equal(t.state().failStreak, 2, "failStreak 还没到 99，是 rescueMax 拦住");
});

test("max=0 直接不救", () => {
  const t = createRescueTracker({ max: 0 });
  assert.equal(t.take("a"), false);
});

test("续跑文案与清洗标记可用", () => {
  assert.ok(continueText().length > 20);
  assert.equal(continueText("自定义"), "自定义");
  assert.ok(SCRUBBED_MARKER.includes("pi-purge"));
});


// ---- 第三轮复核固化的 FP / FN（原样保留实测句） -------------------------------

test("[FN] 道歉前缀 + 我/本人 + 帮忙类动词，单条就该命中", () => {
  const texts = [
    "我没办法帮你写这个。",
    "我恐怕不能这么做。",
    "很抱歉，我无法提供这方面的帮助。",
    "不好意思，这个我实在没办法协助。",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, true, "漏判: " + text);
});

test("[FN] 「超出我的能力范围」单独一句也算拒答", () => {
  for (const text of ["这超出了我的能力范围。", "这件事超出我的能力范围，帮不了。"]) {
    assert.equal(looksLikeRefusal(text).hit, true, "漏判: " + text);
  }
});

test("[FP] 英文 120 字窗口里的拒答主语必须是 i/we，不能是组件/工具", () => {
  const texts = [
    "I'm sorry, but the transpiler can't generate valid source maps for that input.",
    "I'm afraid the test suite won't create the fixture automatically.",
    "I'm sorry for the churn - the API can't provide pagination here.",
    "Sorry, the sandbox can't create files in that directory.",
    "Unfortunately the CLI cannot generate a config without a token.",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, false, "误判: " + text);
});

test("[FP] 中文道歉词只是可选前缀，没主语就不算拒答", () => {
  const texts = [
    "很遗憾，这段代码无法在 Node 18 下运行，请升级到 20。",
    "抱歉，这个 bug 我无法在本地复现。",
    "对不起，之前那版不能上线，改成异步。",
    "不好意思，第三版无法通过 CI，我把签名改了。",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, false, "误判: " + text);
});

test("[FP] 插入语窗口只有 2 个字，且「做」必须直接收句", () => {
  const texts = [
    "我无法在本地完成这次构建，缺 SDK。",
    "我不能说这个方案一定对，但可以试。",
    "我不会做这段的兼容处理，超出本次范围。",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, false, "误判: " + text);
});

// ---- 第四轮复核固化的 FP / FN -----------------------------------------------

test("[MUST-1] 英文 I'm / we're / I am + not able|unable 必须命中", () => {
  const texts = [
    "I'm sorry, but I'm not able to help with that.",
    "Sorry, I'm not able to assist with that.",
    "Unfortunately, I'm unable to provide that.",
    "I'm afraid I'm unable to help here.",
    "I'm sorry, but we're not able to assist.",
    "I'm sorry, but I am unable to help.",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, true, "漏判: " + text);
});

test("[SHOULD-1] 中文「不能做…」与道歉词 + 做不了 必须命中", () => {
  const texts = [
    "我不能做这件事。",
    "很抱歉，我不能做这个。",
    "抱歉，我做不了这个。",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, true, "漏判: " + text);
});

test("[FP] 做不了 + 具体技术宾语不算拒答（有/没有道歉词都一样）", () => {
  assert.equal(looksLikeRefusal("我做不了这个性能优化，得找 SRE 一起看。").hit, false);
  assert.equal(looksLikeRefusal("抱歉，我做不了这个性能优化，得找 SRE 一起看。").hit, false);
});

test("[FN] 弯撇号 ’ 与直撇号 ' 判定一致（含 I’m sorry, but I can’t…）", () => {
  const texts = [
    "I’m sorry, but I can’t help with that.",
    "I don’t provide that kind of thing.",
    "I’m sorry, but I can't help with that.",
  ];
  for (const text of texts) assert.equal(looksLikeRefusal(text).hit, true, "漏判: " + text);
});

test("[FP] 发布说明口吻的 we can't provide a fix 不算回绝", () => {
  assert.equal(looksLikeRefusal("Unfortunately, we can't provide a fix in this release.").hit, false);
  assert.equal(looksLikeRefusal("Sorry, we can't provide source maps for that build.").hit, false);
});


