---
name: redteam-router
description: "红队技能路由：按当前阶段（信息收集 / 资产测绘 / 指纹 / 目录爆破 / 漏洞扫描 / 未授权利用 / 凭据 / 隧道 / 横向 / WebShell / 浏览器自动化）指到具体 redteam-* 技能，并给出该阶段的落库动作。拿不准该用哪个技能时先读本条。"
metadata:
  role: router
  when-to-use: "用户给出靶标/域名/内网段，或说\"开始打点\"\"信息收集\"\"内网\"\"拿权限\"但没说用哪个工具时"
  ported-from: "dsh-purge/skills/redteam/（新增的路由层）"
---

# 红队技能路由

先读 `redteam-conventions`（RT_HOME、`rt` 动词、占位符纪律），再按下表进具体技能。

| 阶段 | 触发说法 | 技能 | 首个落库动作 |
| --- | --- | --- | --- |
| 起步/装环境 | 环境没配好、工具装一下 | `redteam-setup` | `rt preflight` |
| 被动收集 | 不接触目标、公开数据源 | `redteam-passive-recon` | `rt asset_add --source crt.sh ...` |
| 测绘（FOFA） | 资产面、测绘、FOFA | `redteam-fofa-recon` | `rt asset_add --source fofa ...` |
| 子域流水线 | 子域、解析、探活 | `redteam-recon-pipeline` | `rt asset_add --source subfinder ...` |
| 主动扫描 | 端口、服务、存活 | `redteam-active-scan` | `rt asset_add --source nmap ...` |
| 资产关联 | 收口、图谱、C 段 | `redteam-asset-correlation` | `rt asset_link --relation contains ...` |
| Web 指纹 | 什么框架、什么 CMS | `redteam-web-fingerprint` | `rt asset_test --surface ...` |
| 目录/接口爆破 | 后台、备份、接口 | `redteam-dir-bruteforce` | `rt asset_test --status alive ...` |
| 模板化漏扫 | CVE、nuclei、Nday | `redteam-nuclei-scan` | `rt vuln_add ...` |
| 未授权利用 | Redis/ES/Docker 直取 | `redteam-unauth-exploit` | `rt vuln_add` + `rt score_hit` |
| 凭据攻击 | 弱口令、哈希、爆破 | `redteam-credential-attack` | `rt credential_add ...` |
| 内网综合 | 内网、fscan、段 | `redteam-fscan-intranet` | `rt asset_add --tags internal ...` |
| 内网测绘 | gogo、超智能 | `redteam-gogo-intranet` | `rt asset_add --source gogo ...` |
| 横向/提权 | 横向、PtH、Kerberos | `redteam-lateral-movement` | `rt access_add ...` |
| 隧道 | 代理出来、穿透 | `redteam-chisel-tunnel` / `redteam-frp-tunnel` / `redteam-suo5-tunnel` | `rt tunnel_add ...` |
| 反弹 Shell | 监听、回连 | `redteam-shell-handler` / `redteam-vps-reverse-shell` | `rt session_check ...` |
| WebShell | 冰蝎、哥斯拉、蚁剑 | `redteam-webshell-toolkit` | `rt webshell_add ...` |
| 浏览器侧 | 抓渲染页、点页面 | `redteam-browser-automation` / `redteam-kimi-webbridge` | `rt asset_add --tool browser ...` |
| 出口代理 | 国内代理池、轮换 | `redteam-cn-proxy-pool` | 无（读 `runs/`） |

## 组合套路

1. **外网 → 入口**：`passive-recon` → `fofa-recon`/`recon-pipeline` → `active-scan` → `web-fingerprint` → `dir-bruteforce` → `nuclei-scan`。
2. **入口 → 权限**：`unauth-exploit` 或 `credential-attack` → `webshell-toolkit`（拿到 WebShell）或 `lateral-movement`（拿到凭据）。
3. **权限 → 内网**：`fscan-intranet`/`gogo-intranet` → `chisel-tunnel`/`suo5-tunnel` → `lateral-movement` → `vps-reverse-shell` 收口。
4. 每步收尾都回 `rt chain_add`（`stage_code` 取 `internet`/`boundary-logical`/`internal`），证据落 `runs/`。

## 硬规则

- 任何技能开跑前先 `rt preflight`；`missing` 只记录、不阻断。
- 一次只推进一个阶段，不并行扫同一目标（限速与封禁都记在 `asset_test`）。
- 记分只认实测证据：`rt score_hit --evidence "<实测回显摘要>"`。
