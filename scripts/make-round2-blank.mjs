#!/usr/bin/env node
/**
 * make-round2-blank.mjs — κ Round-2 空白标注表生成（T01b-3 共识预置）
 * 读 blind-label-sample.json（Day0 采样 20 条）→ 剥离标注位 + 附加文本摘录（供标注者判断）
 * 输出：docs/p0/corpus/blind-label-round2.json（BlindSample[]：labelA/labelB 均为空待填）
 * 防污染：Round-1 标注完成前，标注者不得回看本文件中的摘录之外内容。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

const SAMPLE = resolve("docs/p0/corpus/blind-label-sample.json")
const OUT = resolve("docs/p0/corpus/blind-label-round2.json")
const LOCK = resolve("docs/p0/corpus/kappa-round1.lock.json")

const src = JSON.parse(readFileSync(SAMPLE, "utf8"))

const samples = src.samples.map((s) => {
  // 摘录原文（前 300 字），供标注者独立判断 human/ai
  let excerpt = ""
  try {
    const text = readFileSync(resolve(s.filePath), "utf8")
    excerpt = text.replace(/\s+/g, " ").slice(0, 300)
  } catch { excerpt = `[无法读取: ${s.filePath}]` }
  return {
    docId: s.docId,
    layer: s.docId.startsWith("ai/") ? "ai" : "human",
    genre: s.genre,
    filePath: s.filePath,
    excerpt,
    labelA: null, // Round-1（2026-08-23 后，执行者首次标注）
    labelB: null, // Round-2（2026-09-06 起，间隔 ≥2 周自我重标）
  }
})

// Round-1 冻结锁：样本不可变（sha256），防重标期间样本被改
const lock = {
  frozenAt: new Date().toISOString(),
  sampledCount: samples.length,
  sampleSha256: createHash("sha256").update(JSON.stringify(samples.map(s => s.docId))).digest("hex"),
  rule: "2026-09-06 起执行 Round-2：在 blind-label-round2.json 上填写 labelB（不看 labelA），随后运行 kappa-round2.mjs --round1 --round2 计算 κ。",
}

writeFileSync(OUT, JSON.stringify({ generatedAt: src.generatedAt, perGenre: src.perGenre, samples }, null, 2), "utf8")
writeFileSync(LOCK, JSON.stringify(lock, null, 2), "utf8")
console.log(`[round2] 空白表 ${samples.length} 条 → ${OUT}`)
console.log(`[round2] 冻结锁 → ${LOCK}（sha256=${lock.sampleSha256.slice(0, 16)}…）`)
