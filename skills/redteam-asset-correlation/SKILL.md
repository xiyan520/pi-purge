---
name: redteam-asset-correlation
description: "资产关联：域名↔IP↔C 段↔证书↔服务的图谱化（适用：信息收集阶段性收口，需要形成资产关系视图时）"
metadata:
  role: recon
  when-to-use: "信息收集阶段性收口，需要形成资产关系视图时"
  ported-from: "dsh-purge/skills/redteam/asset-correlation.md"
---

> 共享约定（RT_HOME、占位符、`rt` 落库动词、授权口径、preflight）：见技能 `redteam-conventions`。
## 关联规则
- 域名解析 → `resolves` 边（domain → asset）
- C 段归属 → `contains` 边（segment → asset）
- 端口开放 → `exposes` 边（asset → port）
- 证书 SAN 共享 → `shares_cert` 边

## 落库要求
通过 rt asset_link 写入 edge 表；重复关系幂等。
