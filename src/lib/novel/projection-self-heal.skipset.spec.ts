/**
 * projection-self-heal skip-set fail-loud spec（C-010 / C-007）。
 *
 * `assertSelfHealSkipSetConsistent()` 把字面量跳过集合与属性表
 * （EXTERNAL_DATA_CLASS_ATTRIBUTES.entersSelfHeal === false）比对，任何一侧漂移
 * 即抛错——这是「新增外部数据类却忘记同步跳过集合」的唯一防线。
 *
 * 该抛错分支无法用真实属性表触发（两者当前一致），故此处按用例替换属性表制造
 * 单向漂移，断言 missing / extra 两个方向都 fail-loud，并保留同步时的对照组。
 */
import { describe, expect, it, vi } from "vitest"

type Attrs = Record<string, unknown>

function attributesOf(classes: readonly string[]): Attrs {
  const attributes: Attrs = {}
  for (const cls of classes) {
    attributes[cls] = {
      semantics: `semantics-of-${cls}`,
      foldRebuildable: false,
      entersSelfHeal: false,
      provenanceRequired: true,
      trustLevel: "untrusted",
      domain: "qm_raw_source",
    }
  }
  return attributes
}

/** 用给定类别集重建属性表后加载模块（模块加载即跑 fail-loud 断言）。 */
async function importWithClasses(classes: readonly string[]): Promise<unknown> {
  vi.resetModules()
  vi.doMock("./projection-status-ledger", () => ({
    EXTERNAL_DATA_CLASSES: [...classes],
    EXTERNAL_DATA_CLASS_ATTRIBUTES: attributesOf(classes),
  }))
  return import("./projection-self-heal")
}

describe("assertSelfHealSkipSetConsistent fail-loud", () => {
  it("属性表多出类别（missing）→ 模块加载即抛，并点名缺失类别", async () => {
    await expect(
      importWithClasses(["external_refetchable", "untrusted_input", "phantom_class"]),
    ).rejects.toThrow(/skip-set mismatch — missing: \[phantom_class\]; extra: \[\]/)
  })

  it("字面量多出类别（extra）→ 模块加载即抛，并点名多余类别", async () => {
    await expect(importWithClasses(["external_refetchable"])).rejects.toThrow(
      /skip-set mismatch — missing: \[\]; extra: \[untrusted_input\]/,
    )
  })

  it("对照：两侧同步时模块加载不抛（自愈判据可用）", async () => {
    const mod = (await importWithClasses(["external_refetchable", "untrusted_input"])) as {
      isSelfHealSkipClass: (projection: string) => boolean
      assertSelfHealSkipSetConsistent: () => void
    }
    expect(mod.isSelfHealSkipClass("untrusted_input")).toBe(true)
    expect(() => mod.assertSelfHealSkipSetConsistent()).not.toThrow()
  })
})
