import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs"
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
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await buildPortable()
  if (code !== 0) process.exit(code)
}
