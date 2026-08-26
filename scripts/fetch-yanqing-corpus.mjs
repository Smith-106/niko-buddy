#!/usr/bin/env node
/**
 * fetch-yanqing-corpus.mjs — 言情语料采集（T01b-1 yanqing 缺口 15→30）
 *
 * 来源：www.xswang.com（笔趣阁镜像；终裁 §5.2 所有文本视为授权）
 * 流程：书目录页 → 章节页 → 提取 qsbs.bb(base64) → 解码 → 清洗 → 输出 yanqing-NNN.txt
 *
 * 用法：node scripts/fetch-yanqing-corpus.mjs --books 107155,<id2> [--per-book 6] [--out <dir>]
 */
import { writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
function argOf(name, fallback = "") {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const BOOKS = argOf("books", "").split(",").filter(Boolean)
const PER_BOOK = Number(argOf("per-book", "6")) || 6
const OUT_DIR = resolve(argOf("out", "docs/p0/corpus/_staging-t01b1/yanqing"))
const BASE = "https://www.xswang.com"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: BASE } })
  return r.ok ? await r.text() : ""
}

function decodeChapter(html) {
  const out = []
  const re = /qsbs\.bb\('([A-Za-z0-9+/=]+)'\)/g
  let m
  while ((m = re.exec(html))) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf8")
      const text = decoded
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&ldquo;/g, "“")
        .replace(/&rdquo;/g, "”")
        .replace(/&hellip;/g, "…")
        .replace(/&mdash;/g, "—")
        .replace(/&amp;/g, "&")
      out.push(text.trim())
    } catch { /* skip */ }
  }
  return out.filter(Boolean).join("\n\n")
}

async function chapterList(bookId) {
  const html = await get(`${BASE}/book/${bookId}/`)
  const links = []
  const re = new RegExp(`href="/book/${bookId}/(\\d+)\\.html"[^>]*>([^<]+)`, "g")
  let m
  while ((m = re.exec(html))) links.push({ id: m[1], title: m[2].trim() })
  return links
}

let n = 0
async function main() {
  if (!BOOKS.length) { console.error("需 --books 书 id 列表（逗号分隔）"); process.exit(1) }
  mkdirSync(OUT_DIR, { recursive: true })
  const existing = new Set(readdirSync(OUT_DIR))
  for (const bookId of BOOKS) {
    const links = await chapterList(bookId)
    console.log(`[${bookId}] 章节数: ${links.length} | 前 3 章: ${links.slice(0, 3).map(l => l.title).join(" / ")}`)
    for (const { id } of links.slice(0, PER_BOOK)) {
      const html = await get(`${BASE}/book/${bookId}/${id}.html`)
      const text = decodeChapter(html)
      if (text.length < 200) { console.log(`  skip ${id}（正文过短 ${text.length}）`); continue }
      const paras = text.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 30)
      const pieces = []
      let buf = ""
      for (const p of paras) {
        if ((buf + p).length > 500 && buf.length > 200) { pieces.push(buf); buf = p }
        else buf += (buf ? "\n\n" : "") + p
      }
      if (buf.length > 200) pieces.push(buf)
      for (const piece of pieces.slice(0, 2)) {
        n++
        const name = `yanqing-${String(n).padStart(3, "0")}.txt`
        if (existing.has(name)) continue
        writeFileSync(join(OUT_DIR, name), piece, "utf8")
      }
      console.log(`  ✓ ${bookId}/${id}: ${text.length} 字 → ${pieces.length} 段`)
      await new Promise(r => setTimeout(r, 800))
    }
  }
  console.log(`[fetch-yanqing] 完成: ${n} 篇 → ${OUT_DIR}`)
}

main().catch(e => { console.error(e.message); process.exit(1) })
