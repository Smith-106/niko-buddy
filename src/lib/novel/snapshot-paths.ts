// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// snapshot-paths.ts — F4-3 (Round-3 评估)：快照路径与渲染纯函数。
//
// 从 chapter-ingest.ts（2823 行）拆出的第一个纯函数子模块：快照文件路径簇
// （prefix/json/md/history/candidates）+ snapshotToMarkdown。仅 type-only
// 依赖 chapter-ingest 的 ChapterSnapshot（编译期擦除，无运行时循环）；
// chapter-ingest 经 re-export 保持既有 import 面不变。

import type { ChapterSnapshot } from "./chapter-ingest"

export function snapshotFilePrefix(chapterNumber: number): string {
  if (chapterNumber < 0) return `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}`
  return String(chapterNumber).padStart(3, "0")
}

export function snapshotJsonPath(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.novel/snapshots/${snapshotFilePrefix(chapterNumber)}.snapshot.json`
}

export function snapshotMarkdownPath(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.novel/snapshots/${snapshotFilePrefix(chapterNumber)}.snapshot.md`
}

export function snapshotHistoryDir(projectPath: string, chapterNumber: number): string {
  return `${projectPath}/.novel/snapshots/history/${snapshotFilePrefix(chapterNumber)}`
}

export function snapshotHistoryFileName(): string {
  return `${new Date().toISOString().replace(/:/g, "-")}.snapshot.json`
}

export function snapshotSourceFileNameCandidates(chapterNumber: number): string[] {
  const canonical = chapterNumber < 0
    ? `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}.snapshot.json`
    : `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  const legacy = `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  return Array.from(new Set([canonical, legacy]))
}

export function snapshotToMarkdown(snapshot: ChapterSnapshot): string {
  const md = [
    `# 第${snapshot.chapterNumber}章 快照`,
    "",
    `## 摘要`,
    snapshot.summary,
    "",
    `## 出场人物`,
    ...(snapshot.characters.length > 0 ? snapshot.characters.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 出场地点`,
    ...(snapshot.locations.length > 0 ? snapshot.locations.map(l => `- ${l}`) : ["（无）"]),
    "",
    `## 出场组织`,
    ...(snapshot.organizations.length > 0 ? snapshot.organizations.map(o => `- ${o}`) : ["（无）"]),
    "",
    `## 出场物品`,
    ...(snapshot.items.length > 0 ? snapshot.items.map(i => `- ${i}`) : ["（无）"]),
    "",
    `## 关键事件`,
    ...(snapshot.events.length > 0 ? snapshot.events.map(e => `- ${e}`) : ["（无）"]),
    "",
    `## 人物状态变化`,
    ...(snapshot.characterStateChanges.length > 0 ? snapshot.characterStateChanges.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 人物关系变化`,
    ...(snapshot.relationshipChanges.length > 0 ? snapshot.relationshipChanges.map(r => `- ${r}`) : ["（无）"]),
    "",
    `## 角色认知变化`,
    ...(snapshot.knowledgeChanges.length > 0 ? snapshot.knowledgeChanges.map(k => `- ${k}`) : ["（无）"]),
    "",
    `## 伏笔变化`,
    ...(snapshot.foreshadowingChanges.length > 0 ? snapshot.foreshadowingChanges.map(f => `- ${f}`) : ["（无）"]),
    "",
    `## 新增正史设定`,
    ...(snapshot.newCanonFacts.length > 0 ? snapshot.newCanonFacts.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 时间线事件`,
    ...(snapshot.timelineEvents.length > 0 ? snapshot.timelineEvents.map(t => `- ${t}`) : ["（无）"]),
    "",
    `## 冲突变化`,
    ...(snapshot.conflicts.length > 0 ? snapshot.conflicts.map(c => `- ${c}`) : ["（无）"]),
    "",
    `## 结尾钩子`,
    snapshot.endingHook || "（无）",
    "",
    `## 图谱节点`,
    ...(snapshot.graphNodes.length > 0 ? snapshot.graphNodes.map(g => `- ${g}`) : ["（无）"]),
    "",
    `## 图谱关系边`,
    ...(snapshot.graphEdges.length > 0 ? snapshot.graphEdges.map(g => `- ${g}`) : ["（无）"]),
  ]

  if (snapshot.validationWarnings && snapshot.validationWarnings.length > 0) {
    md.push(
      "",
      `## 校验警告`,
      ...snapshot.validationWarnings.map(w => `- [${w.type}] ${w.message}`),
    )
  }

  return md.join("\n")
}
