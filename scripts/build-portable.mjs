import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function formatErr(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 解析便携版构建来源（R2-E02）：
 * - 默认严格从 `release` profile 取产物，彻底杜绝残留 `portable-dev` 盖过正式 `release` EXE；
 * - 仅显式传 `--dev` 或 `PORTABLE_DEV=1` 时切到 `portable-dev`；
 * - EXE 与 `pdfium.dll` 强制绑定同一 profile 目录，避免跨 profile 混搭。
 */
export function resolvePortableSources({
  root = DEFAULT_ROOT,
  argv = process.argv.slice(2),
  env = process.env,
  exists = existsSync,
} = {}) {
  const useDev = argv.includes("--dev") || env.PORTABLE_DEV === "1"
  const profile = useDev ? "portable-dev" : "release"
  const exeCandidates = [...new Set([resolve(root, `src-tauri/target/${profile}/niko-buddy.exe`)])]
  const pdfiumCandidates = [...new Set([resolve(root, `src-tauri/target/${profile}/pdfium/pdfium.dll`)])]
  const sourceExe = exeCandidates.find((candidate) => exists(candidate)) ?? exeCandidates[0]
  const sourcePdfium = pdfiumCandidates.find((candidate) => exists(candidate)) ?? pdfiumCandidates[0]
  return {
    profile,
    exeCandidates,
    pdfiumCandidates,
    sourceExe,
    sourcePdfium,
  }
}

/**
 * 构建便携版目录（fail-closed：缺失 EXE 或任意 cpSync 失败返回非零退出码 1）。
 */
export async function buildPortable({
  root = DEFAULT_ROOT,
  argv = process.argv.slice(2),
  env = process.env,
  fsOps = {},
  log = console.log,
  warn = console.warn,
  error = console.error,
} = {}) {
  const cp = fsOps.cpSync ?? cpSync
  const exists = fsOps.existsSync ?? existsSync
  const mkdir = fsOps.mkdirSync ?? mkdirSync
  const rm = fsOps.rmSync ?? rmSync
  const stat = fsOps.statSync ?? statSync
  const writeFile = fsOps.writeFileSync ?? writeFileSync
  const rename = fsOps.renameSync ?? renameSync
  const readFileAsync = fsOps.readFile ?? readFile

  const { profile, sourceExe, sourcePdfium } = resolvePortableSources({ root, argv, env, exists })
  const outDir = resolve(root, "release-portable")
  const outExe = resolve(outDir, "niko-buddy.exe")
  const outPdfium = resolve(outDir, "pdfium/pdfium.dll")
  const outSkillDir = resolve(outDir, "skills")
  const manifest = resolve(outDir, "version-info.json")
  const backupDir = resolve(root, "release-portable-backup")

  if (!sourceExe || !exists(sourceExe)) {
    error(`[build-portable] 未找到目标 profile (${profile}) 的 EXE，请先构建：${sourceExe ?? "(empty)"}`)
    return 1
  }

  let pkg
  try {
    pkg = JSON.parse(await readFileAsync(resolve(root, "package.json"), "utf8"))
  } catch (err) {
    error(`[build-portable] 读取 package.json 失败：${formatErr(err)}`)
    return 1
  }

  // 安全清理旧输出目录（清理本身允许因占用降级，后续拷贝失败严格 fail-closed）
  try {
    if (exists(backupDir)) {
      try {
        rm(backupDir, { recursive: true, force: true })
      } catch (err) {
        warn(`[build-portable] 清理旧备份目录失败（继续）：${formatErr(err)}`)
      }
    }

    if (exists(outDir)) {
      rename(outDir, backupDir)
      try {
        rm(backupDir, { recursive: true, force: true })
      } catch (err) {
        warn(`[build-portable] 删除备份目录失败（继续）：${formatErr(err)}`)
      }
    }
  } catch (err) {
    warn(`[build-portable] 腾挪旧便携版目录失败（将覆盖校验）：${formatErr(err)}`)
  }

  try {
    mkdir(outDir, { recursive: true })
  } catch (err) {
    error(`[build-portable] 创建便携版输出目录失败（${outDir}）：${formatErr(err)}`)
    return 1
  }

  // 复制 EXE，若目标被占用先尝试腾挪备份；拷贝失败 fail-closed 退出 1，禁止保留旧版本
  if (exists(outExe)) {
    const backupExe = resolve(outDir, "niko-buddy-old.exe")
    try {
      if (exists(backupExe)) {
        rm(backupExe, { force: true })
      }
      rename(outExe, backupExe)
    } catch (err) {
      warn(`[build-portable] 腾挪旧 EXE 失败（将由 cpSync 直接校验）：${formatErr(err)}`)
    }
  }

  try {
    cp(sourceExe, outExe)
  } catch (err) {
    error(`[build-portable] 复制便携版 EXE 失败（${sourceExe} -> ${outExe}）：${formatErr(err)}`)
    return 1
  }

  if (sourcePdfium && exists(sourcePdfium)) {
    try {
      mkdir(dirname(outPdfium), { recursive: true })
      cp(sourcePdfium, outPdfium)
    } catch (err) {
      error(`[build-portable] 复制 PDFium 动态库失败（${sourcePdfium} -> ${outPdfium}）：${formatErr(err)}`)
      return 1
    }
  }

  const sourceSkillDir = resolve(root, "skills")
  if (exists(sourceSkillDir)) {
    try {
      rm(outSkillDir, { recursive: true, force: true })
    } catch (err) {
      warn(`[build-portable] 清理旧 skills 目录失败（继续）：${formatErr(err)}`)
    }
    try {
      mkdir(outSkillDir, { recursive: true })
      cp(sourceSkillDir, outSkillDir, { recursive: true })
    } catch (err) {
      error(`[build-portable] 复制 skills 目录失败（${sourceSkillDir} -> ${outSkillDir}）：${formatErr(err)}`)
      return 1
    }
  }

  let exeStat
  try {
    exeStat = stat(outExe)
  } catch (err) {
    error(`[build-portable] 读取便携版 EXE 元信息失败（${outExe}）：${formatErr(err)}`)
    return 1
  }

  try {
    writeFile(manifest, JSON.stringify({
      productName: "Niko Buddy",
      version: pkg.version,
      profile,
      builtAt: new Date().toISOString(),
      sourceExe,
      portableExe: outExe,
      exeBytes: exeStat.size,
      includesPdfium: exists(outPdfium),
      includesSkills: exists(outSkillDir),
    }, null, 2), "utf8")
  } catch (err) {
    error(`[build-portable] 写入版本清单失败（${manifest}）：${formatErr(err)}`)
    return 1
  }

  log(`便携版已生成（${profile}）：${outExe}`)
  log(`版本信息：${manifest}`)

  const zipFlagIdx = argv.indexOf("--zip-out")
  const wantsZip = argv.includes("--zip") || zipFlagIdx >= 0 || env.PORTABLE_ZIP === "1"
  if (wantsZip) {
    const customZipPath = zipFlagIdx >= 0 && argv[zipFlagIdx + 1] ? resolve(root, argv[zipFlagIdx + 1]) : undefined
    const zipResult = packPortableZip({
      root,
      outDir,
      zipPath: customZipPath,
      pkgVersion: pkg.version,
      log,
      error,
    })
    if (!zipResult.ok) return 1
  }
  return 0
}

/**
 * 校验前 4 字节为标准 ZIP 本地文件头魔数 (`PK\x03\x04`)。
 */
export function hasZipMagicBytes(buffer) {
  return Boolean(
    buffer &&
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04,
  )
}

/**
 * 将完整的 `release-portable/` 目录打包为整目录 `.zip`（含 `niko-buddy.exe`、`pdfium/pdfium.dll`、`skills/`、`version-info.json`）。
 * fail-closed：核心文件缺失或压缩失败时返回 `{ ok: false, error }`。
 */
export function packPortableZip({
  root = DEFAULT_ROOT,
  outDir = resolve(root, "release-portable"),
  zipPath,
  pkgVersion,
  requirePdfium = true,
  platform = process.platform,
  runExec = spawnSync,
  exists = existsSync,
  stat = statSync,
  mkdir = mkdirSync,
  rm = rmSync,
  readText = readFileSync,
  open = openSync,
  readBytes = readSync,
  close = closeSync,
  log = console.log,
  error = console.error,
} = {}) {
  const exePath = resolve(outDir, "niko-buddy.exe")
  const manifestPath = resolve(outDir, "version-info.json")
  const skillsDir = resolve(outDir, "skills")
  const pdfiumPath = resolve(outDir, "pdfium/pdfium.dll")

  const requiredEntries = [
    [exePath, "niko-buddy.exe"],
    [manifestPath, "version-info.json"],
    [skillsDir, "skills/"],
  ]
  if (requirePdfium) {
    requiredEntries.push([pdfiumPath, "pdfium/pdfium.dll"])
  }

  for (const [requiredPath, label] of requiredEntries) {
    if (!exists(requiredPath)) {
      const msg = `[build-portable] 打包 ZIP 失败：缺少必需文件/目录 ${label}（${requiredPath}）`
      error(msg)
      return { ok: false, error: msg }
    }
  }

  let manifest
  try {
    manifest = JSON.parse(readText(manifestPath, "utf8"))
  } catch (err) {
    const msg = `[build-portable] 读取 version-info.json 失败：${formatErr(err)}`
    error(msg)
    return { ok: false, error: msg }
  }

  const version = pkgVersion || manifest?.version || "0.0.0"
  const targetZip = resolve(zipPath ?? resolve(outDir, `niko-buddy_${version}_windows_X64_portable.zip`))

  try {
    mkdir(dirname(targetZip), { recursive: true })
    if (exists(targetZip)) rm(targetZip, { force: true })
  } catch (err) {
    const msg = `[build-portable] 准备 ZIP 输出路径失败：${formatErr(err)}`
    error(msg)
    return { ok: false, error: msg }
  }

  const result =
    platform === "win32"
      ? runExec(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "$ErrorActionPreference='Stop'; Compress-Archive -Path (Join-Path $env:NB_PORTABLE_DIR '*') -DestinationPath $env:NB_PORTABLE_ZIP -Force",
          ],
          {
            env: { ...process.env, NB_PORTABLE_DIR: outDir, NB_PORTABLE_ZIP: targetZip },
            encoding: "utf8",
            shell: false,
          },
        )
      : runExec("zip", ["-r", "-q", targetZip, "."], {
          cwd: outDir,
          encoding: "utf8",
          shell: false,
        })

  if (result.error || result.status !== 0) {
    const detail = result.error ? formatErr(result.error) : (result.stderr || result.stdout || `exit ${result.status}`).trim()
    const msg = `[build-portable] 压缩便携版 ZIP 失败：${detail}`
    error(msg)
    return { ok: false, error: msg }
  }

  if (!exists(targetZip)) {
    const msg = `[build-portable] ZIP 未生成：${targetZip}`
    error(msg)
    return { ok: false, error: msg }
  }

  const zipStat = stat(targetZip)
  if (!zipStat || zipStat.size <= 0) {
    const msg = `[build-portable] 生成的 ZIP 为空：${targetZip}`
    error(msg)
    return { ok: false, error: msg }
  }

  const header = Buffer.alloc(4)
  const fd = open(targetZip, "r")
  try {
    readBytes(fd, header, 0, 4, 0)
  } finally {
    close(fd)
  }
  if (!hasZipMagicBytes(header)) {
    const msg = `[build-portable] 生成的 ZIP 文件头无效（非 PK\\x03\\x04）：${targetZip}`
    error(msg)
    return { ok: false, error: msg }
  }

  log(`便携版整目录 ZIP 已生成：${targetZip}（${zipStat.size} bytes）`)
  return { ok: true, zipPath: targetZip, bytes: zipStat.size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await buildPortable()
  if (code !== 0) process.exit(code)
}
