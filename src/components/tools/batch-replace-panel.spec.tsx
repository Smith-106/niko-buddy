// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// Spec for src/components/tools/BatchReplacePanel.tsx — 写前门接线回归。
//
// 实机缺陷（三模型审计 round-1，deepseek finding #7）：面板把
// `preflightCanonEdgeGate(files, rule, [])` 的既有边恒传空数组，而
// `checkCanonPreWrite` 的全部冲突判定都从 `existingEdges` 取样 —— 门永远 PASS，
// UI 却在宣称「提交前跑既有写前门」。本 spec 锁定三件事：
//   1）预览时用**真实加载到的**既有 canon 事实跑门（不是 []）；
//   2）既有事实读不出来时报「未评估」，绝不显示为通过；
//   3）门结论按 i18n 键渲染，不直接把 lib 的诊断串塞进界面。

import { cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
  queryCanonEdges: vi.fn(),
  previewBatchReplace: vi.fn(),
  preflightCanonEdgeGate: vi.fn(),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    queryCanonEdges: mocks.queryCanonEdges,
    previewBatchReplace: mocks.previewBatchReplace,
    preflightCanonEdgeGate: mocks.preflightCanonEdgeGate,
  }
})

import { BatchReplacePanel } from "./BatchReplacePanel"

const DIFFS = [
  {
    path: "book/c1.md",
    replacements: 2,
    changes: [{ line: 1, before: "林舟走进屋。", after: "林舟舟走进屋。" }],
  },
]

const EXISTING_FACT = {
  id: "canon-1",
  sourceId: "林舟",
  targetId: "舟舟",
  predicate: "replaced_by",
  edgeKind: "fact",
  archived: false,
  validAt: null,
  invalidAt: null,
}

function renderPanel() {
  return render(<BatchReplacePanel projectPath="C:/proj" targets={["book/c1.md"]} />)
}

async function preview() {
  fireEvent.change(screen.getByTestId("batchreplace-find"), { target: { value: "林舟" } })
  fireEvent.change(screen.getByTestId("batchreplace-replace"), { target: { value: "林舟舟" } })
  fireEvent.click(screen.getByTestId("batchreplace-preview"))
  await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled())
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("BatchReplacePanel / canon 写前门接线", () => {
  it("预览时把真实加载到的既有 canon 事实交给写前门，而不是空数组", async () => {
    mocks.queryCanonEdges.mockResolvedValue([EXISTING_FACT])
    mocks.previewBatchReplace.mockResolvedValue(DIFFS)
    mocks.preflightCanonEdgeGate.mockReturnValue({ state: "PASS", conflicts: [], notes: [] })

    renderPanel()
    await preview()

    await waitFor(() => expect(mocks.queryCanonEdges).toHaveBeenCalledTimes(1))
    // 查询只用既有读路径过滤（find 文本作为实体 + replaced_by 谓词）
    expect(mocks.queryCanonEdges.mock.calls[0][0]).toBe("C:/proj")
    await waitFor(() => expect(mocks.preflightCanonEdgeGate).toHaveBeenCalled())
    const edges = mocks.preflightCanonEdgeGate.mock.calls[0][2] as unknown[]
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ id: "canon-1", sourceId: "林舟", targetId: "舟舟" })
  })

  it("既有事实不可读取时报未评估，不显示为通过", async () => {
    mocks.queryCanonEdges.mockRejectedValue(new Error("canon_query unavailable"))
    mocks.previewBatchReplace.mockResolvedValue(DIFFS)

    renderPanel()
    await preview()

    const state = await screen.findByTestId("batchreplace-canon-gate-state")
    await waitFor(() => expect(state).toHaveAttribute("data-state", "unevaluated"))
    expect(screen.getByText("batchreplace.canonGate.unavailable")).toBeTruthy()
    // 门未评估时不得跑判定，也不得渲染成 PASS
    expect(mocks.preflightCanonEdgeGate).not.toHaveBeenCalled()
    expect(screen.queryByText(/batchreplace\.canonGate\.label：PASS/)).toBeNull()
  })

  it("门结论按 i18n 键渲染，不直接暴露 lib 诊断串", async () => {
    mocks.queryCanonEdges.mockResolvedValue([])
    mocks.previewBatchReplace.mockResolvedValue(DIFFS)
    mocks.preflightCanonEdgeGate.mockReturnValue({
      state: "WARN",
      conflicts: [
        {
          newEdgeId: "batch:book/c1.md:林舟->林舟舟",
          existingEdgeId: "canon-1",
          code: "warn_temporal_advance",
          reason: "WARN：同端点同 predicate 异值但区间不重叠（时态递进，建议确认）",
        },
      ],
      notes: ["写前 gate 命中 1 处（mode=warn）"],
    })

    renderPanel()
    await preview()

    expect(await screen.findByText("batchreplace.canonGate.warn")).toBeTruthy()
    expect(screen.getByTestId("batchreplace-canon-gate-advisory")).toBeTruthy()
    // 诊断串只作 title，不进可见文本
    expect(screen.queryByText(/时态递进/)).toBeNull()
  })
})
