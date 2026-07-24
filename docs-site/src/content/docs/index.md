---
# Starlight 首页：产品官网门面 + 技术文档入口
layout: ../../layouts/Home.astro
title: niko-hub
description: 面向长篇小说的记忆型 AI 写作桌面系统
---

import { Card, CardGrid } from '@astrojs/starlight/components';

# niko-hub

**面向 200 万～300 万字量级连载小说创作的记忆型 AI 写作桌面系统。**

> 写前自动提取上下文 → 写后自动沉淀章节记忆 → 图谱追踪关系变化 → 审查系统防止崩坏 → 人工确认最终定稿

普通 AI 写作工具的痛点：写到后期 AI 遗忘前文、人物性格不一致、时间线混乱、伏笔丢失。niko-hub 通过结构化记忆系统与混合检索引擎，让 AI 在每次生成时都能"记住"之前的一切。

<CardGrid stagger>
  <Card title="📚 记忆系统" icon="bookmark">
    章节摄取自动结构化为可检索记忆单元，上下文引擎按优先级组装 token 预算控制的上下文包。
  </Card>
  <Card title="🎭 角色灵魂" icon="user">
    项目灵魂文档 + 角色视角（NvwaSKILL）+ 角色认知追踪（knows / does_not_know）。
  </Card>
  <Card title="📖 拆书库" icon="open-book">
    从成熟作品提取角色 6 维人格与 9 维文风，复用到自己的创作。
  </Card>
  <Card title="🔍 审查系统" icon="magnifier">
    六维审查 + 角色一致性 + 连贯性检查 + 事实检查 + 伏笔债务追踪。
  </Card>
  <Card title="🔗 确定性连续性引擎" icon="link">
    零 LLM 机械层预检：角色缺席 / 支线休眠 / 情绪账本 / AI 味检测，阈值经真实中文长篇校准。
  </Card>
  <Card title="🕸️ 图谱功能" icon="graph">
    实体与关系网络可视化，Sigma.js + ForceAtlas2 布局，社区发现与交互式探索。
  </Card>
</CardGrid>

## 立即开始

- **下载安装** → [前往 GitHub Releases](https://github.com/Smith-106/niko-hub/releases) 下载最新 Windows 安装包
- **快速上手** → 看 [快速开始](/niko-hub/quickstart/) 配置模型并写第一章
- **了解架构** → 看 [架构概览](/niko-hub/dev/architecture/) 理解 8 层设计

## 技术栈

桌面框架 Tauri 2 · 前端 React 19 + TypeScript + Vite · 样式 Tailwind CSS 4 · 状态 Zustand 5 · 富文本 Milkdown 7 · 图谱 Sigma.js 3 · 向量存储 LanceDB · 后端 Rust · 本地优先架构（所有数据存储本地，LLM 调用除外）。

## 适用场景

- **网文日更作者**：保持长篇连载质量、防止人设崩坏
- **小说策划者**：管理世界观、势力关系、多线剧情
- **AI 辅助写作者**：让大模型在长篇创作中持续可用
- **学习仿写者**：通过拆书库拆解成熟作品的角色设定与文风
