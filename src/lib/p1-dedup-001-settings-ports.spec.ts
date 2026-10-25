import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  loadDefaultLlmModelListPort,
  loadDefaultScheduledImportConfigPort,
} from "@/lib/settings-ports"

/**
 * ISS-20260708-001：lib 热路径只依赖抽象/类型（依赖倒置）。
 * - scheduled-import 不再静态 import project-store 值实现
 * - settings-model-test 不再静态 import settings-model-list 值实现
 * - 缺省端口经动态 import 懒加载，保持向后兼容
 */
describe("ISS-20260708-001 settings dependency inversion", () => {
  it("scheduled-import 热路径无静态 project-store 值依赖", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/scheduled-import.ts"),
      "utf-8",
    )
    const valueImports = src
      .split("\n")
      .filter(
        (l) =>
          /from\s+["']@\/lib\/project-store["']/.test(l) &&
          !/^\s*import\s+type\b/.test(l),
      )
    expect(valueImports).toEqual([])
    // 抽象仍在：类型/端口注入
    expect(src).toContain("ScheduledImportConfigPort")
    expect(src).toContain("configPort")
  })

  it("settings-model-test 无静态 settings-model-list 值依赖", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/settings-model-test.ts"),
      "utf-8",
    )
    const valueImports = src
      .split("\n")
      .filter(
        (l) =>
          /from\s+["']@\/lib\/settings-model-list["']/.test(l) &&
          !/^\s*import\s+type\b/.test(l),
      )
    expect(valueImports).toEqual([])
    expect(src).toContain("LlmModelListPort")
  })

  it("缺省端口懒加载可用（向后兼容）", async () => {
    const port = await loadDefaultScheduledImportConfigPort()
    expect(typeof port.loadScheduledImportConfig).toBe("function")
    expect(typeof port.saveScheduledImportConfig).toBe("function")
    const listPort = await loadDefaultLlmModelListPort()
    expect(typeof listPort.fetchLlmModelList).toBe("function")
  })
});
