/**
 * character-aura-context.tauri-guard.spec.ts — Tauri 资源探测链的降级守卫。
 *
 * 需独立成文件的原因：这里必须让 `@tauri-apps/api/path` 这个**模块本身加载失败**
 * （vi.mock 工厂抛错 → 动态 import 拒绝）。主 spec（character-aura-context.spec.ts）
 * 要正常拿到 `resourceDir`，两者不能共存于同一模块图。
 *
 * 锁定的行为（`readSkillFileWithFallback` 的两层降级）：
 *   - 内层：单个探测函数（getExecutableDir / getResourceDir）抛错 → 警告并继续下一个根，
 *     不放弃整条回退链（resourceDir() 自身的失败在主 spec 里覆盖，本文件里该模块不可加载）；
 *   - 外层：探测用 API 模块不可用 → 同样警告并继续，绝不把「探测失败」变成
 *     「读取失败」，最终仍抛**原始** IO 错误（调用方看到的错误原因不变）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getExecutableDir: vi.fn(),
  getResourceDir: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fsMocks.readFile,
    getExecutableDir: fsMocks.getExecutableDir,
    getResourceDir: fsMocks.getResourceDir,
  }
})

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return { ...actual, isTauri: () => true }
})

// 模拟「受限壳层里 @tauri-apps/api/path 根本加载不了」：工厂抛错 → 动态 import 拒绝。
vi.mock("@tauri-apps/api/path", () => {
  throw new Error("Cannot resolve module @tauri-apps/api/path")
})

const loggerWarnMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, logger: { warn: loggerWarnMock } }
})

import { loadCharacterAuraSkillDocument } from "./character-aura-context"

const AURA = {
  id: "builtin-guard",
  builtIn: true,
  name: "守卫",
  sourceNote: "",
  corpus: "",
  styleDescription: "",
  behaviorRules: "",
  boundaries: "",
  notes: "",
  skillFolder: "skills/soulskill/guard",
} as never

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.readFile.mockReset()
  fsMocks.getExecutableDir.mockReset()
  fsMocks.getResourceDir.mockReset()
  fsMocks.getExecutableDir.mockResolvedValue("C:/apps/niko")
})

describe("readSkillFileWithFallback — Tauri 探测 API 不可用", () => {
  it("Tauri 探测 API 模块不可用 + getResourceDir 失败 → 逐层降级后仍抛原始读取错误", async () => {
    fsMocks.getResourceDir.mockRejectedValue(new Error("no resource dir"))
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT: SKILL.md"))

    await expect(loadCharacterAuraSkillDocument(AURA, "/P")).rejects.toThrow("ENOENT: SKILL.md")

    // 内层 catch：fs 侧 resource dir 探测失败（line 166）
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "character-aura-context",
      expect.stringContaining("silent-degrade"),
      { line: 163 },
    )
    // 外层 catch：@tauri-apps/api/path 模块加载失败（line 182）
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "character-aura-context",
      expect.stringContaining("silent-degrade"),
      { line: 173 },
    )
  })

  it("exeDir 探测成功时仍先试 exe 侧根路径（模块不可用不短路已有根）", async () => {
    fsMocks.getResourceDir.mockRejectedValue(new Error("no resource dir"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === "C:/apps/niko/_up_/skills/soulskill/guard/SKILL.md") return "# 便携版命中"
      throw new Error("ENOENT")
    })

    await expect(loadCharacterAuraSkillDocument(AURA)).resolves.toBe("# 便携版命中")
    expect(fsMocks.readFile).toHaveBeenCalledWith("C:/apps/niko/_up_/skills/soulskill/guard/SKILL.md")
  })
})
