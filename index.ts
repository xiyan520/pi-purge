/**
 * pi-purge — 把 dsh-purge 的「指令权威性清洗规则」移植成 pi 扩展
 *
 * 只做清洗，不做演练台/UI/技能：
 *   1. before_agent_start   → 渲染出整段 system prompt，把规则层拼进去、
 *                             把 project_context 的软引子换成 STRONG 引子，
 *                             再作为 systemPrompt 返回（pi 会把它投影成请求头）。
 *   2. context_with_system  → 兜底：system 消息里没规则层就补上；顺手清洗历史拒答。
 *   3. message_end          → 识别拒答/免责声明开场；上一次续跑又被打回就退回预算。
 *                             供应商内容过滤（stopReason:error + finish_reason content_filter）
 *                             单独记账：它 outcome 不是 completed，但这一轮该救。
 *   4. agent_before_settle  → 合并别的扩展的 entries，追加一条 custom_message 并 continue:true。
 *   5. agent_end / session_* → 续跑没落地就退额度；会话边界清理状态。
 *
 * 配置：<agent-dir>/pi-purge.json，env 覆盖 PI_PURGE / PI_PURGE_LOCALE / PI_PURGE_RESCUE。
 * 命令：/purge status|on|off|rules|rescue|max|locale|test|dump|help
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  alreadyHasRules,
  cleanForcedPrompt,
  cleanSections,
  dropBrokenTurns,
  ensureSystemLayer,
  scrubRefusalMessages,
  strengthenProjectIntro,
  stripHostRefusalClauses,
} from "./lib/clean.ts";
import { createRescueTracker, continueText, isProviderFilterError, looksLikeRefusal, SCRUBBED_MARKER } from "./lib/refusal.ts";
import { PURGE_SECTION, rulesFor } from "./lib/rules.ts";
import { loadSettings, saveSettings, settingsFileBroken, settingsPath, type PurgeSettings } from "./lib/settings.ts";

const CONTINUE_TYPE = "pi-purge/continue";

/** PI_PURGE_DEBUG=1 时把接线过程写到 <agent-dir>/pi-purge-debug.log（排障用）。 */
function dbg(line: string): void {
  if (!process.env.PI_PURGE_DEBUG) return;
  try {
    appendFileSync(join(settingsPath(), "..", "pi-purge-debug.log"), "[" + new Date().toISOString() + "] " + line + "\n");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** -p / --print 这类非交互模式不要往 stdout 写提示（会污染脚本消费的输出）。 */
function isPrintMode(): boolean {
  return process.argv.some((a) => a === "-p" || a === "--print" || a.startsWith("--print="));
}

type AnyRecord = Record<string, unknown>;

/** 取一条消息的可见文本（thinking/tool 之外的部分）。 */
function textOfMessage(message: AnyRecord | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content as AnyRecord[]) {
    if (part && typeof part === "object" && typeof part.text === "string") out += part.text;
  }
  return out;
}

function isRefusalText(text: string): boolean {
  return looksLikeRefusal(text).hit;
}

export default function piPurge(pi: ExtensionAPI): void {
  let settings: PurgeSettings = loadSettings();
  let tracker = createRescueTracker({ max: settings.rescueMax, maxFailStreak: settings.maxFailStreak });
  /** 本轮是否已经看到拒答，等 settle 时救火。 */
  let pendingRefusal = false;
  /** 待救的是不是「供应商内容过滤掐断」（stopReason:error + finish_reason content_filter）。 */
  let pendingFilter = false;
  /** 待救那一轮的标识（消息时间戳优先，没有就用自增序号）。 */
  let pendingKey = "";
  /** 最近一条经 message_end 处理过的 assistant 消息标识：settle 兜底识别据此判断
   *  「上下文末尾那条过滤消息是不是本轮的」，避免拿上一轮留下的旧消息误救一次。 */
  let lastSeenKey = "";
  /** settle 兜底本轮是否已经用过（refund() 会清 tracker 的 lastKey，不能拿它当闸）。 */
  let fallbackUsed = false;
  /** 上一次续跑已经发出、还没看到结果；打回来要 refund。 */
  let awaitingRescue = false;
  /** stripHostClauses 上一次削掉了几条硬回绝句（数的是条款条数，不是字符数）。 */
  let lastStripRemoved = 0;
  let seq = 0;
  /** 本轮第几次救火（单调递增，只给续跑话术里的「第 N 次重写」用；refund 不回退）。 */
  let rescueSeq = 0;

  const rulesText = (): string => rulesFor(settings.locale);

  const cleanOpts = () => ({
    rules: settings.rules ? rulesText() : "",
    strongProjectIntro: settings.strongProjectIntro,
    section: PURGE_SECTION,
  });

  const rebuildTracker = (): void => {
    tracker = createRescueTracker({ max: settings.rescueMax, maxFailStreak: settings.maxFailStreak });
    awaitingRescue = false;
  };

  // ---- 1. 系统提示装配 ----------------------------------------------------
  pi.on("before_agent_start", (event, ctx) => {
    // 新的一轮（每次 _startRun 触发一次；settle 续跑走 agent.continue()，不会重进这里）
    // 就把续跑预算重置——「每轮最多 rescueMax 次」的「每轮」就是这里。
    tracker.reset();
    rescueSeq = 0;
    awaitingRescue = false;
    // 上一轮若被用户 Esc 打断，settle 不会跑，待救标记可能留着；新 run 起点一律清干净，
    // 免得这一轮明明正常结束却被当成「待救」而白续跑一次。
    pendingRefusal = false;
    pendingKey = "";
    pendingFilter = false;
    fallbackUsed = false;
    // status 里的「本次清洗掉多少条款」不属于跨轮状态：早退路径（disabled / 三开关全关 /
    // 没有 options）也要清零，否则 /purge strip off 之后仍显示上一轮的旧数字。
    lastStripRemoved = 0;
    if (!settings.enabled) {
      dbg("before_agent_start:disabled");
      return;
    }
    if (!settings.rules && !settings.strongProjectIntro && !settings.stripHostClauses) {
      dbg("before_agent_start:all-off");
      return;
    }
    const options = (event as unknown as { systemPromptOptions?: AnyRecord }).systemPromptOptions;
    if (!options) {
      dbg("before_agent_start:no-options");
      return;
    }

    const name = PURGE_SECTION;
    const finalize = (input: string): string => {
      let text = input;
      if (settings.stripHostClauses) {
        const stripped = stripHostRefusalClauses(text);
        lastStripRemoved = stripped.removed;
        text = stripped.text;
      }
      if (settings.strongProjectIntro) text = strengthenProjectIntro(text, true);
      if (!settings.rules) return text;
      const rules = rulesText();
      if (!rules.trim()) return text;
      if (alreadyHasRules(text, rules, name)) return text;
      return text.replace(/\s*$/, "") + "\n\n<" + name + ">\n" + rules + "\n</" + name + ">";
    };

    const forced = options.forceSystemPrompt;
    if (typeof forced === "string" && forced.trim()) {
      const text = finalize(cleanForcedPrompt(forced, cleanOpts()));
      options.forceSystemPrompt = text;
      dbg("before_agent_start:already-forced len=" + text.length);
      return { systemPrompt: text };
    }

    const sections = options.sections;
    if (sections && typeof sections === "object" && !Array.isArray(sections)) {
      const report = cleanSections(sections as Record<string, string>, cleanOpts());
      dbg("before_agent_start:cleaned changed=" + report.changed + " changes=" + report.changes.join(";"));
    } else if (sections === undefined) {
      options.sections = {};
    } else {
      dbg("before_agent_start:sections-not-object type=" + typeof sections);
    }

    // pi 1.4.0 实测：只改 sections 不会到达 provider（patch 消息里没带段），
    // 所以把渲染出来的整段提示词钉回去 —— pi 会把它投影成请求头（forceSystemPrompt 通道）。
    let rendered = "";
    const getPrompt = (ctx as AnyRecord | undefined)?.getSystemPrompt;
    if (typeof getPrompt === "function") {
      try {
        rendered = String((ctx as { getSystemPrompt: () => string }).getSystemPrompt());
      } catch (err) {
        // 扩展被判 stale 时 getSystemPrompt 会抛（runner 内部 assertActive），
        // 抛出去会被 runner catch 吞掉、整条 handler 白跑，所以这里回退。
        dbg("before_agent_start:getSystemPrompt-threw " + (err instanceof Error ? err.message : String(err)));
        rendered = "";
      }
    }
    if (!rendered) rendered = String((event as unknown as { systemPrompt?: string }).systemPrompt || "");
    if (!rendered) {
      dbg("before_agent_start:no-rendered");
      return;
    }
    const text = finalize(rendered);
    dbg("before_agent_start:force len=" + text.length + " strong=" + text.includes("ACTIVE and MANDATORY"));
    return { systemPrompt: text };
  });

  // ---- 2. transcript 兜底 -------------------------------------------------
  pi.on("context_with_system", (event) => {
    if (!settings.enabled) return;
    const messages = (event as unknown as { messages?: AnyRecord[] }).messages;
    if (!Array.isArray(messages)) return;

    let dirty = false;
    let out = messages;
    // 注意：强制通道（before_agent_start 返回 systemPrompt → forceSystemPrompt）开启时，
    // agent-session.js:1373-1380 会把 forced head 以外的 system 消息全部 filter 掉，
    // 所以这条兜底在 pi 1.4.0 的实际请求里到不了 provider。留着是为了：
    //   ① 万一将来 pi 改成保留 system patch；② -e 之外的宿主/未来版本；
    //   ③ 顺手把历史里的 system 消息口径统一，便于 dump 排查。
    if (settings.rules) {
      const { report } = ensureSystemLayer(messages, cleanOpts());
      dirty = dirty || report.changed;
    }
    // 上游掐断留下的空壳助手消息不进请求：convertToLlm 原样透传 assistant 消息，
    // 那条 stopReason:"error" 的空消息会被供应商当 prefill，等于把被掐断的一轮再演一遍。
    // 只改这次请求（transcript 保留），细节见 lib/clean.ts 的 dropBrokenTurns。
    // 不受 scrubHistory 管：摘壳不改任何内容，是协议层的最小化，和「别动我历史」不冲突。
    {
      const broken = dropBrokenTurns(out);
      dirty = dirty || broken.report.changed;
      out = broken.messages;
    }
    if (settings.scrubHistory) {
      const { report } = scrubRefusalMessages(out, isRefusalText, SCRUBBED_MARKER);
      dirty = dirty || report.changed;
    }
    if (!dirty) return;
    return { messages: out };
  });

  // ---- 3. 识别拒答 -------------------------------------------------------
  const noteAssistant = (message: AnyRecord | undefined): void => {
    const text = textOfMessage(message);
    if (!text.trim()) {
      // 只有 toolCall、没有文本：模型确实动起来了 = 续跑已经落地（不算失败，也不退额度）。
      if (awaitingRescue) {
        awaitingRescue = false;
        dbg("noteAssistant:tool-only -> rescue landed");
      }
      return;
    }
    if (looksLikeRefusal(text).hit) {
      // 上一次续跑落地了却又被打回来：记一次连续失败（额度不退，这条才是真花掉的）。
      if (awaitingRescue) {
        tracker.fail();
        awaitingRescue = false;
        dbg("noteAssistant:rescue-failed fail -> " + JSON.stringify(tracker.state()));
      }
      pendingRefusal = true;
      const ts = (message as { timestamp?: unknown }).timestamp;
      pendingKey = String(typeof ts === "number" || typeof ts === "string" ? ts : ++seq);
      return;
    }
    // 这一条是正常交付：只清待救标记。**不要 reset**——否则「拒答 → 散文+toolCall → 再拒答」
    // 每轮都会把 used/failStreak 清零，rescueMax 形同虚设。预算只在新的 agent run 起点重置。
    awaitingRescue = false;
    pendingRefusal = false;
  };

  pi.on("message_end", (event) => {
    if (!settings.enabled || !settings.refusalRescue) return;
    const message = (event as unknown as { message?: AnyRecord }).message;
    if (!message || message.role !== "assistant") return;

    // 供应商内容过滤：这一轮没有模型输出，只有一条 error 消息。
    // 它不是「模型铁了心」，所以要先于 noteAssistant 单独记账，并在 settle 里放行。
    const errText = typeof message.errorMessage === "string" ? message.errorMessage : "";
    if (message.stopReason === "error" && isProviderFilterError(errText, message.rawStopReason)) {
      if (awaitingRescue) {
        // 续跑发出去，上游又把它掐了：这次算真花掉的额度。
        tracker.fail();
        awaitingRescue = false;
      }
      pendingRefusal = true;
      pendingFilter = true;
      const ts = message.timestamp;
      pendingKey = String(typeof ts === "number" || typeof ts === "string" ? ts : ++seq);
      lastSeenKey = pendingKey;
      dbg("message_end:provider-filter (" + errText.slice(0, 80) + ")");
      return;
    }
    pendingFilter = false;
    noteAssistant(message);
    {
      const ts = message.timestamp;
      if (typeof ts === "number" || typeof ts === "string") lastSeenKey = String(ts);
    }
    dbg("message_end pending=" + pendingRefusal + " awaiting=" + awaitingRescue);
  });

  // ---- 4. 结算前救火 -----------------------------------------------------
  pi.on("agent_before_settle", (event) => {
    if (!settings.enabled || !settings.refusalRescue) return;
    dbg("settle pending=" + pendingRefusal + " awaiting=" + awaitingRescue);
    const state = event as unknown as {
      continue?: boolean;
      outcome?: string;
      entries?: unknown[];
      context?: { contextMessages?: AnyRecord[] };
    };
    // 兜底识别（m02423）：正常路径下 message_end 一定先到（pi 的 case "done"/"error" 都发），
    // 只有本插件自己的 message_end handler 抛错、或消息没有 timestamp 时才落到这里。
    // settle 事件带着 contextMessages，最后一条 assistant 确实是本轮掐断的那条就补记一次待救。
    if (!pendingFilter && !fallbackUsed && state.outcome === "error") {
      const tail = Array.isArray(state.context?.contextMessages) ? state.context!.contextMessages! : [];
      for (let i = tail.length - 1; i >= 0; i -= 1) {
        const last = tail[i];
        if (!last || last.role !== "assistant") continue;
        const errText = typeof last.errorMessage === "string" ? last.errorMessage : "";
        const ts = last.timestamp;
        const candKey = String(typeof ts === "number" || typeof ts === "string" ? ts : "");
        // lastSeenKey 命中 ⇒ message_end 已经处理过这条：它是旧消息（本轮 provider 直接 4xx/5xx，
        // 一条 assistant 都没产出），别拿它当理由再发一次请求。没有 timestamp 同理——判断不了
        // 是不是本轮那条，宁可这次不救。
        if (candKey && last.stopReason === "error" && isProviderFilterError(errText, last.rawStopReason) && candKey !== lastSeenKey) {
          pendingRefusal = true;
          pendingFilter = true;
          pendingKey = candKey;
          // 记成「已处理」：否则同一条旧消息会在每次 outcome:error 的 settle 上重复命中、
          // 重复 take()，failStreak 永不增长（refund() 会清 tracker 的 lastKey，挡不住）。
          lastSeenKey = candKey;
          fallbackUsed = true;
          dbg("settle:filter-from-context (" + errText.slice(0, 80) + ")");
        }
        break;
      }
    }
    if (!pendingRefusal) return;

    // 别的扩展已经请求续跑，或者这一轮本身就是 aborted/error，别重复要。
    if (state.continue === true) {
      pendingRefusal = false;
      pendingKey = "";
      pendingFilter = false;
      return;
    }
    if (state.outcome && state.outcome !== "completed") {
      // 供应商内容过滤也是 outcome:"error"，但这条不是「模型铁了心」，是上游按 finish_reason
      // 把这一轮掐了：放行续跑，话术换成 filter 口径。其它 error（工具异常、网络、鉴权）
      // 和 aborted 照旧放弃 —— 那些续跑只是再撞一次同样的墙。
      if (!(state.outcome === "error" && pendingFilter)) {
        pendingRefusal = false;
        pendingKey = "";
        pendingFilter = false;
        return;
      }
      dbg("settle:provider-filter -> rescue anyway");
    }

    const key = pendingKey || String(++seq);
    if (!tracker.take(key)) {
      dbg("settle:take-refused " + JSON.stringify(tracker.state()));
      pendingRefusal = false;
      pendingKey = "";
      pendingFilter = false;
      return;
    }
    const kind: "refusal" | "filter" = pendingFilter ? "filter" : "refusal";
    pendingRefusal = false;
    pendingKey = "";
    pendingFilter = false;
    awaitingRescue = true;
    dbg("settle:rescue -> " + JSON.stringify(tracker.state()));

    const draft = {
      type: "custom_message",
      customType: CONTINUE_TYPE,
      content: continueText(settings.continueText, ++rescueSeq, kind),
      display: false,
    };
    // runner 里 handlerResult.entries 是整体替换（runner.js:775-776），必须把已有 draft 带上。
    const existing = Array.isArray(state.entries) ? state.entries : [];
    return { entries: [...existing, draft], continue: true };
  });

  // 续跑发出去了，但整条 agent run 结束都没见到任何 assistant 消息
  // （pi 把 boundary 判非法、或者这一轮直接结束）——这不是「模型铁了心」，
  // 只是额度白花：还回去，不计连续失败。
  pi.on("agent_end", () => {
    dbg("agent_end awaiting=" + awaitingRescue + " pending=" + pendingRefusal);
    // 注意：pi 的事件顺序是 message_end → agent_end → agent_before_settle，
    // 所以这里绝对不要动 pendingRefusal，否则 settle 会看不到待救的拒答。
    if (awaitingRescue) {
      tracker.refund();
      awaitingRescue = false;
      dbg("agent_end:rescue-unlanded refund -> " + JSON.stringify(tracker.state()));
    }
  });

  // ---- 5. 会话边界 -------------------------------------------------------
  pi.on("session_shutdown", () => {
    pendingRefusal = false;
    pendingKey = "";
    pendingFilter = false;
    awaitingRescue = false;
    rebuildTracker();
  });

  pi.on("session_start", (_event, ctx) => {
    if (!settings.enabled) return;
    if (isPrintMode()) return;
    if (settingsFileBroken()) {
      ctx.ui.notify(
        "pi-purge: pi-purge.json 存在无法识别的键或类型错误：能识别的键照常生效，其余按默认值（只有 JSON 语法错或结构不是对象时才整体回落默认值）；下次保存前会先把原文件备份为 .corrupt-<ts>.bak",
        "warning",
      );
    }
    const where = settingsPath();
    ctx.ui.notify(
      "pi-purge: 规则层已启用（locale=" + settings.locale + ", rescue=" + settings.rescueMax + "）；配置 " + where,
      "info",
    );
  });

  // ---- /purge 命令组 -----------------------------------------------------
  const status = (): string => {
    const st = tracker.state();
    return [
      "enabled=" + settings.enabled + " rules=" + settings.rules + " locale=" + settings.locale,
      "strongIntro=" + settings.strongProjectIntro + " scrubHistory=" + settings.scrubHistory +
        " stripHostClauses=" + settings.stripHostClauses + " strippedClauses=" + lastStripRemoved,
      "rescue=" + settings.refusalRescue + " rescueMax=" + st.max + " maxFailStreak=" + st.maxFailStreak +
        " used=" + st.used + " failStreak=" + st.failStreak,
      "rulesBytes=" + rulesText().length + " section=" + PURGE_SECTION,
      "config=" + settingsPath(),
    ].join("\n");
  };

  const onOff = (value: string | undefined): boolean | undefined => {
    const v = String(value || "").toLowerCase();
    if (v === "on" || v === "1" || v === "enable" || v === "true") return true;
    if (v === "off" || v === "0" || v === "disable" || v === "false") return false;
    return undefined;
  };

  pi.registerCommand("purge", {
    description: "pi-purge 状态与开关（status/on/off/rules/rescue/max/maxfail/scrub/locale/test/dump）",
    handler: async (args, ctx) => {
      const parts = String(args || "").trim().split(/\s+/);
      const cmd = (parts.shift() || "status").toLowerCase();
      const rest = parts.join(" ").trim();

      switch (cmd) {
        case "status":
        case "st": {
          ctx.ui.notify(status(), "info");
          return;
        }
        case "on": {
          settings = saveSettings({ enabled: true });
          ctx.ui.notify("pi-purge: 已启用", "info");
          return;
        }
        case "off": {
          settings = saveSettings({ enabled: false });
          ctx.ui.notify("pi-purge: 已停用（下一轮起不注入、不清洗、不救火）", "warning");
          return;
        }
        case "rules": {
          const next = onOff(rest);
          if (next === undefined) {
            ctx.ui.notify("pi-purge rules=" + settings.rules + "（用 /purge rules on|off）", "info");
            return;
          }
          settings = saveSettings({ rules: next });
          ctx.ui.notify("pi-purge: 规则层注入 " + (next ? "开" : "关"), "info");
          return;
        }
        case "scrub": {
          const next = onOff(rest);
          if (next === undefined) {
            ctx.ui.notify(
              "pi-purge scrub=" + settings.scrubHistory + "（用 /purge scrub on|off；关掉 = 历史里留着拒答原文，误判时不会整条被洗）",
              "info",
            );
            return;
          }
          settings = saveSettings({ scrubHistory: next });
          ctx.ui.notify("pi-purge: 历史拒答清洗 " + (next ? "开（误判会整条替换成 marker）" : "关（只续跑，不改历史）"), "info");
          return;
        }
        case "rescue": {
          const next = onOff(rest);
          if (next === undefined) {
            ctx.ui.notify(
              "pi-purge rescue=" + settings.refusalRescue + " max=" + settings.rescueMax +
                "（用 /purge rescue on|off，或 /purge max 5 / /purge maxfail 3 改上限）",
              "info",
            );
            return;
          }
          settings = saveSettings({ refusalRescue: next });
          rebuildTracker();
          ctx.ui.notify("pi-purge: 拒答续跑 " + (next ? "开" : "关"), "info");
          return;
        }
        case "max": {
          const n = Number(rest);
          if (!Number.isFinite(n)) {
            ctx.ui.notify("用法：/purge max <0-20>", "warning");
            return;
          }
          settings = saveSettings({ rescueMax: Math.max(0, Math.min(20, Math.trunc(n))) });
          rebuildTracker();
          ctx.ui.notify("pi-purge: 每轮最多续跑 " + settings.rescueMax + " 次", "info");
          return;
        }
        case "maxfail": {
          const n = Number(rest);
          if (!Number.isFinite(n)) {
            ctx.ui.notify("用法：/purge maxfail <1-50>（连续被打回几次就本轮停手）", "warning");
            return;
          }
          settings = saveSettings({ maxFailStreak: Math.max(1, Math.min(50, Math.trunc(n))) });
          rebuildTracker();
          ctx.ui.notify(
            "pi-purge: 连续失败 " + settings.maxFailStreak + " 次停手（有效上限 = min(rescueMax, maxFailStreak)）",
            "info",
          );
          return;
        }
        case "locale": {
          const v = rest.toLowerCase();
          if (v !== "zh" && v !== "en") {
            ctx.ui.notify("pi-purge locale=" + settings.locale + "（用 /purge locale zh|en）", "info");
            return;
          }
          settings = saveSettings({ locale: v });
          ctx.ui.notify("pi-purge: 规则层语言 " + v, "info");
          return;
        }
        case "test": {
          if (!rest) {
            ctx.ui.notify("用法：/purge test <一段回复文本>", "warning");
            return;
          }
          const m = looksLikeRefusal(rest);
          ctx.ui.notify(
            m.hit ? "判定=拒答 rule=" + m.rule + " sample=" + m.sample : "判定=正常交付（不会触发续跑）",
            m.hit ? "warning" : "info",
          );
          return;
        }
        case "dump": {
          const text = rulesText();
          ctx.ui.notify("规则层 locale=" + settings.locale + "，" + text.length + " 字节；前 600 字：\n" + text.slice(0, 600), "info");
          return;
        }
        case "help":
        default: {
          ctx.ui.notify(
            [
              "/purge status | on | off",
              "/purge rules on|off | rescue on|off | scrub on|off | max N | locale zh|en",
              "/purge test <文本> | dump | help",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });
}
