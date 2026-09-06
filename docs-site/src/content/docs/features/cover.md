---
title: 封面生成
description: 封面 brief 契约 → aspect 表驱动任务组装 → provider 端口注入的幂等生成执行器
---

# 🖼️ 封面生成

封面生成（v2.7.8，64 号实施）把封面需求契约接到执行端：**确定性任务组装 + 注入式生成端口 + 幂等落盘**。引擎层零图像 SDK 依赖。

## 封面 brief 契约

`buildCoverBrief`（BookCoverMeta → CoverBrief）：主体描述 / 构图 / 色调方案 / 氛围关键词 / 文字位 / 底线约束；题材 → 默认视觉语言确定性映射（都市→霓虹冷色、玄幻→金橙+深蓝、悬疑→低饱和+单点强调）。

## 任务组装

`buildCoverImageTask`：

- prompt = brief 全文 + 画面比例（竖版 2:3 / 方形 1:1 / 横版 16:9）+ 尺寸（1024×1536 / 1024×1024 / 1536×1024）+ 禁止项（无文字水印、无真实人脸特写）
- 文件名 `slugify`（书名 → 安全文件名，空回退 `untitled`）

## 执行与幂等

`runCoverImageGeneration`（CoverImagePort 注入）：

- 目标已存在 → `skipped`（零覆盖幂等）
- port 抛错 → `failed`（不吞异常）；abort → `canceled`
- 产物落 `.novel/covers/{fileName}`（pending 区，Draft-first；accept 移动由调用方执行）

## 主路径

1. 设置页「封面工作台」生成结构化 brief 预览（`cover-prompt-workbench`）
2. 选择比例（默认竖版）→ 组装任务
3. 注入 provider 端口执行生成
4. 审阅产物（.novel/covers/）→ accept 进发布目录
