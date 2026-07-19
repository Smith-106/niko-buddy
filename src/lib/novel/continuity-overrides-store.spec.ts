/**
 * continuity-overrides-store.spec.ts — 连续性 override 持久化薄包装测试
 *
 * 覆盖 ADR-29 Route B-1 sibling 装配器薄包装:
 *   - createEmptyContinuityOverrideStore: 空工厂 lastUpdated="" (非 new Date 模块级)
 *   - saveContinuityOverrides: 落盘 + 设 lastUpdated=ISO timestamp (运行时求值)
 *   - loadContinuityOverrides: 读盘降级空 store (文件不存在/损坏)
 *   - dismissFinding: writehook load → push → save 闭环
 *
 * 守 PAT-G2 mock mirror: vi.mock("@/commands/fs") factory 须 mirror 全 export
 * (readFile/writeFileAtomic/createDirectory/fileExists), 与 emotion-ledger.spec 同模式。
 * 守 CWE-22: relativePath 'continuity-overrides.json' 字面量非用户输入 (createAtomicJsonStore
 * 内部 normalizePath 派生路径, SEC-1 路径守卫复用)。
 * 守 fold_rebuildable: load 失败降级空 store 不抛错。
 * 守 CWE-532: override note 字段全脱敏不引用正文 (本测试只验结构不验内容语义)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { resolve } from "node:path"
import {
  createEmptyContinuityOverrideStore,
  saveContinuityOverrides,
  loadContinuityOverrides,
  dismissFinding,
} from "./continuity-overrides-store"
import type {
  ContinuityOverride,
} from "./deterministic-continuity-engine"

// vi.hoisted: 内存文件系统 mock (与 emotion-ledger.spec 同模式)
const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const k = String(p).replace(/\\/g, "/")
      if (!files.has(k)) throw new Error(`ENOENT: ${p}`)
      return files.get(k)!
    }),
    writeFileAtomic: vi.fn(async (p: string, c: string) => {
      files.set(String(p).replace(/\\/g, "/"), c)
    }),
    createDirectory: vi.fn(async () => {}),
    fileExists: vi.fn(async () => true),
  }
})

// PAT-G2 mock mirror: factory 须 mirror 全 export (readFile/writeFileAtomic/createDirectory/fileExists)
vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
}))

const PROJECT_PATH = resolve(__dirname, "test-project")

function makeOverride(over: Partial<ContinuityOverride> = {}): ContinuityOverride {
  return {
    ref: "character:死者",
    reasonCode: "intentional_death",
    note: "设计性死亡后回忆出场",
    severity: "critical",
    dismissedAtChapter: 10,
    ...over,
  }
}

describe("continuity-overrides-store (ADR-29 Route B-1 sibling 薄包装)", () => {
  beforeEach(() => {
    fsMocks.files.clear()
    fsMocks.readFile.mockClear()
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
    fsMocks.fileExists.mockClear()
  })

  describe("createEmptyContinuityOverrideStore", () => {
    it("空 store lastUpdated 为空字符串 (非 new Date 模块级求值)", () => {
      const store = createEmptyContinuityOverrideStore()
      expect(store.overrides).toEqual([])
      expect(store.lastUpdated).toBe("")
    })

    it("每次调用返回新对象 (非单例共享)", () => {
      const a = createEmptyContinuityOverrideStore()
      const b = createEmptyContinuityOverrideStore()
      expect(a).not.toBe(b)
      a.overrides.push({ ...makeOverride() })
      expect(b.overrides).toEqual([])
    })
  })

  describe("saveContinuityOverrides + loadContinuityOverrides round-trip", () => {
    it("save 落盘 .novel/continuity-overrides.json + load 读回一致", async () => {
      const store = createEmptyContinuityOverrideStore()
      store.overrides.push(makeOverride({ ref: "character:甲" }))
      await saveContinuityOverrides(PROJECT_PATH, store)

      // 验证 createDirectory 被调 (守 SEC-1 路径守卫)
      expect(fsMocks.createDirectory).toHaveBeenCalledWith(
        `${PROJECT_PATH.replace(/\\/g, "/")}/.novel`,
      )
      // 验证 writeFileAtomic 被调到正确路径
      expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
      const [writtenPath] = fsMocks.writeFileAtomic.mock.calls[0]
      expect(writtenPath).toContain(".novel/continuity-overrides.json")

      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides).toHaveLength(1)
      expect(loaded.overrides[0].ref).toBe("character:甲")
      expect(loaded.overrides[0].reasonCode).toBe("intentional_death")
    })

    it("save 时设 lastUpdated = ISO timestamp (运行时求值非空)", async () => {
      const store = createEmptyContinuityOverrideStore() // lastUpdated=""
      expect(store.lastUpdated).toBe("")
      await saveContinuityOverrides(PROJECT_PATH, store)
      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      // save 在函数内设 lastUpdated (运行时求值, 非 new Date 模块级坑)
      expect(loaded.lastUpdated).not.toBe("")
      expect(new Date(loaded.lastUpdated).getTime()).not.toBeNaN()
    })

    it("load 文件不存在降级空 store 不抛错 (fold_rebuildable)", async () => {
      // 未 save, 内存文件系统无对应文件
      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides).toEqual([])
      expect(loaded.lastUpdated).toBe("")
      expect(fsMocks.readFile).toHaveBeenCalledTimes(1)
    })

    it("load 文件损坏 (JSON.parse 失败) 降级空 store 不抛错", async () => {
      const pp = PROJECT_PATH.replace(/\\/g, "/")
      fsMocks.files.set(`${pp}/.novel/continuity-overrides.json`, "{invalid json")
      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides).toEqual([])
      expect(loaded.lastUpdated).toBe("")
    })

    it("save 覆盖旧内容 (多次 save 取最新)", async () => {
      const store1 = createEmptyContinuityOverrideStore()
      store1.overrides.push(makeOverride({ ref: "character:甲" }))
      await saveContinuityOverrides(PROJECT_PATH, store1)

      const store2 = createEmptyContinuityOverrideStore()
      store2.overrides.push(makeOverride({ ref: "character:乙" }))
      await saveContinuityOverrides(PROJECT_PATH, store2)

      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides).toHaveLength(1)
      expect(loaded.overrides[0].ref).toBe("character:乙")
    })
  })

  describe("dismissFinding (writehook load → push → save 闭环)", () => {
    it("dismiss 单个 finding push 到 override store + 落 dismissedAtChapter", async () => {
      const override = makeOverride({ ref: "character:死者", severity: "warning" })
      await dismissFinding(PROJECT_PATH, override, 15)

      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides).toHaveLength(1)
      expect(loaded.overrides[0].ref).toBe("character:死者")
      expect(loaded.overrides[0].dismissedAtChapter).toBe(15)
      expect(loaded.overrides[0].severity).toBe("warning")
    })

    it("多次 dismiss 累加到 overrides 数组 (跨检测持久追溯 ADR-34)", async () => {
      await dismissFinding(PROJECT_PATH, makeOverride({ ref: "character:甲" }), 10)
      await dismissFinding(PROJECT_PATH, makeOverride({ ref: "character:乙" }), 12)

      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides).toHaveLength(2)
      // sort() 按码点排序 (乙 < 甲), 比较无序集合用 toContain + length
      expect(loaded.overrides.map((o) => o.ref)).toContain("character:甲")
      expect(loaded.overrides.map((o) => o.ref)).toContain("character:乙")
    })

    it("type 层守卫: severity='info' 禁止 dismiss (data_gap 不允许 override)", async () => {
      // info 级 override 入参类型层拒绝 — 本测试验证 warning/critical 正常落盘
      // info 级 dismiss 由 review-adapter 调用方守卫 (ContinuityOverride.severity 类型 'warning'|'critical')
      const override = makeOverride({ severity: "critical", reasonCode: "intentional_death" })
      await dismissFinding(PROJECT_PATH, override, 20)
      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      expect(loaded.overrides[0].severity).toBe("critical")
    })
  })

  describe("CWE-532 全脱敏守恒", () => {
    it("override 结构只存 ref+reasonCode+note+severity+chapter (不引用正文原文)", async () => {
      const override = makeOverride({ note: "设计性死亡后回忆出场 (全脱敏不引用正文)" })
      await dismissFinding(PROJECT_PATH, override, 10)
      const loaded = await loadContinuityOverrides(PROJECT_PATH)
      const persisted = loaded.overrides[0]
      // 验证只持久化结构化字段, 无 finding 原文 / 正文片段
      expect(persisted).toHaveProperty("ref")
      expect(persisted).toHaveProperty("reasonCode")
      expect(persisted).toHaveProperty("note")
      expect(persisted).toHaveProperty("severity")
      expect(persisted).toHaveProperty("dismissedAtChapter")
      // 不应持久化 finding.message / evidence / 正文内容
      expect((persisted as any).message).toBeUndefined()
      expect((persisted as any).evidence).toBeUndefined()
    })
  })
})
