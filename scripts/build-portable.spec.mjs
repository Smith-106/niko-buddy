import { describe, expect, it, vi } from "vitest"
import { resolve } from "node:path"
import { buildPortable, hasZipMagicBytes, packPortableZip, resolvePortableSources } from "./build-portable.mjs"

describe("build-portable.mjs (R2-E02 release-default + fail-closed)", () => {
  const root = resolve("/workspace/QMAI")
  const releaseExe = resolve(root, "src-tauri/target/release/niko-buddy.exe")
  const releasePdfium = resolve(root, "src-tauri/target/release/pdfium/pdfium.dll")
  const devExe = resolve(root, "src-tauri/target/portable-dev/niko-buddy.exe")
  const devPdfium = resolve(root, "src-tauri/target/portable-dev/pdfium/pdfium.dll")

  it("defaults strictly to release profile even when stale portable-dev artifacts exist", () => {
    const res = resolvePortableSources({
      root,
      argv: [],
      env: {},
      exists: () => true,
    })
    expect(res.profile).toBe("release")
    expect(res.sourceExe).toBe(releaseExe)
    expect(res.sourcePdfium).toBe(releasePdfium)
    expect(res.exeCandidates).toEqual([releaseExe])
    expect(res.pdfiumCandidates).toEqual([releasePdfium])
  })

  it("selects portable-dev consistently for both exe and pdfium when --dev or PORTABLE_DEV=1 is set", () => {
    const byFlag = resolvePortableSources({ root, argv: ["--dev"], env: {}, exists: () => true })
    expect(byFlag.profile).toBe("portable-dev")
    expect(byFlag.sourceExe).toBe(devExe)
    expect(byFlag.sourcePdfium).toBe(devPdfium)

    const byEnv = resolvePortableSources({ root, argv: [], env: { PORTABLE_DEV: "1" }, exists: () => true })
    expect(byEnv.profile).toBe("portable-dev")
    expect(byEnv.sourceExe).toBe(devExe)
    expect(byEnv.sourcePdfium).toBe(devPdfium)
  })

  it("fails closed (exit 1) when target profile exe does not exist", async () => {
    const errors = []
    const cpSync = vi.fn()
    const code = await buildPortable({
      root,
      argv: [],
      env: {},
      fsOps: {
        existsSync: (p) => p === devExe, // only stale dev exe exists, release exe missing
        cpSync,
      },
      error: (m) => errors.push(m),
    })
    expect(code).toBe(1)
    expect(cpSync).not.toHaveBeenCalled()
    expect(errors.join("\n")).toContain("release")
  })

  it("fails closed (exit 1) when exe, pdfium, or skills cpSync throws", async () => {
    const skillsDir = resolve(root, "skills")
    const outExe = resolve(root, "release-portable/niko-buddy.exe")
    const outPdfium = resolve(root, "release-portable/pdfium/pdfium.dll")
    const outSkills = resolve(root, "release-portable/skills")

    const makeFs = (failDest) => ({
      existsSync: (p) => [releaseExe, releasePdfium, skillsDir].includes(p),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
      statSync: vi.fn(() => ({ size: 1024 })),
      writeFileSync: vi.fn(),
      readFile: vi.fn(async () => JSON.stringify({ version: "2.27.0" })),
      cpSync: vi.fn((_src, dest) => {
        if (dest === failDest) throw new Error(`EBUSY locked ${dest}`)
      }),
    })

    for (const failDest of [outExe, outPdfium, outSkills]) {
      const errors = []
      const fsOps = makeFs(failDest)
      const code = await buildPortable({
        root,
        argv: [],
        env: {},
        fsOps,
        log: () => {},
        warn: () => {},
        error: (m) => errors.push(m),
      })
      expect(code).toBe(1)
      expect(fsOps.writeFileSync).not.toHaveBeenCalled()
      expect(errors.join("\n")).toContain("EBUSY")
    }
  })

  it("writes version-info.json with profile metadata on full success", async () => {
    const skillsDir = resolve(root, "skills")
    const outExe = resolve(root, "release-portable/niko-buddy.exe")
    const outPdfium = resolve(root, "release-portable/pdfium/pdfium.dll")
    const outSkills = resolve(root, "release-portable/skills")
    const written = new Map()
    const copied = new Set()

    const code = await buildPortable({
      root,
      argv: [],
      env: {},
      fsOps: {
        existsSync: (p) => [releaseExe, releasePdfium, skillsDir].includes(p) || copied.has(p),
        mkdirSync: vi.fn(),
        rmSync: vi.fn(),
        renameSync: vi.fn(),
        statSync: vi.fn(() => ({ size: 42000 })),
        cpSync: vi.fn((_src, dest) => {
          copied.add(dest)
        }),
        writeFileSync: vi.fn((p, content) => {
          written.set(p, content)
        }),
        readFile: vi.fn(async () => JSON.stringify({ version: "2.27.0" })),
      },
      log: () => {},
      warn: () => {},
      error: () => {},
    })

    expect(code).toBe(0)
    expect(copied.has(outExe)).toBe(true)
    expect(copied.has(outPdfium)).toBe(true)
    expect(copied.has(outSkills)).toBe(true)
    const manifest = JSON.parse(written.get(resolve(root, "release-portable/version-info.json")))
    expect(manifest).toMatchObject({
      productName: "Niko Buddy",
      version: "2.27.0",
      profile: "release",
      sourceExe: releaseExe,
      portableExe: outExe,
      exeBytes: 42000,
      includesPdfium: true,
      includesSkills: true,
    })
  })

  it("fails closed with controlled exit code 1 when mkdir, stat, or writeFile throws", async () => {
    const baseFs = () => ({
      existsSync: (p) => p === releaseExe,
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
      cpSync: vi.fn(),
      statSync: vi.fn(() => ({ size: 1024 })),
      writeFileSync: vi.fn(),
      readFile: vi.fn(async () => JSON.stringify({ version: "2.27.0" })),
    })

    for (const [op, errMsg] of [
      ["mkdirSync", "EACCES mkdir"],
      ["statSync", "ENOENT stat"],
      ["writeFileSync", "ENOSPC writeFile"],
    ]) {
      const fsOps = baseFs()
      fsOps[op] = vi.fn(() => {
        throw new Error(errMsg)
      })
      const errors = []
      const code = await buildPortable({
        root,
        argv: [],
        env: {},
        fsOps,
        log: () => {},
        warn: () => {},
        error: (m) => errors.push(m),
      })
      expect(code).toBe(1)
      expect(errors.join("\n")).toContain(errMsg)
    }
  })

  it("packPortableZip fails closed when required files or PDFium dll are missing and accepts valid directory zip", () => {
    const outDir = resolve(root, "release-portable")
    const exe = resolve(outDir, "niko-buddy.exe")
    const manifest = resolve(outDir, "version-info.json")
    const skills = resolve(outDir, "skills")
    const pdfium = resolve(outDir, "pdfium/pdfium.dll")
    const zipOut = resolve(root, "release-github/niko-buddy_2.37.0_windows_X64_portable.zip")

    expect(hasZipMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
    expect(hasZipMagicBytes(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBe(false)

    // Missing skills/ -> fail closed
    const missingSkills = packPortableZip({
      root,
      outDir,
      zipPath: zipOut,
      exists: (p) => [exe, manifest, pdfium].includes(p),
      error: () => {},
    })
    expect(missingSkills.ok).toBe(false)
    expect(missingSkills.error).toContain("skills/")

    // Missing pdfium -> fail closed even if manifest.includesPdfium is false
    const missingPdfium = packPortableZip({
      root,
      outDir,
      zipPath: zipOut,
      exists: (p) => [exe, manifest, skills].includes(p),
      readText: () => JSON.stringify({ version: "2.37.0", includesPdfium: false }),
      error: () => {},
    })
    expect(missingPdfium.ok).toBe(false)
    expect(missingPdfium.error).toContain("pdfium/pdfium.dll")

    // Valid full directory zip with PK magic bytes -> succeeds
    const valid = packPortableZip({
      root,
      outDir,
      zipPath: zipOut,
      platform: "win32",
      exists: (p) => [exe, manifest, skills, pdfium, zipOut].includes(p),
      readText: () => JSON.stringify({ version: "2.37.0", includesPdfium: true }),
      mkdir: vi.fn(),
      rm: vi.fn(),
      runExec: vi.fn(() => ({ status: 0 })),
      stat: vi.fn(() => ({ size: 123456 })),
      open: vi.fn(() => 7),
      readBytes: vi.fn((_fd, buf) => {
        buf[0] = 0x50
        buf[1] = 0x4b
        buf[2] = 0x03
        buf[3] = 0x04
        return 4
      }),
      close: vi.fn(),
      log: () => {},
      error: () => {},
    })
    expect(valid).toEqual({ ok: true, zipPath: zipOut, bytes: 123456 })
  })
})
