/**
 * projection-self-heal 策略面 spec — 自愈跳过集合的判据与理由。
 *
 * 覆盖（均为可观察行为）：
 *   - isSelfHealSkipClass：跳过类别 vs 普通投影 id。
 *   - mayEnterFoldReplay：跳过类别无论 rebuildable 均排除；非跳过类交回既有门槛。
 *   - selfHealSkipReason：命中类别返回属性表 semantics；未命中返回 null（无告警文案）。
 *   - isUserAssetRefPath：Windows/Unix 分隔符都识别用户资产引用文件；其它路径返回 false。
 *   - 字面量跳过集合与属性表一致（模块加载断言 + 显式调用均不抛）。
 *
 * 跳过集合「不一致 → 抛错」的 fail-loud 契约在
 * projection-self-heal.skipset.spec.ts（需 mock 属性表）中覆盖。
 */
import { describe, expect, it } from "vitest"
import {
  EXTERNAL_DATA_CLASS_ATTRIBUTES,
  type ExternalDataClass,
} from "./projection-status-ledger"
import { USER_ASSET_ROOT } from "./user-asset-domain"
import {
  SELF_HEAL_SKIP_CLASSES,
  SELF_HEAL_SKIP_CLASS_IDS,
  SELF_HEAL_SKIP_USER_ASSET_MARKER,
  assertSelfHealSkipSetConsistent,
  isSelfHealSkipClass,
  isUserAssetRefPath,
  mayEnterFoldReplay,
  selfHealSkipReason,
} from "./projection-self-heal"

describe("isSelfHealSkipClass：哪些 id 被排除出自愈", () => {
  it("跳过类别命中（external_refetchable / untrusted_input）", () => {
    expect(isSelfHealSkipClass("external_refetchable")).toBe(true)
    expect(isSelfHealSkipClass("untrusted_input")).toBe(true)
  })

  it("普通投影 id 不跳过（交由既有 rebuildable 门槛判定）", () => {
    expect(isSelfHealSkipClass("graph")).toBe(false)
    expect(isSelfHealSkipClass("vector")).toBe(false)
    expect(isSelfHealSkipClass("character_state")).toBe(false)
  })
})

describe("mayEnterFoldReplay：fold 重算准入", () => {
  it("跳过类别：即使 rebuildable=true 也排除", () => {
    expect(mayEnterFoldReplay("external_refetchable", true)).toBe(false)
    expect(mayEnterFoldReplay("untrusted_input", true)).toBe(false)
  })

  it("非跳过类别：交回既有门槛结果（缺省 false）", () => {
    expect(mayEnterFoldReplay("character_state", true)).toBe(true)
    expect(mayEnterFoldReplay("character_state")).toBe(false)
    expect(mayEnterFoldReplay("character_state", false)).toBe(false)
  })
})

describe("selfHealSkipReason：跳过理由（telemetry / 告警文案）", () => {
  it("命中跳过类别 → 返回属性表 semantics（可解释为什么重抓≠重放）", () => {
    for (const cls of SELF_HEAL_SKIP_CLASSES) {
      const reason = selfHealSkipReason(cls)
      const semantics = EXTERNAL_DATA_CLASS_ATTRIBUTES[cls as ExternalDataClass].semantics
      expect(reason).toBe(semantics)
      expect(reason?.length ?? 0).toBeGreaterThan(10)
    }
    // 两个类别的理由互不相同（不是同一句泛化文案）
    expect(selfHealSkipReason("external_refetchable")).not.toBe(
      selfHealSkipReason("untrusted_input"),
    )
  })

  it("未命中 → null（无跳过理由，不伪造文案）", () => {
    expect(selfHealSkipReason("graph")).toBeNull()
    expect(selfHealSkipReason("vector")).toBeNull()
  })
})

describe("isUserAssetRefPath：用户资产引用路径判定", () => {
  it("Windows 反斜杠路径归一后识别", () => {
    expect(isUserAssetRefPath("C:\\proj\\demo\\.novel\\user-asset-refs.json")).toBe(true)
  })

  it("Unix 正斜杠路径识别", () => {
    expect(isUserAssetRefPath("/proj/demo/.novel/user-asset-refs.json")).toBe(true)
  })

  it("其它路径不误判（含外形相似的同名文件）", () => {
    expect(isUserAssetRefPath("/proj/demo/.novel/emotional-arcs.json")).toBe(false)
    expect(isUserAssetRefPath("user-asset-refs.json")).toBe(false)
    expect(isUserAssetRefPath("/proj/demo/.novel/user-asset-refs.json.bak")).toBe(false)
  })
})

describe("跳过集合单一事实源", () => {
  it("字面量集合与字符串形式一致，用户资产标记取自 USER_ASSET_ROOT", () => {
    expect(SELF_HEAL_SKIP_CLASS_IDS).toEqual([...SELF_HEAL_SKIP_CLASSES])
    expect(SELF_HEAL_SKIP_USER_ASSET_MARKER).toBe(USER_ASSET_ROOT)
  })

  it("一致性断言在集合与属性表同步时不抛（模块加载已跑过一次）", () => {
    expect(() => assertSelfHealSkipSetConsistent()).not.toThrow()
  })
})
