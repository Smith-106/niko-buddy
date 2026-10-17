import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import en from "@/i18n/en.json"
import zh from "@/i18n/zh.json"

/**
 * 左侧图标栏（及壳层常用）i18n 键的**双侧齐备**回归。
 *
 * 起因：`novel.nav.skillLibrary` / `novel.nav.storySimulation` 两个键从未写入
 * `zh.json` / `en.json`，i18next 按缺键回落，把键原文直接渲染进悬浮提示。
 * 本测试把「图标栏引用的每个键都必须在 zh/en 双侧存在」变成机器可查的约束，
 * 避免以后新增入口时再漏翻译。
 */

const SIDEBAR = (() => {
  const candidates = [
    "QMAI/src/components/layout/nav-items.ts",
    "QMAI/src/components/layout/icon-sidebar.tsx",
  ]
  for (const rel of candidates) {
    const candidate = resolve(process.cwd(), rel)
    try {
      readFileSync(candidate, "utf8")
      return candidate
    } catch {
      /* 继续尝试下一候选路径（hub 根 / QMAI 内） */
    }
  }
  return resolve(process.cwd(), "src/components/layout/nav-items.ts")
})()

/** 导航清单所在文件（ui-audit-20261016：清单从 icon-sidebar.tsx 抽到 nav-items.ts，
 * 侧栏与命令面板共用），两处都要扫，否则抽表后回归覆盖会静默变小。 */
function navSourceFiles(): string[] {
  const dir = resolve(SIDEBAR, "..")
  return [SIDEBAR, resolve(dir, "icon-sidebar.tsx"), resolve(dir, "command-palette.tsx")]
}

/** 取出图标栏里所有 labelKey 与 t("...") 字面量键。 */
function sidebarKeys(): string[] {
  const keys = new Set<string>()
  for (const file of navSourceFiles()) {
    const src = readFileSync(file, "utf8")
    for (const m of src.matchAll(/labelKey:\s*"([^"]+)"/g)) keys.add(m[1])
    for (const m of src.matchAll(/\bt\("([^"]+)"\)/g)) keys.add(m[1])
  }
  return [...keys].sort()
}

function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>(
    (node, part) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
    bundle,
  )
}

describe("图标栏 i18n 键双侧齐备", () => {
  const keys = sidebarKeys()

  it("至少提取到导航键（防止正则失效导致空断言）", () => {
    expect(keys.length).toBeGreaterThan(5)
    expect(keys).toContain("novel.nav.skillLibrary")
  })

  it.each(keys)("%s 在 zh/en 双侧都有译文", (key) => {
    const zhValue = lookup(zh as Record<string, unknown>, key)
    const enValue = lookup(en as Record<string, unknown>, key)
    expect(zhValue, `zh.json 缺少 ${key}`).toBeTypeOf("string")
    expect(enValue, `en.json 缺少 ${key}`).toBeTypeOf("string")
    expect(zhValue).not.toBe("")
  })
})
