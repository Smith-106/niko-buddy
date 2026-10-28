import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * PAT-U5（ISS-20260712-006 batch-2）：自定义折叠触发点必须三件套齐备
 * （aria-expanded + aria-controls + 展开区 role="region"）。
 *
 * 项目无 shadcn Collapsible/Accordion，全部是 button+useState 手写折叠，
 * 所以用源码级守护防止新触发点回退成只有 aria-expanded 的半套。
 */
const ROOT = resolve(import.meta.dirname, "../../..")
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8")

const SWEPT = [
  "src/components/novel/craft/technique-panel.tsx",
  "src/components/graph/mindmap-views.tsx",
  "src/components/novel/main-control-view.tsx",
  "src/components/project/create-project-dialog.tsx",
  "src/components/novel/campaign-dashboard-dialog.tsx",
  "src/components/novel/director-view.tsx",
  "src/components/chat/chat-message.tsx",
  "src/components/layout/icon-sidebar.tsx",
]

describe("ISS-20260712-006 batch-2 折叠 a11y 三件套", () => {
  for (const rel of SWEPT) {
    it(`${rel} 折叠触发点带 aria-controls 且展开区为 region`, () => {
      const src = read(rel)
      expect(src, "aria-expanded").toContain("aria-expanded")
      expect(src, "aria-controls").toContain("aria-controls")
      expect(src, 'role="region"').toContain('role="region"')
    })
  }

  it("aria-controls 的取值与展开区 id 同源（不是硬编码空串）", () => {
    for (const rel of SWEPT) {
      const src = read(rel)
      const controls = src.match(/aria-controls=\{([^}]+)\}/g) ?? []
      expect(controls.length, rel).toBeGreaterThan(0)
      for (const attr of controls) {
        // 允许 useId 变量、模板字符串、字符串常量、以及“无条件折叠时无面板”的
        // 三元分支（`x ? id : undefined`）；不允许裸 `{undefined}` / `{null}`。
        const expr = attr.replace(/^aria-controls=\{|\}$/g, "").trim()
        expect(["undefined", "null", "\"\""], rel).not.toContain(expr)
      }
    }
  })
})
