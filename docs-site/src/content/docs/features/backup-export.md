---
title: 备份与导出
description: 本地项目封装导出、完整性校验与恢复，支持可选口令加密
---

# 💾 备份与导出

备份与导出页（BackupExportView）提供项目级封装导出（canon_export_project）、完整性预检（canon_verify_export）、恢复（canon_restore_project）与自动备份（canon_auto_backup）。它与「设置 → 数据管理」区分：本页聚焦项目整体 zip 封装与可选口令加密，所有口令本地不持久化。

## 主路径

- 在页头查看说明，并按需设置本地口令（AES-256，KeyRound 卡片）；口令仅本地用于加密，不参与远程传输、不落盘
- 点击「导出」→ 系统 save 对话框选择路径 → 调用 canon_export_project；backup-progress 通道实时推送进度，可随时取消
- 校验卡片调用 canon_verify_export 只校验不落盘，确认备份包完整后再决定恢复
- 恢复卡片调用 canon_restore_project，经二次确认后选择 zip 落盘，避免误覆盖当前项目
- 可触发 canon_auto_backup 生成自动备份，结果进入自动备份历史（History）列表

## 能力构成

- 四卡片结构：导出卡片（Download → exportResult / Warnings）、校验卡片（BadgeCheck）、恢复卡片（canon_restore_project）、自动备份历史（History）
- 进度通道：导出进度经 `backup-progress` 通道推送，operation 字段区分不同操作
- 纯本地语义：无服务端鉴权，口令本地不持久化，适合单机项目迁移与归档

## 命令与通道

页面经以下 IPC 命令与后端交互，进度统一走 `backup-progress` 通道（operation 字段区分操作类型）：

- `canon_export_project`：项目封装导出，导出前可选本地口令加密
- `canon_verify_export`：只校验备份包完整性，不落盘
- `canon_restore_project`：选 zip 恢复，二次确认后落盘
- `canon_auto_backup`：生成自动备份，写入历史列表

## 与「设置 → 数据管理」的区别

- 「设置 → 数据管理」偏向应用级偏好与缓存的清理；本页面向**单个项目**的整体封装与迁移。
- 本页导出的是含 Canon 事实边与章节快照的项目 zip，可直接用于归档、迁移或跨机恢复。

## 状态与限制

- 空态：无自动备份历史时显示空列表；无项目路径时操作按钮禁用
- 加载 / 错误：`isBusy`（export / restore / verify / auto 之一）非空时显示进度条（progress.current / progress.total）；导出或恢复失败时以红字加 AlertTriangle 提示具体错误
- 无权限：N/A（纯本地操作，无服务端鉴权）
- 已知限制：P2 — 导出进度条精修 / 历史记录分页未交付
