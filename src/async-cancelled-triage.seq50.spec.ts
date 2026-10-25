// SEQ-50 triage: 5 async useEffect without cancelled flag.
// Sources: odyssey-review a92fd5e3 commit message lists
// App / welcome-screen / lint-view / app-layout / graph-view:1086.
// This spec statically proves which still lack a guard (confirm) and which
// are already safe (falsify, no prod change).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd().endsWith("QMAI") ? process.cwd() : join(process.cwd(), "QMAI")

function src(rel: string): string {
  return readFileSync(join(root, rel), "utf-8")
}

function hasCancelledGuard(code: string): boolean {
  return (
    code.includes("let cancelled = false") &&
    code.includes("cancelled = true") &&
    (code.includes("if (!cancelled)") || code.includes("if (cancelled)"))
  )
}

describe("SEQ-50 five async useEffect triage (ISS-20260712-013)", () => {
  it("App.tsx async init has cancelled guard (mount-once + StrictMode safe)", () => {
    const code = src("src/App.tsx")
    expect(code).toContain("initializeApp")
    // 修复后必须有 cancelled 守卫
    expect(hasCancelledGuard(code)).toBe(true)
  })

  it("lint-view.tsx history load has cancelled guard (project-switch race)", () => {
    const code = src("src/components/lint/lint-view.tsx")
    expect(code).toContain("loadHistory")
    expect(hasCancelledGuard(code)).toBe(true)
  })

  it("app-layout.tsx file-tree load has cancelled guard (project-switch race)", () => {
    const code = src("src/components/layout/app-layout.tsx")
    expect(code).toContain("listDirectory")
    expect(hasCancelledGuard(code)).toBe(true)
  })

  it("welcome-screen.tsx mount-once getRecentProjects needs no guard (falsified, no prod change)", () => {
    const code = src("src/components/project/welcome-screen.tsx")
    expect(code).toContain("getRecentProjects")
    // mount-once deps=[]，无 project 依赖，无 stale-overwrite 面：不断言 guard
    expect(code).toContain("}, [])")
  })

  it("graph-view.tsx foreshadowing load already has guard (falsified, no prod change)", () => {
    const code = src("src/components/graph/graph-view.tsx")
    expect(code).toContain("loadForeshadowingTracker")
    expect(hasCancelledGuard(code)).toBe(true)
  })
})
