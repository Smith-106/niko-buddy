// Copyright (c) 2026 Niko Buddy Contributors. MIT License.
// SPDX-License-Identifier: MIT

/**
 * 创作中枢（CreativeHubView）纯路由映射表：
 * 将诊断发现（DoctorFinding）、下一步建议（CreativeNextItem.code）、门控阻塞、
 * 诊断结论与绑定状态映射为可点击的站内视图跳转目标（零 IO、零副作用）。
 */

import type { WikiState } from "@/stores/wiki-store"

export type CreativeHubTargetView = WikiState["activeView"]

export interface CreativeHubActionTarget {
  readonly view: CreativeHubTargetView
  readonly label: string
}

/** 诊断项 id → 修复视图目标 */
export const CREATIVE_FINDING_ACTION_MAP: Readonly<Record<string, CreativeHubActionTarget>> = {
  "status-json": { view: "director", label: "去开书导演初始化" },
  "canon-dual-write": { view: "canonEditor", label: "去设定校正" },
  "fts-index": { view: "search", label: "去剧情搜索重建" },
  "chapter-backups": { view: "backupExport", label: "去备份与恢复" },
  "budget-ledger": { view: "diagnosticsCenter", label: "去诊断中心" },
  "volume-arc": { view: "sources", label: "去大纲规划" },
  "fanfic-merge-pending": { view: "diagnosticsCenter", label: "去诊断中心处理" },
  "translation-drafts": { view: "diagnosticsCenter", label: "去诊断中心查看" },
  "play-graph": { view: "storySimulation", label: "去故事模拟检查" },
}

const DEFAULT_FINDING_ACTION: CreativeHubActionTarget = {
  view: "diagnosticsCenter",
  label: "去诊断中心",
}

/** 根据诊断项 id 解析跳转目标（未知 id 安全回退到诊断中心）。 */
export function resolveFindingActionTarget(findingId: string): CreativeHubActionTarget {
  return CREATIVE_FINDING_ACTION_MAP[findingId] ?? DEFAULT_FINDING_ACTION
}

/** 门控名 → 修复视图目标 */
export const CREATIVE_GATE_ACTION_MAP: Readonly<Record<string, CreativeHubActionTarget>> = {
  consistency: { view: "reviewCenter", label: "去审查中心修复" },
  anti_ai: { view: "antiAiRules", label: "去反 AI 规则修复" },
  quality: { view: "reviewCenter", label: "去审查中心查看" },
}

const DEFAULT_GATE_ACTION: CreativeHubActionTarget = {
  view: "reviewCenter",
  label: "去审查中心",
}

/** 根据被阻塞的门控解析修复视图目标。 */
export function resolveBlockingGateActionTarget(blockingGate: string | null): CreativeHubActionTarget {
  if (!blockingGate) return { view: "mainControl", label: "去主控执行" }
  return CREATIVE_GATE_ACTION_MAP[blockingGate] ?? DEFAULT_GATE_ACTION
}

/** 根据下一步建议的 code 解析一键跳转目标。 */
export function resolveNextStepActionTarget(code?: string): CreativeHubActionTarget {
  if (!code) {
    return { view: "wiki", label: "去章节库继续写" }
  }
  if (code.startsWith("blockingGate=")) {
    return resolveBlockingGateActionTarget(code.slice("blockingGate=".length))
  }
  if (code === "verdict=critical") {
    return { view: "diagnosticsCenter", label: "去诊断中心" }
  }
  if (code === "meta=corrupt") {
    return { view: "diagnosticsCenter", label: "去诊断中心检查" }
  }
  if (code === "meta=null") {
    return { view: "director", label: "去开书导演完善" }
  }
  return { view: "wiki", label: "去章节库继续写" }
}

/** 诊断卡片快捷跳转目标（critical/degraded → 诊断中心；healthy → 状态总览）。 */
export function resolveDiagnosisActionTarget(verdict: "healthy" | "degraded" | "critical"): CreativeHubActionTarget {
  if (verdict === "healthy") {
    return { view: "statusDashboard", label: "查看状态总览" }
  }
  return { view: "diagnosticsCenter", label: "去诊断中心" }
}

/** 小说状态（binding）卡片的快捷跳转目标。 */
export function resolveBindingActionTarget(hasMeta: boolean, metaCorrupt: boolean): CreativeHubActionTarget {
  if (metaCorrupt) {
    return { view: "diagnosticsCenter", label: "去诊断中心检查" }
  }
  if (!hasMeta) {
    return { view: "director", label: "去开书导演设置" }
  }
  return { view: "wiki", label: "去章节库写作" }
}
