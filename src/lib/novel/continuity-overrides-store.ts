/**
 * continuity-overrides-store.ts — 连续性 override 持久化薄包装 (ADR-29 例外)
 *
 * ADR-29 Route B-1: deterministic-continuity-engine.ts 是纯函数零 IO 零 LLM
 * 引擎模块, MUST NOT 导入任何 store loader / fs / invoke。但 override 持久化
 * (ADR-34 AC-006.5 跨检测追溯) 必须落盘 — 否则每次检测都报同一误报。
 *
 * 本文件是 ADR-29 的"装配器薄包装"层: 复用 createAtomicJsonStore (v2.3.2 SEC-1
 * 路径守卫, relativePath 字面量 'continuity-overrides.json' 非用户输入守 CWE-22)
 * 持久化 ContinuityOverrideStore。引擎模块纯函数化, 持久化职责归本薄包装层。
 *
 * 同款模式参照 emotion-ledger.ts (createAtomicJsonStore + load/save 函数对)。
 * 守 fold_rebuildable: 失败非致命不回滚正文 (派生投影层)。
 * 守 CWE-532: note 字段全脱敏不引用正文 (override 结构只存 ref+reasonCode+note+
 * timestamp, 不存 finding 原文)。
 */

import { createAtomicJsonStore } from "./projection-store"
import type {
  ContinuityOverride,
  ContinuityOverrideStore,
} from "./deterministic-continuity-engine"

/**
 * createEmptyContinuityOverrideStore: 空工厂, lastUpdated 用空字符串 (非
 * new Date().toISOString()) — 避免模块加载时执行 new Date 不稳 (模块级求值
 * 时机不定, 参考 memory qmai-observability-infra 模块级 env 常量坑)。save 时
 * 在函数内设 lastUpdated = new Date().toISOString() (运行时求值)。
 */
export function createEmptyContinuityOverrideStore(): ContinuityOverrideStore {
  return { overrides: [], lastUpdated: "" }
}

// relativePath 字面量 'continuity-overrides.json' 非用户输入 — 由 createAtomicJsonStore
// 内部 normalizePath 派生路径, 复用 v2.3.2 SEC-1 路径守卫 (守 CWE-22 ADR-34/Decision 6.1)。
const continuityOverrideStore = createAtomicJsonStore<ContinuityOverrideStore>(
  "continuity-overrides.json",
  createEmptyContinuityOverrideStore,
)

export async function saveContinuityOverrides(
  projectPath: string,
  store: ContinuityOverrideStore,
): Promise<void> {
  store.lastUpdated = new Date().toISOString()
  await continuityOverrideStore.save(projectPath, store)
}

export async function loadContinuityOverrides(
  projectPath: string,
): Promise<ContinuityOverrideStore> {
  return continuityOverrideStore.load(projectPath)
}

/**
 * dismissFinding: writehook, 持久化 dismiss 记录到 override store。
 * ContinuityOverride.severity 类型已是 'warning'|'critical' (info 级 data_gap
 * 不允许 dismiss — 类型层守卫, 编译期拒绝 info 级 override 入参)。
 *
 * override 入参为 ContinuityOverride (ref+reasonCode+note+severity), 本章号
 * dismissedAtChapter 落盘。load → push → save。
 */
export async function dismissFinding(
  projectPath: string,
  override: ContinuityOverride,
  chapterNumber: number,
): Promise<void> {
  const store = await loadContinuityOverrides(projectPath)
  store.overrides.push({
    ...override,
    dismissedAtChapter: chapterNumber,
  })
  await saveContinuityOverrides(projectPath, store)
}
