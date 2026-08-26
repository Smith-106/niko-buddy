#!/usr/bin/env node
/**
 * kappa-round2.mjs — κ Round-2 计算入口（T01b-3 共识预置）
 * 复用 corpus-kappa.ts 单一真源（computeCohenKappa / toLabelPairs / isGoldQualified）
 *
 * 用法（QMAI/ 下）：
 *   node scripts/kappa-round2.mjs --round1 docs/p0/corpus/blind-label-round2.json --round2 <同一文件，labelB 已填>
 * 输出：κ / po / pe / level / 达标判定（≥0.7=黄金集正式验收合格）
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { computeCohenKappa, toLabelPairs, isGoldQualified, kappaLevel, GOLD_QUALIFIED_KAPPA } from "../src/lib/novel/corpus-kappa.ts"

const args = process.argv.slice(2)
const i1 = args.indexOf("--round1")
const i2 = args.indexOf("--round2")
if (i1 < 0 || i2 < 0) {
  console.error("用法: node scripts/kappa-round2.mjs --round1 <round1.json> --round2 <round2.json>")
  process.exit(2)
}
const f1 = resolve(args[i1 + 1])
const f2 = resolve(args[i2 + 1])
const d1 = JSON.parse(readFileSync(f1, "utf8"))
const d2 = JSON.parse(readFileSync(f2, "utf8"))
const s1 = Array.isArray(d1) ? d1 : d1.samples
const s2 = Array.isArray(d2) ? d2 : d2.samples
if (s1.length !== s2.length) { console.error(`样本数不一致: round1=${s1.length} round2=${s2.length}`); process.exit(1) }

// round1 提供 labelA，round2 提供 labelB
const merged = s1.map((a, i) => ({
  docId: a.docId,
  layer: a.layer,
  genre: a.genre,
  filePath: a.filePath,
  labelA: a.labelA ?? a.labelB ?? null,
  labelB: s2[i].labelB ?? s2[i].labelA ?? null,
}))
const labeled = merged.filter(s => s.labelA !== null && s.labelB !== null)
const missing = merged.length - labeled.length

const result = computeCohenKappa(toLabelPairs(labeled))
const qualified = isGoldQualified(result)
const report = {
  schema: "kappa-round2/1.0",
  date: new Date().toISOString().slice(0, 10),
  n_samples: merged.length,
  n_labeled: labeled.length,
  n_missing: missing,
  kappa: result.kappa,
  po: result.po,
  pe: result.pe,
  level: result.agreement,
  threshold: GOLD_QUALIFIED_KAPPA,
  gold_qualified: qualified,
  note: qualified
    ? "κ ≥ 0.7：黄金集可进入正式验收（pending→confirmed 升级）"
    : `κ < ${GOLD_QUALIFIED_KAPPA}：不达标，分歧条目录入台账，间隔 ≥2 周排 Round-3；不静默降级、不降阈值`,
}
console.log(JSON.stringify(report, null, 2))
process.exit(qualified ? 0 : 1)
