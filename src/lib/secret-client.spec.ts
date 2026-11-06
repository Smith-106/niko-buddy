/**
 * secret-client.spec.ts — B3 凭据链前端封装的单元契约。
 *
 * 覆盖：
 *   - 引用解析/写入目标派生（与 Rust `resolve_credential_ref`/`normalize_service` 同判）；
 *   - 三个已接线命令的 IPC 形态（secret_available / secret_put / secret_delete）；
 *   - 失败不被吞掉（错误原样上抛，由面板显示）。
 *
 * 注意：本 spec 不、也不能断言任何 secret 值进入缓存/日志——接口本身不提供读取面
 * （`secret_get` 刻意不在本模块封装，见 ipc-surface-contract.spec.ts 白名单）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

import {
  CREDENTIAL_REF_PREFIX,
  DEFAULT_SECRET_DOMAIN,
  GITHUB_CREDENTIAL_REF_PREFIX,
  GITHUB_SECRET_DOMAIN,
  defaultCredentialAccount,
  githubCredentialRef,
  githubSecretDelete,
  githubSecretPut,
  isGitHubCredentialRef,
  parseCredentialRef,
  resolveCredentialTarget,
  resolveCredentialTargetForDomain,
  secretAvailable,
  secretDelete,
  secretPut,
} from "./secret-client"

beforeEach(() => {
  invokeMock.mockReset()
})

describe("parseCredentialRef", () => {
  it("解析 nb:<domain>:<account>，domain 归一为小写", () => {
    expect(parseCredentialRef("nb:webdav:proj-42")).toEqual({ domain: "webdav", account: "proj-42" })
    expect(parseCredentialRef(" nb:WebDAV:Proj-42 ")).toEqual({ domain: "webdav", account: "Proj-42" })
  })

  it("account 段允许含冒号（与 Rust split_once 同判）", () => {
    expect(parseCredentialRef("nb:webdav:a:b:c")).toEqual({ domain: "webdav", account: "a:b:c" })
  })

  it("拒绝缺前缀 / 缺段 / 非法 domain / 空 account", () => {
    expect(parseCredentialRef("webdav:proj-42")).toBeNull()
    expect(parseCredentialRef("nb:webdav")).toBeNull()
    expect(parseCredentialRef("nb::proj")).toBeNull()
    expect(parseCredentialRef("nb:bad/domain:proj")).toBeNull()
    expect(parseCredentialRef("nb:webdav:")).toBeNull()
    expect(parseCredentialRef("")).toBeNull()
  })

  it("前缀常量与 Rust SECRET_SERVICE_PREFIX 同值", () => {
    expect(CREDENTIAL_REF_PREFIX).toBe("nb:")
  })
})

describe("defaultCredentialAccount", () => {
  it("取项目目录名并消毒为 [A-Za-z0-9_-]", () => {
    expect(defaultCredentialAccount("/p/mybook")).toBe("mybook")
    expect(defaultCredentialAccount("C:\\books\\My Novel!")).toBe("MyNovel")
    expect(defaultCredentialAccount("/p/proj_1-x")).toBe("proj_1-x")
  })

  it("无法得名时回退 'project'", () => {
    expect(defaultCredentialAccount("/")).toBe("project")
    expect(defaultCredentialAccount("")).toBe("project")
    expect(defaultCredentialAccount("/p/中文目录")).toBe("project")
  })

  it("projectPath 缺失（渲染冒烟路径）不抛错", () => {
    expect(defaultCredentialAccount(undefined)).toBe("project")
    expect(defaultCredentialAccount(null)).toBe("project")
  })
})

describe("resolveCredentialTarget", () => {
  it("已有合法引用 → 复用其 domain/account（轮换凭据不改引用）", () => {
    expect(resolveCredentialTarget("nb:webdav:proj-42", "/p/other")).toEqual({
      domain: "webdav",
      account: "proj-42",
    })
  })

  it("无/非法引用 → 默认域 + 项目名派生账户", () => {
    expect(resolveCredentialTarget("", "/p/mybook")).toEqual({
      domain: DEFAULT_SECRET_DOMAIN,
      account: "mybook",
    })
    expect(resolveCredentialTarget("garbage", "/p/mybook")).toEqual({
      domain: "webdav",
      account: "mybook",
    })
  })
})

describe("IPC 封装（secret_* 命令形态）", () => {
  it("secretAvailable → invoke('secret_available') 无参", async () => {
    invokeMock.mockResolvedValueOnce(true)
    await expect(secretAvailable()).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("secret_available")
  })

  it("secretPut → service/account/secret 三参，返回引用且不含值", async () => {
    invokeMock.mockResolvedValueOnce("nb:webdav:proj-42")
    const secret = "user:top-secret-value"
    const ref = await secretPut("webdav", "proj-42", secret)
    expect(invokeMock).toHaveBeenCalledWith("secret_put", {
      service: "webdav",
      account: "proj-42",
      secret,
    })
    expect(ref).toBe("nb:webdav:proj-42")
    expect(ref).not.toContain("top-secret-value")
  })

  it("secretDelete → invoke('secret_delete') 返回是否删除既有条目", async () => {
    invokeMock.mockResolvedValueOnce(false)
    await expect(secretDelete("webdav", "proj-42")).resolves.toBe(false)
    expect(invokeMock).toHaveBeenCalledWith("secret_delete", {
      service: "webdav",
      account: "proj-42",
    })
  })

  it("失败原样上抛（面板可见，不静默吞错）", async () => {
    invokeMock.mockRejectedValueOnce("[secret_store] OS keyring unavailable")
    await expect(secretPut("webdav", "proj", "secret")).rejects.toBe(
      "[secret_store] OS keyring unavailable",
    )
    invokeMock.mockRejectedValueOnce("[secret_store] delete failed")
    await expect(secretDelete("webdav", "proj")).rejects.toBe("[secret_store] delete failed")
    invokeMock.mockRejectedValueOnce("probe down")
    await expect(secretAvailable()).rejects.toBe("probe down")
  })
})

describe("G1 GitHub 凭据域（nb:github）", () => {
  it("githubCredentialRef 拼出 nb:github:<account> 并裁掉首尾空白", () => {
    expect(GITHUB_CREDENTIAL_REF_PREFIX).toBe("nb:github:")
    expect(githubCredentialRef("  niko  ")).toBe("nb:github:niko")
    // 产出必须被 isGitHubCredentialRef 认可（配置期硬门自洽）
    expect(isGitHubCredentialRef(githubCredentialRef("niko"))).toBe(true)
    expect(isGitHubCredentialRef(` ${githubCredentialRef("niko")} `)).toBe(true)
    expect(isGitHubCredentialRef("nb:webdav:niko")).toBe(false)
    expect(isGitHubCredentialRef("")).toBe(false)
  })

  it("githubSecretPut 落到 github 域且返回值只含引用、不回显 token", async () => {
    invokeMock.mockResolvedValueOnce("nb:github:niko")
    const token = "ghp_top_secret_token"
    const ref = await githubSecretPut("niko", token)

    expect(GITHUB_SECRET_DOMAIN).toBe("github")
    expect(invokeMock).toHaveBeenCalledWith("secret_put", {
      service: "github",
      account: "niko",
      secret: token,
    })
    expect(ref).toBe("nb:github:niko")
    expect(ref).not.toContain(token)
  })

  it("githubSecretDelete 落到 github 域并返回是否删除既有条目", async () => {
    invokeMock.mockResolvedValueOnce(true)
    await expect(githubSecretDelete("niko")).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("secret_delete", {
      service: "github",
      account: "niko",
    })

    invokeMock.mockResolvedValueOnce(false)
    await expect(githubSecretDelete("niko")).resolves.toBe(false)
  })

  it("GitHub 写入/删除失败原样上抛（由调用方关闭传输目标，不静默回退明文）", async () => {
    invokeMock.mockRejectedValueOnce("[secret_store] keyring locked")
    await expect(githubSecretPut("niko", "tok")).rejects.toBe("[secret_store] keyring locked")
    invokeMock.mockRejectedValueOnce("[secret_store] keyring locked")
    await expect(githubSecretDelete("niko")).rejects.toBe("[secret_store] keyring locked")
  })
})

describe("resolveCredentialTargetForDomain（按目标域解析，跨域旧引用不复用）", () => {
  it("同域引用原样复用（轮换凭据时引用不变）", () => {
    expect(
      resolveCredentialTargetForDomain("github", "nb:github:niko", "/p/mybook"),
    ).toEqual({ domain: "github", account: "niko" })
  })

  it("跨域引用改写为目标域 + 项目名派生账户（绝不复用旧域）", () => {
    expect(
      resolveCredentialTargetForDomain("github", "nb:webdav:proj-42", "/p/my book!"),
    ).toEqual({ domain: "github", account: "mybook" })
  })

  it("无引用/非法引用回退目标域 + 项目名派生账户", () => {
    expect(resolveCredentialTargetForDomain("github", "", "/p/mybook")).toEqual({
      domain: "github",
      account: "mybook",
    })
    expect(resolveCredentialTargetForDomain("github", "webdav:proj", "/p/mybook")).toEqual({
      domain: "github",
      account: "mybook",
    })
  })
})
