import { describe, expect, it, vi } from "vitest"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"
import { resolveTauriCommand, runReleaseBuild } from "./build-release-env.mjs"

describe("build-release-env.mjs (R2-E02 Windows ENOENT & no-shell hardening)", () => {
  it("contains zero cmd.exe or env.ComSpec fallback in script source", () => {
    const src = readFileSync(new URL("./build-release-env.mjs", import.meta.url), "utf8")
    expect(src).not.toMatch(/cmd\.exe/i)
    expect(src).not.toContain("ComSpec")
    expect(src).not.toMatch(/shell\s*:\s*true/)
  })

  it("resolves local @tauri-apps/cli/tauri.js with process.execPath when present", () => {
    const root = resolve("C:/repo/QMAI")
    const localCli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js")
    const cmd = resolveTauriCommand({
      root,
      tauriArgs: ["build", "--no-bundle"],
      execPath: "C:/Program Files/nodejs/node.exe",
      exists: (p) => p === localCli,
    })
    expect(cmd).toEqual({
      cmd: "C:/Program Files/nodejs/node.exe",
      args: [localCli, "build", "--no-bundle"],
    })
  })

  it("falls back to sibling or POSIX lib npx-cli.js via execPath (zero shell) when local CLI is missing", () => {
    const winExecPath = resolve("C:/Program Files/nodejs/node.exe")
    const winNpxCli = resolve(dirname(winExecPath), "node_modules/npm/bin/npx-cli.js")
    expect(
      resolveTauriCommand({
        root: resolve("C:/repo/QMAI"),
        tauriArgs: ["build"],
        execPath: winExecPath,
        exists: (p) => p === winNpxCli,
      }),
    ).toEqual({
      cmd: winExecPath,
      args: [winNpxCli, "tauri", "build"],
    })

    const posixExecPath = resolve("/opt/node/bin/node")
    const posixNpxCli = resolve(dirname(posixExecPath), "../lib/node_modules/npm/bin/npx-cli.js")
    expect(
      resolveTauriCommand({
        root: resolve("/tmp/qmai"),
        tauriArgs: ["build", "--no-bundle"],
        execPath: posixExecPath,
        exists: (p) => p === posixNpxCli,
      }),
    ).toEqual({
      cmd: posixExecPath,
      args: [posixNpxCli, "tauri", "build", "--no-bundle"],
    })
  })

  it("fails closed with clear npm ci guidance when neither local @tauri-apps/cli nor npx-cli.js exists", () => {
    expect(() =>
      resolveTauriCommand({
        root: resolve("C:/repo/QMAI"),
        tauriArgs: ["build"],
        execPath: resolve("C:/Program Files/nodejs/node.exe"),
        exists: () => false,
      }),
    ).toThrow(/npm ci.*@tauri-apps\/cli/)

    const spawn = vi.fn()
    const errors = []
    const code = runReleaseBuild({
      argv: ["--portable"],
      root: resolve("C:/repo/QMAI"),
      env: { ComSpec: "C:\\evil\\hijack.exe" },
      execPath: resolve("C:/Program Files/nodejs/node.exe"),
      exists: () => false,
      spawn,
      log: () => {},
      error: (m) => errors.push(m),
    })
    expect(code).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(errors.join("\n")).toContain("npm ci")
  })

  it("returns exit code 2 when neither --portable nor --github-release is passed", () => {
    const spawn = vi.fn()
    const errors = []
    const code = runReleaseBuild({
      argv: [],
      spawn,
      error: (m) => errors.push(m),
    })
    expect(code).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
    expect(errors.join("\n")).toContain("usage:")
  })

  it("runs tauri build --no-bundle then build-portable in --portable mode with shell: false", () => {
    const root = resolve("/workspace/QMAI")
    const localCli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js")
    const spawn = vi.fn(() => ({ status: 0 }))
    const code = runReleaseBuild({
      argv: ["--portable"],
      root,
      env: { PATH: "/usr/bin" },
      execPath: "/node/bin/node",
      exists: (p) => p === localCli,
      spawn,
      log: () => {},
      error: () => {},
    })
    expect(code).toBe(0)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0][0]).toBe("/node/bin/node")
    expect(spawn.mock.calls[0][1]).toEqual([localCli, "build", "--no-bundle"])
    expect(spawn.mock.calls[0][2].shell).toBe(false)
    expect(spawn.mock.calls[0][2].env.CARGO_PROFILE_RELEASE_LTO).toBe("false")
    expect(spawn.mock.calls[1][0]).toBe("/node/bin/node")
    expect(spawn.mock.calls[1][1]).toEqual([resolve(root, "scripts/build-portable.mjs")])
  })

  it("checks signing key first and runs prepare-github-release in --github-release mode", () => {
    const root = resolve("/workspace/QMAI")
    const localCli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js")
    const spawn = vi.fn(() => ({ status: 0 }))
    const assertSigningKey = vi.fn()
    const code = runReleaseBuild({
      argv: ["--github-release"],
      root,
      env: {},
      execPath: "/node/bin/node",
      exists: (p) => p === localCli,
      spawn,
      assertSigningKey,
      log: () => {},
      error: () => {},
    })
    expect(code).toBe(0)
    expect(assertSigningKey).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[0][1]).toEqual([localCli, "build"])
    expect(spawn.mock.calls[0][2].env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("")
    expect(spawn.mock.calls[2][1]).toEqual([resolve(root, "scripts/prepare-github-release.mjs")])
  })

  it("aborts immediately when signing key check throws or a step fails", () => {
    const root = resolve("/workspace/QMAI")
    const localCli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js")
    const spawn = vi.fn()
    const errors = []
    expect(
      runReleaseBuild({
        argv: ["--github-release"],
        root,
        exists: (p) => p === localCli,
        spawn,
        assertSigningKey: () => {
          throw new Error("missing signing key")
        },
        error: (m) => errors.push(m),
      }),
    ).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(errors.join("\n")).toContain("missing signing key")

    const spawnErr = vi.fn(() => ({ error: new Error("ENOENT") }))
    expect(
      runReleaseBuild({
        argv: ["--portable"],
        root,
        exists: (p) => p === localCli,
        spawn: spawnErr,
        log: () => {},
        error: () => {},
      }),
    ).toBe(1)

    const spawnNonZero = vi.fn(() => ({ status: 17 }))
    expect(
      runReleaseBuild({
        argv: ["--portable"],
        root,
        exists: (p) => p === localCli,
        spawn: spawnNonZero,
        log: () => {},
        error: () => {},
      }),
    ).toBe(17)
    expect(spawnNonZero).toHaveBeenCalledTimes(1)
  })
})
