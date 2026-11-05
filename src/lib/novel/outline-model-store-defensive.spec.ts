import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * outline-model-store 的「绝不抛异常」最后一道网（R-03 兜底分支）。
 *
 * `loadOutlineModel` 在形状闸 + 迁移之后调用 `validateOutlineModel` 并 try/catch。
 * 纯 JSON.parse 产物（无 getter、无 Proxy）下校验器不会抛错，所以该 catch 在生产
 * 输入下不可达 —— 它防的是**跨模块契约变化**（校验器日后改成抛错实现）。
 *
 * 这里用 vi.mock 把校验器注入成「抛错实现」，验证契约本身：
 * loadOutlineModel 必须仍然 resolve，且把抛错归一化为 `模型校验抛错：...`，
 * 绝不把异常泄漏给调用方（消费方以 model === null 回退旧文本路径）。
 */
const validatorMock = vi.hoisted(() => ({
  shouldThrow: false,
  message: "validator exploded (simulated)",
}))

vi.mock("./outline-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outline-model")>()
  return {
    ...actual,
    validateOutlineModel: (model: Parameters<typeof actual.validateOutlineModel>[0]) => {
      if (validatorMock.shouldThrow) throw new Error(validatorMock.message)
      return actual.validateOutlineModel(model)
    },
  }
})

import { OUTLINE_MODEL_SCHEMA_VERSION, outlineChapterId, type OutlineModel } from "./outline-model"
import { loadOutlineModel, type OutlineModelStoreDeps } from "./outline-model-store"

function buildModel(): OutlineModel {
  return {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    updatedAt: "2026-11-05",
    volumes: [
      {
        number: 1,
        title: "启程",
        arc: "少年出山",
        chapters: [
          {
            id: outlineChapterId(1, 1),
            volume: 1,
            chapter: 1,
            title: "断桥",
            pov: "",
            arc: "",
            entities: [],
            foreshadow: { plant: [], payoff: [] },
            constraints: [],
            prose: { goal: "", scenes: [], emotion: "" },
            updatedAt: "2026-11-05",
          },
        ],
      },
    ],
  }
}

const readDeps = (raw: string): OutlineModelStoreDeps => ({ readText: async () => raw })

describe("outline-model-store 校验器抛错兜底（绝不抛异常契约）", () => {
  beforeEach(() => {
    validatorMock.shouldThrow = false
  })

  it("校验器抛错 → load resolves，model 为 null 且 error 含「模型校验抛错」与原因", async () => {
    validatorMock.shouldThrow = true

    const pending = loadOutlineModel("/P", readDeps(JSON.stringify(buildModel())))
    await expect(pending).resolves.toMatchObject({ model: null })
    const result = await pending

    expect(result.error).toContain("模型校验抛错")
    expect(result.error).toContain(validatorMock.message)
  })

  it("对照：校验器未抛错时同一输入照常返回模型（证明上一条不是“永远 null”）", async () => {
    const result = await loadOutlineModel("/P", readDeps(JSON.stringify(buildModel())))

    expect(result.error).toBeUndefined()
    expect(result.model?.volumes[0].chapters[0].title).toBe("断桥")
  })
})
