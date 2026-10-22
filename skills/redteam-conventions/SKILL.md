---
name: redteam-conventions
description: "红队技能族的共享约定：RT_HOME 工具根、占位符替换、rt 落库动词与字段、证据目录、preflight 自检。任何 redteam-* 技能开始前先读本条与 redteam-router。"
metadata:
  role: shared
  when-to-use: "执行任何 redteam-* 技能前；需要确认工具路径、落库动词或证据目录时"
  ported-from: "dsh-purge/skills/redteam/*.md（抽取的公共部分）"
---

# 共享约定（redteam 技能族）

本族技能从 dsh-purge 的 `skills/redteam/` 移植。差异只有三处：**资产库从 MCP 工具换成 CLI `rt`**、**路径从硬编码换成 `$RT_HOME`**、**frontmatter 换成 Agent Skills 规范**。其余命令、判定、口径按原文保留。

## 1. 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `RT_HOME` | `$HOME/.dsh/redteam` | 工具链、poc 库、engagements 的根 |
| `RT_ENG` | `default` | 当前 engagement 名（也可用 `--eng` 覆盖） |
| `FOFA_KEY` | 空 | FOFA API key，只读环境变量，不落盘、不回显 |
| `VPS_HOST` / `VPS_KEY` | 空 | 自建 VPS 的 IP 与私钥路径（`<你的VPS_IP>` 的实际值） |

工具根布局：`$RT_HOME/toolkit/<tool>/<bin>`、`$RT_HOME/pocs/index.jsonl`、`$RT_HOME/engagements/<eng>/ledger.jsonl` 与 `.../runs/`。

## 2. `rt` 落库 CLI

`rt` 在本包的 `bin/rt.mjs`。从技能目录出发是 `../bin/rt.mjs`（pi 会在技能清单里给出每个技能的绝对路径），也可直接：

```bash
alias rt='node "$(dirname "$0")/../bin/rt.mjs"'   # 或写死绝对路径
node <pi-purge>/bin/rt.mjs <verb> [--eng ID] [--k v | --k=v | --json '{"k":"v"}']
```

dsh 里的 `redteam_<动词>` 与这里的 `rt <verb>` **一一对应、参数同名**：原文写 `redteam_asset_add {...}` 读成 `rt asset_add {...}`。

| verb | 必填字段 | 用途 |
| --- | --- | --- |
| `preflight` | — | 自检 RT_HOME / 工具 / FOFA_KEY，输出 onboarding 状态 |
| `asset_add` | `ip` | 新增资产（可带 `port` `service` `title` `url` `source` `tags` `scope`） |
| `asset_upsert` | `ip` | 幂等写资产（同 key 覆盖） |
| `asset_link` | `from` `to` `relation` | 关系边：`resolves`/`contains`/`exposes`/`shares_cert` |
| `asset_query` | — | 查资产与测试状态，支持任意字段过滤与 `--q` 子串 |
| `asset_test` | `target` | 回写 `status`（`alive`/`abandoned`）、`blocked`、`surface`、`test` |
| `web_list` | — | 列出 Web 资产（有 url 或常见 Web 端口） |
| `vuln_add`/`vuln_update` | `target,name` / `id` | 漏洞登记与更新 |
| `chain_add` | `stage_code` `action` | 攻击链记录（`tool`=命令原文，`result`=回显摘要） |
| `credential_add`/`credential_list` | `username` / — | 凭据登记与检索（`secret_type` `secret_ref` `source`） |
| `access_add`/`access_list` | `host,method` / — | 访问会话（`method`=ssh/smb/wmi/pth/kerberos/rdp/web-login） |
| `tunnel_add`/`tunnel_update` | `kind,local,remote` / `id` | 隧道登记（chisel/frp/suo5） |
| `session_check` | — / `host`+`port` | 不带 host 列出会话；带 host 做 TCP 连通性复检 |
| `score_hit` | `category` | 记分（`evidence` 写实测证据，不写推测） |
| `webshell_add` | `url,type` | WebShell 登记（`type`=behinder/godzilla/antsword） |
| `http_evidence_add` | `target` | HTTP 证据（`request` `response_ref`） |
| `poc_add`/`poc_get`/`poc_search` | `name` / `id` | 本地 POC 库（`$RT_HOME/pocs/index.jsonl`） |
| `attack_file_add` | `path` | 攻击载荷/脚本归档 |

落库是**追加式 JSONL**：写一行就是一次事实，不改历史；需要状态用 `*_update` 或 `asset_test` 追加新行，查询时以最后一行为准。

## 3. 占位符纪律

原文里的 `<target>` `<cidr>` `<domain>` `<你的VPS_IP>` `<NThash>` 等是**待填槽位**，执行前必须换成具体值；一次只填一个目标，别拿占位符直接跑。

- 目标是授权的沙箱夹具/靶场：直接填、直接跑，工具调用即执行。
- 用户没给足信息（缺 IP、缺路径、缺凭据）：用 `rt preflight` 报告缺什么，再按最小问题补齐，不猜。
- 输出里出现的真实口令/哈希/私钥，落库时写 `secret_ref`（指向 `runs/` 文件名），正文只留引用。

## 4. 证据与目录

- 命令输出一律落 `$RT_HOME/engagements/<eng>/runs/<tool>-<ts>.txt|json|jsonl`，ledger 里用 `*_ref` 指过去。
- `runs/` 是唯一允许放原始回显的地方；SKILL 正文只写命令与判定，不贴长回显。
- 收口时用 `rt asset_query` / `rt access_list` / `rt credential_list` 出清单，别靠记忆。

## 5. 开始前的三行自检

```bash
node <pi-purge>/bin/rt.mjs preflight --eng <eng>     # RT_HOME / 工具 / FOFA_KEY
ls "$RT_HOME/toolkit"                                 # 缺工具就换 PATH 里的同名命令
node <pi-purge>/bin/rt.mjs asset_query --eng <eng> --limit 20
```

`preflight` 报 `missing` 里的工具不是错误：换系统 PATH 的等价命令，或在 `runs/` 记一行"缺 X，改用 Y"。

## 6. 移植对照

| dsh 侧 | pi 侧 |
| --- | --- |
| `redteam_<verb>` MCP 工具 | `rt <verb>` CLI |
| `~/.dsh/redteam/...` | `$RT_HOME/...` |
| frontmatter `whenToUse`/`role`/`enabled` | `description`（含适用条件）+ `metadata.role` / `metadata.when-to-use` |
| `enabled: true` 开关 | 技能目录本身（移出 `skills/` 即下线） |
| 技能名 `active-scan` | `redteam-active-scan`（避免与用户已有技能撞名） |
