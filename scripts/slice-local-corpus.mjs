#!/usr/bin/env node
/**
 * slice-local-corpus.mjs — 本地网文 txt 切段入库（T01b-1 言情补足，本地源优先）
 *
 * 来源：E:\写作_old\网文\400+本高质量完本合集（用户本地合集；终裁 §5.2 视为授权）
 * 流程：GB18030/UTF-8 自动解码 → 章节切分 → 500 字段 → {genre}-NNN.txt
 *
 * 用法：node scripts/slice-local-corpus.mjs --src <dir> --genre yanqing [--out <dir>] [--count 40] [--skip <子串,子串>]
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const args = process.argv.slice(2)
function argOf(name, fallback = "") {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const SRC = resolve(argOf("src", ""))
const GENRE = argOf("genre", "yanqing")
const OUT_DIR = resolve(argOf("out", "docs/p0/corpus/_staging-t01b1/" + GENRE))
const COUNT = Number(argOf("count", "40")) || 40
const SKIP = argOf("skip", "").split(",").filter(Boolean)

function decode(buf) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf) }
  catch { return new TextDecoder("gb18030").decode(buf) }
}

function clean(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (const l of lines) {
    const t = l.trim()
    if (!t) continue
    if (/^(作者|整理|校对|排版|仅供|免责|版权|转自|首发|www\.|http|QQ群|微信公众号|本书)/i.test(t)) continue
    out.push(t)
  }
  return out.join("\n")
}

function splitChapters(text) {
  const re = /第\s*[0-9一二三四五六七八九十百千]+[章卷][^\n]{0,24}/g
  const marks = [...text.matchAll(re)]
  if (marks.length < 2) return [text]
  const parts = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length
    const body = text.slice(start + marks[i][0].length, end)
    if (body.replace(/\s/g, "").length >= 200) parts.push(body)
  }
  return parts
}

function cutSegments(chapters, targetLen = 500) {
  const pieces = []
  for (const ch of chapters) {
    const paras = ch.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 30)
    let buf = ""
    let fromThisChapter = 0
    for (const p of paras) {
      if ((buf + p).length > targetLen && buf.length > 200) {
        pieces.push(buf)
        buf = p
        fromThisChapter++
        if (fromThisChapter >= 3) break
      } else {
        buf += (buf ? "\n\n" : "") + p
      }
    }
    if (buf.length > 200 && fromThisChapter < 3) pieces.push(buf)
  }
  return pieces.filter(p => p.length >= 200)
}

function walkTxt(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walkTxt(p, acc)
    else if (p.endsWith(".txt")) acc.push(p)
  }
  return acc
}

let n = 0
// 续写模式：out 已有文件则从最大序号继续（多书均衡采集）
if (existsSync(OUT_DIR)) {
  for (const f of readdirSync(OUT_DIR)) {
    const m = f.match(/(\d{3})\.txt$/)
    if (m) n = Math.max(n, Number(m[1]))
  }
}
const TOTAL = COUNT + n // 续写时总目标 = 新批次数量 + 已有
function main() {
  if (!SRC || !existsSync(SRC)) { console.error(`--src 不存在: ${SRC}`); process.exit(1) }
  mkdirSync(OUT_DIR, { recursive: true })
  const files = walkTxt(SRC)
  console.log(`[slice-local] 扫描 ${SRC}: ${files.length} 本 txt`)
  for (const f of files) {
    if (SKIP.some(s => f.includes(s))) continue
    const text = clean(decode(readFileSync(f)))
    const pieces = segmentsFromChapterSplit(text)
    for (const piece of pieces) {
      if (n >= TOTAL) break
      n++
      writeFileSync(join(OUT_DIR, `${GENRE}-${String(n).padStart(3, "0")}.txt`), piece, "utf8")
    }
    console.log(`  ✓ ${f.split(/[\\/]/).pop().slice(0, 44)}: → ${pieces.length} 段（累计 ${n}/${TOTAL}）`)
    if (n >= TOTAL) break
  }
  console.log(`[slice-local] 完成: ${n} 段 → ${OUT_DIR}`)
}

function segmentsFromChapterSplit(text) {
  const chapters = splitChapters(text)
  return segmentsFromChapters(chapters)
}

function segmentsFromChapters(chapters) {
  return chapters.flatMap(ch => {
    const paras = ch.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 30)
    const pieces = []
    let buf = ""
    let fromThisChapter = 0
    for (const p of paras) {
      if ((buf + p).length > 500 && buf.length > 200) {
        pieces.push(buf)
        buf = p
        fromThisChapter++
        if (fromThisChapter >= 3) break
      } else {
        buf += (buf ? "\n\n" : "") + p
      }
    }
    if (buf.length > 200 && fromThisChapter < 3) pieces.push(buf)
    return pieces
  }).filter(p => p.length >= 200)
}

main().catch(e => { console.error(e.message); process.exit(1) })

