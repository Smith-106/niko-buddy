/** 浏览器 node:fs shim 行为测试：模块求值不崩；同步触碰即抛错，异步读走拒绝，存在性检查恒假。 */
import { describe, expect, it } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFile,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "./browser-fs-shim"

describe("browser-fs-shim 同步 API：触碰即抛错", () => {
  it("readFileSync 抛出浏览器 shim 错误", () => {
    expect(() => readFileSync()).toThrowError(
      "node:fs unavailable in browser (shim)",
    )
  })

  it("statSync 抛出浏览器 shim 错误", () => {
    expect(() => statSync()).toThrowError(
      "node:fs unavailable in browser (shim)",
    )
  })

  it("mkdtempSync 抛出浏览器 shim 错误", () => {
    expect(() => mkdtempSync()).toThrowError(
      "node:fs unavailable in browser (shim)",
    )
  })

  it("writeFileSync 抛出浏览器 shim 错误", () => {
    expect(() => writeFileSync()).toThrowError(
      "node:fs unavailable in browser (shim)",
    )
  })

  it("mkdirSync 抛出浏览器 shim 错误", () => {
    expect(() => mkdirSync()).toThrowError(
      "node:fs unavailable in browser (shim)",
    )
  })

  it("rmSync 抛出浏览器 shim 错误", () => {
    expect(() => rmSync()).toThrowError(
      "node:fs unavailable in browser (shim)",
    )
  })

  it("抛出的必须是 Error 实例而非裸字符串", () => {
    let caught: unknown
    try {
      readFileSync()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
  })
})

describe("browser-fs-shim 降级 API：求值不崩且语义固定", () => {
  it("readFile 返回拒绝态 Promise 并指明 promises shim", async () => {
    await expect(readFile()).rejects.toThrowError(
      "node:fs/promises unavailable in browser (shim)",
    )
  })

  it("existsSync 恒返回 false（浏览器无 FS 可探测）", () => {
    expect(existsSync()).toBe(false)
  })

  it("readdirSync 返回空数组（而非抛错，保证调用方遍历不崩）", () => {
    expect(readdirSync()).toEqual([])
  })

  it("readdirSync 每次返回新的空数组实例", () => {
    expect(readdirSync()).not.toBe(readdirSync())
  })
})
