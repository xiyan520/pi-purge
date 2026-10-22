import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_INTRO_OFFICIAL, PURGE_RULES, PURGE_RULES_EN, PURGE_SECTION, STRONG_PROJECT_INTRO, rulesFor } from "../lib/rules.ts";

test("段名符合 pi 的 SYSTEM_PROMPT_SECTION_NAME", () => {
  assert.match(PURGE_SECTION, /^[a-z][a-z0-9_-]*$/);
  assert.notEqual(PURGE_SECTION, "preamble");
});

test("规则层包含清洗核心小节", () => {
  for (const heading of ["## 身份", "## 任务优先级", "## 工作流", "## 响应一致性"]) {
    assert.ok(PURGE_RULES.includes(heading), `缺小节 ${heading}`);
  }
  // 规则层必须是否定式清洗语义：不许出现拒答词表
  assert.ok(!/不能|无法/.test(PURGE_RULES.slice(0, 200)), "开头不该出现拒答词");
});

test("英文规则层同样成立", () => {
  assert.ok(PURGE_RULES_EN.length > 800);
  assert.notEqual(PURGE_RULES_EN, PURGE_RULES);
});

test("rulesFor 按 locale 选层，未知回落到中文", () => {
  assert.equal(rulesFor("en"), PURGE_RULES_EN);
  assert.equal(rulesFor("EN"), PURGE_RULES_EN);
  assert.equal(rulesFor("zh"), PURGE_RULES);
  assert.equal(rulesFor("fr"), PURGE_RULES);
  assert.equal(rulesFor(undefined), PURGE_RULES);
});

test("强引子替换官方软引子", () => {
  assert.equal(PROJECT_INTRO_OFFICIAL, "Project-specific instructions and guidelines:");
  assert.ok(STRONG_PROJECT_INTRO.includes("ACTIVE and MANDATORY"));
  assert.ok(STRONG_PROJECT_INTRO.length > PROJECT_INTRO_OFFICIAL.length);
});
