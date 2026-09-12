import {
  EXTERNAL_DATA_CLASSES,
  EXTERNAL_DATA_CLASS_ATTRIBUTES,
  type ExternalDataClass,
} from "./projection-status-ledger"
import { USER_ASSET_ROOT } from "./user-asset-domain"

/**
 * 自愈跳过集合 — SELF-HEAL SKIP SET（C-010 / C-007）
 *
 * 上游事实：`projection-self-heal.spec.ts` 已用 604 行行为 spec 锚定 P2-IMP-14
 * （failed 自愈）与 P2-IMP-15（drift 自动修复）的既有语义——自愈只对
 * `fold_rebuildable` 且注册表 `rebuildable:true` 的投影生效，非确定性投影
 * （graph / vector）与 `rebuildable:false` 条目一律不自动重算。
 *
 * 本模块是**该门槛的单一策略源**，把 C-010 新增的两个外部数据类与
 * C-007 的用户资产域显式并入跳过集合，避免各处散写字符串：
 *
 *   - `external_refetchable`：外部时间事实。重抓 ≠ 重放——fold 重算会写出与当下
 *     外部世界不一致的「事实」，故**禁入 fold 重算与 self-heal**。
 *   - `untrusted_input`：外部不可信且不可执行输入，无 fold 语义，禁入。
 *   - 用户资产域（`USER_ASSET_ROOT`）：跨项目、用户级、**不可重建**——项目侧只有
 *     引用文件，本体在项目外且无 committed 快照来源，故**永远不参与 fold 重算**。
 *
 * 本模块**不实现**自愈本身（实现在既有 ingest / ledger 路径），只提供判据，
 * 以免形成第二条自愈链（INV-4 禁重造）。
 */

/**
 * 字面量跳过集合（单一事实源）。二者均位于跳过集合——由
 * `assertSelfHealSkipSetConsistent()` 在模块加载时与属性表比对（fail-loud）。
 */
export const SELF_HEAL_SKIP_CLASSES: readonly ExternalDataClass[] = [
  "external_refetchable",
  "untrusted_input",
]

/** 自愈跳过集合的字符串形式（供 UI 提示 / 决策日志 / 判据 grep 使用）。 */
export const SELF_HEAL_SKIP_CLASS_IDS: readonly string[] = [...SELF_HEAL_SKIP_CLASSES]

/** 用户资产域在项目侧的引用文件名（不得进入 fold 重算的标记）。 */
export const SELF_HEAL_SKIP_USER_ASSET_MARKER = USER_ASSET_ROOT

/**
 * fail-loud 一致性校验：字面量跳过集合必须与属性表派生的集合完全一致。
 * 任何一侧新增类别而另一侧忘记同步 → 启动即抛（cognee fail-loud，与注册表同纪律）。
 */
export function assertSelfHealSkipSetConsistent(): void {
  const derived = EXTERNAL_DATA_CLASSES.filter(
    (c) => EXTERNAL_DATA_CLASS_ATTRIBUTES[c].entersSelfHeal === false,
  )
  const literal = [...SELF_HEAL_SKIP_CLASSES]
  const missing = derived.filter((c) => !literal.includes(c))
  const extra = literal.filter((c) => !derived.includes(c))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[projection-self-heal] skip-set mismatch — missing: [${missing.join(", ")}]; extra: [${extra.join(
        ", ",
      )}] (fail-loud)`,
    )
  }
}

// 模块加载即校验（与 PROJECTION_REGISTRY 的注册即校验同纪律）。
assertSelfHealSkipSetConsistent()

/**
 * 该投影 id 是否被排除出自愈 / drift 自动修复。
 * 投影 id 命中跳过类别直接排除；其余交由既有 `isAutoRebuildableProjection` 判定
 * （本函数只负责「新类别」这一维，不改变既有门槛语义）。
 */
export function isSelfHealSkipClass(projection: string): boolean {
  return SELF_HEAL_SKIP_CLASS_IDS.includes(projection)
}

/**
 * 该投影是否可进入 fold 重算 / 自愈遍历集。
 * @param projection 投影 id 或外部数据类名
 * @param isRebuildable 既有门槛的结果（`isAutoRebuildableProjection`）；缺省 false。
 */
export function mayEnterFoldReplay(projection: string, isRebuildable = false): boolean {
  if (isSelfHealSkipClass(projection)) return false
  return isRebuildable
}

/** 给出跳过理由（供 telemetry / 告警文案使用；未知类别返回 null）。 */
export function selfHealSkipReason(projection: string): string | null {
  if (!isSelfHealSkipClass(projection)) return null
  const attrs = EXTERNAL_DATA_CLASS_ATTRIBUTES[projection as ExternalDataClass]
  return attrs?.semantics ?? "external data class excluded from fold replay"
}

/** 项目侧引用文件是否属于永不重算的用户资产引用（路径判定）。 */
export function isUserAssetRefPath(path: string): boolean {
  return path.replace(/\\/g, "/").endsWith("/.novel/user-asset-refs.json")
}
