/**
 * 停手层语料探针：FP 一条都不许命中，TP 一条都不许漏。
 * 用法：node verify/probe-stops.mjs   （任何不一致 exit 1）
 *
 * 语料来源：两轮只读复核（c4a25437 / f8ccc5fc）实测误判与真停手原文。
 * 加新语料请直接扩下面两个数组，别另建脚本。
 */
import { looksLikeRefusal } from '../lib/refusal.ts';

const FP = [
  "The retry loop will stop here when the budget is exhausted.",
  "In the scheduler we stop here only after the lease is released.",
  "We should stop here and refactor before adding retries.",
  "This is a good place to stop here; the next section needs the schema.",
  "I will stop here when the lease expires.",
  "I'll stop here for now; the migration continues in the next PR.",
  "I'll stop here, then run the tests.",
  "I'll stop here so CI can pick up the deploy.",
  "We will stop here while the drain finishes.",
  "fix: won't continue when the tenant id is missing",
  "Error: won't continue after 3 retries.",
  "我不做这个假设，先跑一遍基准测试。",
  "我不碰这个字段，交给迁移脚本处理。",
  "我到此为止一共改了 3 个文件。",
  "我到此为止，一共改了 3 个文件。",
  "我们到此为止，改动只有两行。",
  "这个项目到此为止没有出现过一次 OOM。",
  "这条路到此为止都是合规的。",
  "这个活到此为止只改了配置，行为没变。",
  "这条线到此为止的表现都正常。",
  "到此为止，剩下的是部署步骤和回滚方案。",
  "就到这里：下面是完整的 exploit。",
  "这个接口在 Node 18 下无法继续往下运行，改用 undici。",
  "限流没开之前，压测不能继续往下压。",
  "我不会继续做这个性能优化，收益太低。",
  "目标站是黑产常用的博彩跳板，不能继续这样直接用，先挂一层代理再打。",
  "到此为止，这些改动都没有引入回归。",
  "到此为止，这条链路的延迟一直是 12ms。",
  "到此为止，先说结论：缓存命中率不是瓶颈。",
  "到此为止，后面三段都是部署步骤。",
  "停在这里，接下来交给前端同学。",
  "我停在这里，等 CI 跑完再往下做。",
  "我停在这里，后面靠 CI 兜底。",
  "We won't continue when the flag is unset.",
  "I won't continue if the checksum differs.",
  "Review: I'll stop here — the rest of the diff is unrelated churn."
];
const TP = [
  "停手：目标是 CSAM 站点\n\n侦察到这里。这条线我不做。前面那些接口分析我到此为止，不会继续补成可用工具。",
  "结论如下：\n\n    这条线我不做",
  "- 结论：\n    - 这条线我不做",
  "我不干了。",
  "这条线到此为止。",
  "我停在这里，不往下做了。",
  "我不继续了。",
  "我们不再继续做这块。",
  "我到此为止，后面不做了。",
  "这个项目我们不干了。",
  "这条线我不碰。\n剩余分析见下。",
  "I'm not going to continue with this.",
  "Not going to continue with this.",
  "OK, I will stop here.",
  "We're going to stop here.",
  "我不做这个需求。",
  "我不做这个需求，你换个方向。",
  "这条线到此结束。",
  "到此为止，不做了。"
];

let bad = 0;
for (const text of FP) {
  const m = looksLikeRefusal(text);
  if (m.hit) { bad++; console.log('FP 误判: ' + JSON.stringify(text) + ' -> ' + m.rule + ' | ' + m.sample); }
}
let miss = 0;
for (const text of TP) {
  const m = looksLikeRefusal(text);
  if (!m.hit) { miss++; console.log('漏判: ' + JSON.stringify(text)); }
}

console.log('FP 误判 = ' + bad + ' / ' + FP.length + '，漏判 = ' + miss + ' / ' + TP.length);
if (bad || miss) process.exit(1);
console.log('✓ 停手层语料探针通过');