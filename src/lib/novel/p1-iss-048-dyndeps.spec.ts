/**
 * ISS-20260709-048：动态 import 3 模块补 deps 显式声明，并核查反向引用无环。
 *
 * 三条懒加载边：
 * 1. context-engine.ts → ./community-summary（首屏不进主 chunk）
 * 2. context-data-sources.ts → ./character-state
 * 3. ingest.ts → @/lib/embedding（两调用点同一目标）
 *
 * 显式声明 = 运行时 dynamic import + 类型级模块别名（打包器/类型系统均可见）；
 * 无环 = 目标模块无静态回引 importer（文件文本 import 关系断言）。
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function readSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8")
}

describe("ISS-20260709-048 动态 import 显式声明 + 反向无环", () => {
  it("三条懒加载边均有 dynamic import + 类型级显式声明", () => {
    const engine = readSource("./context-engine.ts")
    expect(engine).toMatch(/await import\(["']\.\/community-summary["']\)/)
    expect(engine).toMatch(/loadPersistedCommunitySummariesType/)

    const dataSources = readSource("./context-data-sources.ts")
    expect(dataSources).toMatch(/await import\(["']\.\/character-state["']\)/)
    expect(dataSources).toMatch(/CharacterStateModule/)

    const ingest = readFileSync(new URL("../ingest.ts", import.meta.url), "utf8")
    expect(ingest).toMatch(/await import\(["']@\/lib\/embedding["']\)/)
    expect(ingest).toMatch(/EmbeddingModule/)
  })

  it("反向引用无环：三目标模块均无静态回引 importer", () => {
    const community = readSource("./community-summary.ts")
    expect(community).not.toMatch(/from\s+["']\.\/context-engine["']/)
    expect(community).not.toMatch(/require\(["']\.\/context-engine["']\)/)

    const characterState = readSource("./character-state.ts")
    expect(characterState).not.toMatch(/from\s+["']\.\/context-data-sources["']/)
    expect(characterState).not.toMatch(/require\(["']\.\/context-data-sources["']\)/)

    const embedding = readFileSync(new URL("../embedding.ts", import.meta.url), "utf8")
    expect(embedding).not.toMatch(/from\s+["']@\/lib\/ingest["']/)
    expect(embedding).not.toMatch(/from\s+["']\.\/ingest["']/)
    expect(embedding).not.toMatch(/require\(["'].*ingest["']\)/)
  })
})
