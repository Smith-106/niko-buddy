import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../../..")

describe("dismantling library visibility", () => {
  it("hides the dismantling library navigation entry in version 2.2.7+", () => {
    const storeSource = readFileSync(resolve(root, "src/stores/wiki-store.ts"), "utf8")
    const sidebarSource = readFileSync(resolve(root, "src/components/layout/icon-sidebar.tsx"), "utf8")
    const contentSource = readFileSync(resolve(root, "src/components/layout/content-area.tsx"), "utf8")

    expect(storeSource).toContain('"bookAnalysis"')
    expect(sidebarSource).toContain('view: "bookAnalysis"')
    expect(sidebarSource).toContain("novel.nav.dismantling")
    expect(contentSource).toContain("BookAnalysisView")
    expect(contentSource).toContain("@/components/novel/book-analysis-view")
  })

  it("keeps the dismantling sidebar removed from the visible workspace (P2-4: dead component deleted 2026-08-31)", () => {
    const viewSource = readFileSync(resolve(root, "src/components/novel/dismantling-view.tsx"), "utf8")
    const sidebarSource = readFileSync(resolve(root, "src/components/layout/sidebar-panel.tsx"), "utf8")

    expect(sidebarSource).not.toContain('activeView === "dismantling"')
    expect(sidebarSource).not.toContain("DismantlingSidebarPanel")
    expect(viewSource).toContain("拆文结果")
  })

  it("keeps the dismantling library data layer intact for later re-enable", () => {
    const libSource = readFileSync(resolve(root, "src/lib/novel/dismantling.ts"), "utf8")

    expect(libSource).toContain("normalizeDismantlingLibrary")
    expect(libSource).toContain("splitDismantlingTextIntoChapters")
  })
})
