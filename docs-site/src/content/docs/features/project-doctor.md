---
title: 项目医生
description: 整链机械诊断（6 基础项 + 3 形态挂载项），只读运行，输出健康度判定与修复建议
---

# 🩺 项目医生

项目医生（v2.7.8，64 号实施）提供**确定性机械诊断**：6 个基础检查项 + 3 个形态挂载检查项，全程只读零写盘。

## 基础检查项

| 项 | 判定 |
|---|---|
| status-json | `.novel/status.json` 缺失 → error（运行时唯一真源未初始化） |
| canon-dual-write | canon 双写未启用 → warn（正式层写盘无门控） |
| fts-index | FTS 索引缺失/过期 → warn（运行 `rebuildWikiFtsIndex` 恢复） |
| chapter-backups | 无章节备份 → warn（首次保存自动产生） |
| budget-ledger | 已完成集合含未知任务 → error（账本不一致） |
| volume-arc | 卷弧状态展示（无分卷 → ok） |

## 形态挂载检查项

| 项 | 判定 |
|---|---|
| fanfic-merge-pending | 悬挂同人合并提案 → warn（accept 前不写正式 wiki） |
| translation-drafts | `.novel/translation-drafts` 草稿计数展示 |
| play-graph | 互动影游图阻断诊断 >0 → error |

## 运行方式

- `runDoctorDiagnostics(ctx)`：纯函数（ctx 由调用方注入），确定性同输入同输出
- `runProjectDoctor`：只读 IO（读取 status.json / 索引 / 备份目录状态）
- 判定：全 ok → `healthy`；有 warn → `degraded`；有 error → `critical`
- `formatDoctorReport`：文本报告（UI/命令层展示）
