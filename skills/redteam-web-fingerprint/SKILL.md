---
name: redteam-web-fingerprint
description: "Web 服务指纹识别：框架、中间件、CMS、组件版本（适用：已发现 HTTP/HTTPS 服务，需要识别技术栈时）"
metadata:
  role: recon
  when-to-use: "已发现 HTTP/HTTPS 服务，需要识别技术栈时"
  ported-from: "dsh-purge/skills/redteam/web-fingerprint.md"
---

> 共享约定（RT_HOME、占位符、`rt` 落库动词、授权口径、preflight）：见技能 `redteam-conventions`。
## 方法
1. 响应头：`Server`、`X-Powered-By`、`Set-Cookie` 特征。
2. 页面特征：favicon 哈希、静态资源路径、报错页、robots.txt。
3. 主动探测：nuclei 技术识别模板 `nuclei -u <url> -tags tech`；HTTP 存活与技术栈汇总用 `~/.local/bin/pd-httpx -l urls.txt -tech-detect -title -status-code -web-server`（**ProjectDiscovery 版必须用 pd-httpx，`/usr/bin/httpx` 是 Python 库的 CLI**）。
4. 大网段批量指纹用技能 `gogo-intranet`（`gogo -i <cidr> -p top2 -v --af`，主动指纹要加 `-v`）。
5. 版本比对：从指纹推断产品与版本，为漏洞检测做准备。

## 落库要求

指纹挂到资产上（`asset_test` 的 title/surface 字段），版本作为后续漏洞判定的证据：

```bash
rt asset_test --target <ip> --url <url> --title "<框架/中间件/CMS + vendor + version>" --surface web --evidence_ref runs/httpx-tech.txt
rt chain_add --stage_code internet --action "pd-httpx -tech-detect -title <url>" --tool httpx --result_ref runs/httpx-tech.txt
rt asset_query --q "<product>"   # 同产品在本 engagement 还有多少实例
```

fofa 交叉验证过的实例在 `--source fofa` 上标一次，避免两个来源重复计分。
