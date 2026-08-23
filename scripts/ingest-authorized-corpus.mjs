#!/usr/bin/env node
/**
 * ingest-authorized-corpus.mjs — 授权语料摄取（授权轨，区别于 unlicensed 隔离轨）
 *
 * 三模型共识 j3 就绪度清单落地（F4 #1-#6）：
 *   #1 参数化批次/来源/层/通道（去 unlicensed 硬编码）
 *   #2 支持 ai 层摄取（AI 辅助原创 / 授权生成 run）
 *   #3 强制 §4 license_status 六值枚举（拒收 self-authored/unlicensed-disputed 入授权批）
 *   #4 强制命名 {genre}-{NNN}.txt（genre 枚举内、3 位零填充）
 *   #5 quota 目标 100/族、硬上限 200/族，触顶写 stopping_conditions
 *   #6 授权批次 status="indexed"（打包白名单可消费；隔离批永不混淆）
 *
 * 用法：
 *   node scripts/ingest-authorized-corpus.mjs \
 *     --batch-id 20260824-yanqing-licensed \
 *     --source-dir "D:/path/to/licensed/texts" \
 *     --layer human \
 *     --license-status explicit-permission \
 *     [--genre yanqing]              # 缺省按 source-dir 一级子目录名映射 genre
 *     [--corpus-root <dir>]          # 缺省 hub 根 docs/p0/corpus；测试传临时目录
 *
 * 红线：source 路径含 "unlicensed-ref" 直接拒绝。
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// ---- CLI 解析 ----
const args = process.argv.slice(2)
function argOf(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const BATCH_ID = argOf("batch-id")
const SOURCE_DIR = argOf("source-dir")
const LAYER = argOf("layer")
const LICENSE_STATUS = argOf("license-status")
const GENRE_OVERRIDE = argOf("genre")
const CORPUS_ROOT = resolve(argOf("corpus-root") ?? resolve(process.cwd(), "../../docs/p0/corpus"))

// ---- 合规常量（manifest.template.json §4 权威枚举）----
const LICENSE_ENUM = ["public-domain", "cc0", "cc-by", "explicit-permission", "original-contributed", "rewritten-sanitized"]
const FORBIDDEN = ["unlicensed-disputed", "self-authored"]
const LAYER_ENUM = ["human", "ai"]
const GENRE_ENUM = ["yanqing", "gufeng", "xuanhuan", "xuanyi", "dushi", "kehuan", "xihuan", "lishi", "youxi", "qingxs", "qita"]
const TARGET_PER_GENRE = 100
const HARD_CAP = 200

// ---- 校验 ----
function fail(msg) {
  console.error(`[ingest-auth] ✗ ${msg}`)
  process.exit(1)
}
if (!BATCH_ID || !SOURCE_DIR || !LAYER || !LICENSE_STATUS) {
  fail("必填: --batch-id / --source-dir / --layer / --license-status")
}
if (!/^batch-\d{8}-[a-z0-9-]+$/.test(BATCH_ID)) fail(`batch-id 需形如 batch-YYYYMMDD-slug，得到: ${BATCH_ID}`)
if (!LAYER_ENUM.includes(LAYER)) fail(`--layer 仅限 ${LAYER_ENUM.join("|")}，得到: ${LAYER}`)
if (!LICENSE_ENUM.includes(LICENSE_STATUS)) fail(`--license-status 须为 §4 六值之一 ${LICENSE_ENUM.join("|")}；${FORBIDDEN.join("/")} 不允许入授权批`)
if (BATCH_ID.includes("unlicensed") || SOURCE_DIR.replace(/\\/g, "/").includes("unlicensed-ref")) {
  fail("红线：unlicensed 批次请走 ingest-local-samples.mjs 隔离轨，禁止混入授权批")
}
if (!existsSync(SOURCE_DIR)) fail(`来源目录不存在: ${SOURCE_DIR}`)

// ---- 文本处理（与隔离轨同语义：解码→清广告→切段）----
function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf) } catch { return new TextDecoder("gb18030").decode(buf) }
}
function clean(t) {
  return t.split("\n").filter(l => !/(www\.|http|\.com|\.net|笔趣阁|首发|本章未完|点击下一页|最新章节)/i.test(l)).join("\n").replace(/\r/g, "")
}
function segment(text) {
  const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 30)
  const pieces = []
  let buf = ""
  for (const p of paras) {
    if ((buf + p).length > 500 && buf.length > 200) { pieces.push(buf); buf = p }
    else buf += (buf ? "\n\n" : "") + p
    if (pieces.length >= 8) break
  }
  if (buf.length > 200 && pieces.length < 8) pieces.push(buf)
  return pieces.filter(p => p.length >= 200)
}
function walkTexts(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = resolve(dir, f)
    if (statSync(p).isDirectory()) return walkTexts(p)
    return p.endsWith(".txt") ? [p] : []
  })
}

// ---- genre 归属：override > 子目录名映射 > 单目录须显式指定 ----
const SUBDIR_MAP = { 女频: "yanqing", 言情: "yanqing", 古风: "gufeng", 仙侠: "gufeng", 武侠: "gufeng", 玄幻: "xuanhuan", 都市: "dushi", 科幻: "kehuan", 悬疑: "xuanyi", 历史: "lishi" }
let genreGroups // Map<genre, string[]>
if (GENRE_OVERRIDE) {
  if (!GENRE_ENUM.includes(GENRE_OVERRIDE)) fail(`未知 genre: ${GENRE_OVERRIDE}（枚举: ${GENRE_ENUM.join("|")}）`)
  genreGroups = new Map([[GENRE_OVERRIDE, walkTexts(SOURCE_DIR)]])
} else {
  genreGroups = new Map()
  for (const sub of readdirSync(SOURCE_DIR)) {
    const p = resolve(SOURCE_DIR, sub)
    if (!statSync(p).isDirectory()) continue
    const genre = SUBDIR_MAP[sub]
    if (!genre) { console.warn(`[ingest-auth] 跳过无法映射的子目录: ${sub}（可用 --genre 显式指定单族）`); continue }
    genreGroups.set(genre, [...(genreGroups.get(genre) ?? []), ...walkTexts(p)])
  }
  if (genreGroups.size === 0) fail("来源目录无可映射子目录且未传 --genre")
}

// ---- manifest 准备（同批次跨层增量：只替换同层条目，不抹掉另一层）----
mkdirSync(resolve(CORPUS_ROOT, LAYER, BATCH_ID), { recursive: true })
const manifestPath = resolve(CORPUS_ROOT, "manifest.json")
if (!existsSync(manifestPath)) fail(`manifest 不存在: ${manifestPath}（先在真实语料树执行，或用 --corpus-root 指向含 manifest 的树）`)
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.samples = manifest.samples.filter(s => !(s.batch_id === BATCH_ID && s.layer === LAYER))
let batch = manifest.batches.find(b => b.id === BATCH_ID)
if (!batch) {
  batch = { id: BATCH_ID, layers: [] }
  manifest.batches.push(batch)
  manifest.samples = manifest.samples.filter(s => s.batch_id !== BATCH_ID) // 新批：清残留
}
Object.assign(batch, {
  date: new Date().toISOString().slice(0, 10),
  source: SOURCE_DIR.replace(/\\/g, "/"),
  license_channel: LICENSE_STATUS,
  status: "indexed",
})
batch.layers = [...new Set([...(batch.layers ?? []), LAYER])]
// 重算 count 为全层合计
batch.count = manifest.samples.filter(s => s.batch_id === BATCH_ID).length
batch.notes = `授权语料轨（§4 ${LICENSE_STATUS}）。打包/标定仅消费 indexed 批次。`
// ---- 入库 ----
let grandTotal = 0
const stopping = []
for (const [genre, books] of genreGroups) {
  const outDir = resolve(CORPUS_ROOT, LAYER, BATCH_ID)
  let n = manifest.samples.filter(s => s.batch_id === BATCH_ID && s.genre === genre && s.layer === LAYER).length
  let written = 0
  for (const book of books.sort()) {
    if (n >= HARD_CAP) break
    try {
      for (const piece of segment(clean(decode(readFileSync(book)).slice(0, 12000)))) {
        if (n >= HARD_CAP) break
        n++; written++
        const name = `${genre}-${String(n).padStart(3, "0")}.txt`
        writeFileSync(resolve(outDir, name), piece, "utf-8")
        manifest.samples.push({
          file: `${LAYER}/${BATCH_ID}/${name}`, genre, layer: LAYER,
          words: piece.replace(/\s+/g, "").length,
          license_status: LICENSE_STATUS,
          source: `licensed:${book.replace(/\\/g, "/").split("/").pop()}`,
          batch_id: BATCH_ID,
        })
      }
    } catch { /* 解码失败跳过 */ }
  }
  grandTotal += written
  if (n >= HARD_CAP) stopping.push(`${genre}: 触及硬上限 ${HARD_CAP}/族`)
  else if (n < TARGET_PER_GENRE) stopping.push(`${genre}: 仅 ${n}<${TARGET_PER_GENRE} 达标线（缺口 ${TARGET_PER_GENRE - n}）`)
  console.log(`[ingest-auth] ${LAYER}/${genre}: ${written} 片 (累计 ${n})`)
}

const batchRef = manifest.batches.find(b => b.id === BATCH_ID)
batchRef.count = manifest.samples.filter(s => s.batch_id === BATCH_ID).length
if (stopping.length > 0) batchRef.stopping_conditions = stopping
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
console.log(`[ingest-auth] ✓ 本轮 ${grandTotal} 片 → ${LAYER}/${BATCH_ID}；批内累计 ${batchRef.count} 片 (status=indexed)`)
if (stopping.length > 0) console.log(`[ingest-auth] ⚠ stopping: ${stopping.join("; ")}`)
