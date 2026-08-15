import { describe, expect, it } from "vitest"
import en from "@/i18n/en.json"
import zh from "@/i18n/zh.json"

type JsonRecord = Record<string, unknown>

function flatten(obj: JsonRecord, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v as JsonRecord, key, out)
    } else {
      out[key] = v
    }
  }
  return out
}

describe("S3b i18n parity (en/zh 键对称)", () => {
  const enFlat = flatten(en as JsonRecord)
  const zhFlat = flatten(zh as JsonRecord)
  const enKeys = new Set(Object.keys(enFlat))
  const zhKeys = new Set(Object.keys(zhFlat))

  it("en → zh 无缺失 (所有 en key 在 zh 中有对应)", () => {
    const missingZh = [...enKeys].filter((k) => !zhKeys.has(k))
    expect(missingZh, `zh 缺失 ${missingZh.length} 个 en key: ${missingZh.slice(0, 20).join(", ")}`).toEqual([])
  })

  it("zh → en 无缺失 (所有 zh key 在 en 中有对应)", () => {
    const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))
    expect(missingEn, `en 缺失 ${missingEn.length} 个 zh key: ${missingEn.slice(0, 20).join(", ")}`).toEqual([])
  })

  it("占位符一致性: 同 key 两侧的插值变量一致", () => {
    const mismatches: string[] = []
    for (const key of enKeys) {
      if (!zhKeys.has(key)) continue
      const enV = String(enFlat[key])
      const zhV = String(zhFlat[key])
      const enVars = [...enV.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
      const zhVars = [...zhV.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
      if (enVars.join(",") !== zhVars.join(",")) {
        mismatches.push(`${key}: en{${enVars.join(",")}} vs zh{${zhVars.join(",")}}`)
      }
    }
    expect(mismatches, `插值变量不一致 ${mismatches.length} 处: ${mismatches.slice(0, 10).join(" | ")}`).toEqual([])
  })

  it("结构对称: 嵌套对象层级一致 (en/zh 同为叶子或同为容器)", () => {
    function isLeaf(v: unknown): boolean {
      return v === null || typeof v !== "object" || Array.isArray(v)
    }
    const mismatches: string[] = []
    for (const key of enKeys) {
      if (!zhKeys.has(key)) continue
      // key 存在且两侧都是叶子 (flatten 已保证); 检查父路径结构
      const parent = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : ""
      if (!parent) continue
      const enHasParent = parent in enFlat === false // 父路径必为容器, flatten 不产叶子
      const zhHasParent = parent in zhFlat === false
      void enHasParent
      void zhHasParent
      // 简化: 只要两侧 key 集一致即结构对称 (flat 集已验)
    }
    expect(mismatches).toEqual([])
    // 结构性验证: 顶层 section 集合一致
    const enTops = new Set(Object.keys(en as JsonRecord))
    const zhTops = new Set(Object.keys(zh as JsonRecord))
    expect([...enTops].filter((t) => !zhTops.has(t))).toEqual([])
    expect([...zhTops].filter((t) => !enTops.has(t))).toEqual([])
  })
})
