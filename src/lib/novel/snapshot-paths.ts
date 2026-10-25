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
  // ISS-20260712-MAINT-4: 统一双态候选（与 delete-source-memory 对齐）。
  // 正文章节同时接受补零与非补零（003.snapshot.json + 3.snapshot.json），
  // 大纲章节同时接受 outline-补零与 outline-非补零；旧 snapshot-paths 正数
  // 仅返回补零单项（Set 去重后坍缩）且负数 legacy 缺 outline 前缀（会与正数
  // 碰撞），此处修复。调用方必须经 exact token 匹配（has/isOnly*）消费，
  // 禁止 content.includes(候选) 子串判定（跨章节误伤：如 "3.snapshot.json"
  // 是 "13.snapshot.json" 的子串）。
  if (chapterNumber < 0) {
    const absolute = Math.abs(chapterNumber)
    const padded = `outline-${String(absolute).padStart(3, "0")}.snapshot.json`
    const unpadded = `outline-${absolute}.snapshot.json`
    return Array.from(new Set([padded, unpadded]))
  }
  const padded = `${String(chapterNumber).padStart(3, "0")}.snapshot.json`
  const unpadded = `${chapterNumber}.snapshot.json`
  return Array.from(new Set([padded, unpadded]))
}

/** 快照源文件名 token 正则（exact token 抽取唯一口径）。 */
const SNAPSHOT_SOURCE_TOKEN_RE = /[A-Za-z0-9_-]+\.snapshot\.json/g

/**
 * ISS-20260712-MAINT-4: 从正文/实体内容中抽取快照源 token（exact token，
 * 非子串）。返回全部 `*.snapshot.json` token（保持出现序，去重与否由调用方定）。
 */
export function extractSnapshotSourceTokens(content: string): string[] {
  return content.match(SNAPSHOT_SOURCE_TOKEN_RE) ?? []
}

/**
 * ISS-20260712-MAINT-4: 内容是否引用任一候选（exact Set 命中，非 includes 子串）。
 * 跨章节子串风险修复："003.snapshot.json" 不再误匹配 "1003.snapshot.json"
 *（后者 token 为 "1003.snapshot.json"，不在候选 Set 中）。
 */
export function hasSnapshotSourceReference(
  content: string,
  candidates: Set<string> | readonly string[],
): boolean {
  const set = candidates instanceof Set ? candidates : new Set(candidates)
  const tokens = extractSnapshotSourceTokens(content)
  return tokens.some((token) => set.has(token))
}

/**
 * ISS-20260712-MAINT-4: 内容引用的快照源是否全部且仅属于当前章节候选
 *（至少命中一个候选 token，且所有 token 均在候选 Set 内）。truth store 残留
 * 修的判定口径：仅当前章节来源的孤儿实体方可删除，跨章节混引永不删。
 */
export function isOnlyCurrentChapterSource(
  content: string,
  candidates: Set<string> | readonly string[],
): boolean {
  const set = candidates instanceof Set ? candidates : new Set(candidates)
  const tokens = extractSnapshotSourceTokens(content)
  return tokens.length > 0 && tokens.every((token) => set.has(token))
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
