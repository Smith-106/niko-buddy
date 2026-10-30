import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../../..")

// 原 novel/dismantling-view.spec.ts：UX 审计批次四退役 T1（dismantling-view.tsx）后，
// 导航与数据层断言迁到这里，旧组件断言改为「已删除」。
describe("dismantling library routing", () => {
  it("拆文库导航指向 bookAnalysis", () => {
    const storeSource = readFileSync(resolve(root, "src/stores/wiki-store.ts"), "utf8")
    const navSource = readFileSync(resolve(root, "src/components/layout/nav-items.ts"), "utf8")
    const contentSource = readFileSync(resolve(root, "src/components/layout/content-area.tsx"), "utf8")

    expect(storeSource).toContain('"bookAnalysis"')
    expect(navSource).toContain('view: "bookAnalysis"')
    expect(navSource).toContain("novel.nav.dismantling")
    expect(contentSource).toContain("BookAnalysisView")
    expect(contentSource).toContain("@/components/novel/book-analysis-view")
  })

  it("旧拆文视图与侧栏已删除", () => {
    const sidebarSource = readFileSync(resolve(root, "src/components/layout/sidebar-panel.tsx"), "utf8")
    expect(existsSync(resolve(root, "src/components/novel/dismantling-view.tsx"))).toBe(false)
    expect(sidebarSource).not.toContain('activeView === "dismantling"')
    expect(sidebarSource).not.toContain("DismantlingSidebarPanel")
  })

  it("拆文数据层保留", () => {
    const libSource = readFileSync(resolve(root, "src/lib/novel/dismantling.ts"), "utf8")
    expect(libSource).toContain("normalizeDismantlingLibrary")
    expect(libSource).toContain("splitDismantlingTextIntoChapters")
  })
})
