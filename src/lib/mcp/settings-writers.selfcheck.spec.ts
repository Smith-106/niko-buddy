/**
 * settings-writers 模块加载自检覆盖增补。
 *
 * `assertWritersCoverWritableKeys()` 在模块加载时执行：catalog 里 `scope: "write"`
 * 的键必须与 WRITERS 白名单互为镜像，不一致即抛错。正常 catalog 下自检静默通过，
 * throw 分支经公共 API 不可达——本文件用受控 catalog（单个无写入器的 write 键）
 * 触发它，证明自检真实有效，而非装饰代码。
 *
 * 独立文件（而非并入 settings-writers.spec.ts）：顶层 vi.mock 只影响本文件的
 * 模块注册表，不干扰既有 18 用例的真实 catalog。
 */
import { describe, expect, it, vi } from "vitest"

import type { SettingsEntry } from "./settings-catalog"

vi.mock("./settings-catalog", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./settings-catalog")>()
  const bogus: SettingsEntry = {
    key: "test-bogus-write-key",
    storage: "localStorage",
    scope: "write",
    kind: "string",
    defaultValue: null,
    label: "自检用 bogus 键（无写入器）",
    verifiedAt: "settings-writers.selfcheck.spec",
  }
  return {
    ...orig,
    SETTINGS_CATALOG: [bogus],
    SETTINGS_BY_KEY: new Map([[bogus.key, bogus]]),
  }
})

describe("settings-writers 模块加载自检", () => {
  it("catalog 含无写入器的 write 键 → 模块加载即抛错（防登记漂移）", async () => {
    await expect(import("./settings-writers")).rejects.toThrow(
      /缺少写入器.*test-bogus-write-key/,
    )
  })
})
