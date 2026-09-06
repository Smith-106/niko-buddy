---
name: story-cover
description: Use when generating a book cover brief, cover image prompt, or visual identity for a novel project. Produces provider-agnostic cover contracts (subject/composition/palette/mood) that any external image provider can consume.
---

# 封面视觉 Skill

## 适用范围

开书封面、卷封、番外封面、书单封面；需要把书籍元数据转成可消费的封面需求时。

## 规则

1. 先取书籍元数据：书名、题材、主角一句话外形、全书基调、关键意象词。
2. 按题材映射默认视觉语言（都市→霓虹冷色+天际线；玄幻→金橙+深蓝法相；悬疑→低饱和+单点强调……），再按书本身基调覆写。
3. 封面 brief 必须包含五要素：主体描述、构图、色调方案、氛围关键词、文字位（书名排布 top/center/bottom）。
4. 底线约束必须写清：竖版 2:3 默认、无真实人脸特写、无文字水印、留白比例。
5. 生成图像 prompt 时拼接：brief 全文 + 画面比例 + 尺寸（竖版 1024x1536/方形 1024x1024/横版 1536x1024）+ 禁止项。

## 与引擎契约对齐

- 契约结构对齐 `cover-brief.ts` 的 `BookCoverMeta → CoverBrief`（subject/composition/palette/moodKeywords/titlePlacement/constraints）。
- 图像任务组装对齐 `cover-image-provider.ts` 的 `buildCoverImageTask`（aspect 表驱动尺寸）。
- 产物先进 `.novel/covers/` pending 区，用户 accept 后才进发布目录（Draft-first）。

## 禁止

- 不生成真实人物肖像；不直接调用任何图像 provider（引擎层零图像 SDK，端口由产品层注入）。
- 不在 brief 里写价格、平台、字数等非视觉信息。
- 不输出分析、说明、写作过程或 Skill 名称。
