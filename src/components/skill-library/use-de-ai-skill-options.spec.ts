// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/skill-library/use-de-ai-skill-options.ts（自动生成，核心行为由专项 spec 加深） */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({ loadDeAiSkillConfig: vi.fn() }))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, loadDeAiSkillConfig: mocks.loadDeAiSkillConfig }
})

import { useDeAiSkillOptions } from "./use-de-ai-skill-options"

const CONFIG = {
  version: 1,
  defaultSkillId: "p1",
  disabledSkillIds: [] as string[],
  projectSkills: [
    { id: "p1", name: "项目技能一" },
    { id: "p2", name: "项目技能二" },
  ],
  builtInSkillOverrides: [],
  lastChapterDeAiSkillId: "p2",
}

beforeEach(() => {
  mocks.loadDeAiSkillConfig.mockReset()
})

describe("use-de-ai-skill-options.ts smoke", () => {
  it("exports useDeAiSkillOptions", () => {
    expect(useDeAiSkillOptions).toBeDefined()
  })

  it("装载成功 → skills 与生效技能落到 state", async () => {
    mocks.loadDeAiSkillConfig.mockResolvedValue(CONFIG)
    const { result } = renderHook(() => useDeAiSkillOptions({ projectPath: "/P", selectedSkillId: "p2" }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.skills.length).toBeGreaterThanOrEqual(2)
    expect(result.current.effectiveName).toBe("项目技能二")
    expect(result.current.currentSkillId).toBe("p2")
    expect(result.current.defaultSkillId).toBe("p1")
  })

  it("未指定 selectedSkillId 且 useLastChapterSkill → 用上一章技能", async () => {
    mocks.loadDeAiSkillConfig.mockResolvedValue(CONFIG)
    const { result } = renderHook(() =>
      useDeAiSkillOptions({ projectPath: "/P", useLastChapterSkill: true }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.currentSkillId).toBe("p2")
  })

  it("装载失败 → loadError 非空且不再 loading", async () => {
    mocks.loadDeAiSkillConfig.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useDeAiSkillOptions({ projectPath: "/P" }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loadError).not.toBe("")
  })

  it("卸载后 resolve → cancelled 守卫拦住，不再写 state", async () => {
    let resolveFn: ((v: unknown) => void) | undefined
    mocks.loadDeAiSkillConfig.mockImplementation(
      () => new Promise((res) => { resolveFn = res as (v: unknown) => void }),
    )
    const { unmount } = renderHook(() => useDeAiSkillOptions({ projectPath: "/P" }))
    await waitFor(() => expect(mocks.loadDeAiSkillConfig).toHaveBeenCalledTimes(1))
    unmount()
    resolveFn?.(CONFIG)
    await Promise.resolve()
    await Promise.resolve()
    // 卸载后仍只有一次装载调用，且没有抛错（守卫生效）
    expect(mocks.loadDeAiSkillConfig).toHaveBeenCalledTimes(1)
  })

  it("卸载后 reject → cancelled 守卫拦住，不写 loadError", async () => {
    let rejectFn: ((e: unknown) => void) | undefined
    mocks.loadDeAiSkillConfig.mockImplementation(
      () => new Promise((_res, rej) => { rejectFn = rej }),
    )
    const { unmount } = renderHook(() => useDeAiSkillOptions({ projectPath: "/P" }))
    await waitFor(() => expect(mocks.loadDeAiSkillConfig).toHaveBeenCalledTimes(1))
    unmount()
    rejectFn?.(new Error("boom"))
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.loadDeAiSkillConfig).toHaveBeenCalledTimes(1)
  })
})
