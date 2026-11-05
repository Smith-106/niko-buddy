/** 浏览器 node:path shim 行为测试：纯字符串拼接实现（Windows 主力），只断言实际语义。 */
import { describe, expect, it } from "vitest"
import { basename, dirname, join, resolve } from "./browser-path-shim"

describe("browser-path-shim resolve/join：斜杠拼接并压扁重复斜杠", () => {
  it("resolve 拼接多段并用单斜杠分隔", () => {
    expect(resolve("a", "b", "c")).toBe("a/b/c")
  })

  it("resolve 压扁重复斜杠", () => {
    expect(resolve("/a//b", "c")).toBe("/a/b/c")
  })

  it("resolve 单段原样返回（仅规范化斜杠）", () => {
    expect(resolve("/a/b")).toBe("/a/b")
  })

  it("resolve 无参数返回空字符串", () => {
    expect(resolve()).toBe("")
  })

  it("resolve 保留前导斜杠", () => {
    expect(resolve("/a", "b")).toBe("/a/b")
  })

  it("join 与 resolve 同语义", () => {
    expect(join("x", "y")).toBe("x/y")
    expect(join("p//q", "r")).toBe("p/q/r")
    expect(join()).toBe("")
  })
})

describe("browser-path-shim dirname：取最后一个斜杠之前", () => {
  it("多级路径返回父目录", () => {
    expect(dirname("a/b/c")).toBe("a/b")
  })

  it("无斜杠返回 .", () => {
    expect(dirname("a")).toBe(".")
  })

  it("根下一级返回 .（i <= 0 分支）", () => {
    expect(dirname("/a")).toBe(".")
  })

  it("多级绝对路径返回父目录", () => {
    expect(dirname("/a/b")).toBe("/a")
  })

  it("空字符串返回 .", () => {
    expect(dirname("")).toBe(".")
  })
})

describe("browser-path-shim basename：取最后一个斜杠之后", () => {
  it("多级路径返回最后一段", () => {
    expect(basename("a/b/c")).toBe("c")
  })

  it("无斜杠返回自身", () => {
    expect(basename("abc")).toBe("abc")
  })

  it("末尾斜杠返回空字符串（实现只做字符串切分）", () => {
    expect(basename("a/")).toBe("")
  })

  it("不处理反斜杠：无正斜杠时原样返回", () => {
    expect(basename("a\\b")).toBe("a\\b")
  })
})
