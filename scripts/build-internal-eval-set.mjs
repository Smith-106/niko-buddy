#!/usr/bin/env node
// build-internal-eval-set.mjs — B1 内部非同源一致性集生成器（批准计划 r3 §T3）。
//
// 目的：为参考库检索面（通道 B）提供**非同源**、可复跑、规则导出的义务召回评测集。
// 口径（治理知识对齐，见门控报告首段声明）：
//   - 裁决范围 = 「内部非同源一致性」，**不构成第三方裁决、不构成跨系统裁决**；
//   - **不是 real 门锚点**（real 门 case 来自真实 canon 抽取 source="real"），本集 source="reference-library-self-built"；
//   - 主指标 = 义务召回率（gold 条目是否被召回到 topK）；**不使用 MRR/NDCG**（spec:project:arch-decisions-071 Step1）。
//
// 两层分工（同 R-1/R1-d 先例）：本脚本 = IO/规则层（展开 fixture、解析 qrels、断言、--check）；
// 判定核 = src/lib/novel/internal-eval-set.spec.ts（TS，真实跑 routeByQueryIntent/tokensForKbMatch/rankByBm25）。
// token 非退化断言在 TS 侧（本脚本无法 import TS）；本脚本做结构代理断言（非空 + ≥2 CJK 字符）。
//
// 用法：
//   node scripts/build-internal-eval-set.mjs --expand   # 从视图+golden 展开出 fixture（internal-eval-queries.json）
//   node scripts/build-internal-eval-set.mjs            # 从 fixture 解析 qrels -> internal-eval-set.generated.json
//   node scripts/build-internal-eval-set.mjs --check    # 重新解析并与落盘产物字节比对（漂移即 FAIL）
// 退出码：0 通过；1 漂移/断言失败；3 输入缺失或非法。ASCII only 输出（防 PS 乱码）。

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const VIEW = join(ROOT, "src/lib/novel/kb/kb-routing-view.generated.json")
const GOLDEN = join(ROOT, "src/lib/novel/__fixtures__/golden-queries.json")
const FIXTURE = join(ROOT, "src/lib/novel/kb/internal-eval-queries.json")
const GENERATED = join(ROOT, "src/lib/novel/kb/internal-eval-set.generated.json")

const args = process.argv.slice(2)
const mode = args.includes("--expand") ? "expand" : args.includes("--check") ? "check" : "derive"

/** 义务面：只有这三类 collection 作为 gold（排除 corpus 范文面与 tech/quarantine/blocked）。 */
const GOLD_COLLECTIONS = ["world_ref", "lexicon", "craft"]
const INTENTS = ["plan", "draft", "revise", "lookup", "style"]
const GENRE_BY_PREFIX = [
  ["xianxia-", "修仙"],
  ["cthulhu-", "克苏鲁"],
  ["fantasy-", "奇幻"],
  ["wuxia-", "武侠"],
  ["scifi-", "科幻"],
]
const THRESHOLDS = { topK: 3, top20: 20, minTop3Lower: 0.7, minTop20Lower: 0.9 }

function fail(code, msg) {
  console.error(`[internal-eval-set] FAIL(${code}): ${msg}`)
  process.exit(code)
}

function readJson(path, label) {
  if (!existsSync(path)) fail(3, `${label} 缺失：${path}`)
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    fail(3, `${label} 解析失败：${e.message}`)
  }
}

function stable(value) {
  return JSON.stringify(value, null, 2) + "\n"
}

function genreOf(name, collection) {
  for (const [prefix, genre] of GENRE_BY_PREFIX) if (name.startsWith(prefix)) return genre
  return collection === "craft" ? "写作技巧" : "其他"
}

/** 与 golden-34 文本的重叠判定（非同源硬约束）：精确相等，或双方任一侧≥ 6 字符时互为子串。
 * 返回命中的 golden 文本（无则 null）。 */
function goldenCollision(query, goldenTexts) {
  const q = query.toLowerCase()
  if (goldenTexts.has(q)) return q
  for (const g of goldenTexts) {
    if (g.length >= 6 && (q.includes(g) || g.includes(q))) return g
  }
  return null
}

/** 展开规则：T1 标题探针 / T2 domain 探针 / T3 genre+domain 探针（world_ref+lexicon）/
 * T4 name 拉丁面探针（含英文词路径）/ T5 purpose 头部探针（指向字段，去 CC0 标记）。
 * 多面探针 = 同一义务多条词面（标题面近义、domain 面判别、genre 面跨流派、拉丁面分词路径、purpose 面指针字段）。
 * 与 golden-34 撞文本的行不静默丢弃：记入 droppedGoldenCollisions 审计清单。 */
function expandQueries(view, goldenTexts) {
  const cols = view.collections ?? {}
  const entries = []
  for (const collection of GOLD_COLLECTIONS) {
    for (const entry of cols[collection] ?? []) entries.push({ collection, entry })
  }
  const rows = []
  const dropped = []
  const droppedDegenerate = []
  const push = (query, meta) => {
    const q = String(query ?? "").replace(/\s+/g, " ").trim()
    if (!q) return
    // 退化探针剔除：去重后段数 < 2 = 单 token 查询（无判别力），记入审计清单
    const segments = new Set(q.split(" ").filter(Boolean))
    if (segments.size < 2) {
      droppedDegenerate.push({ query: q, gold: meta.gold, derivation: meta.derivation })
      return
    }
    rows.push({ query: q, ...meta })
  }
  entries.forEach(({ collection, entry }, index) => {
    const name = String(entry.name ?? "")
    const title = String(entry.title ?? name)
    const domain = Array.isArray(entry.domain) ? entry.domain.map(String) : []
    const genre = genreOf(name, collection)
    const allowed = INTENTS.filter((i) => (view.routing?.agent?.[i] ?? []).includes(collection))
    if (allowed.length === 0) fail(1, `collection ${collection} 无任何 intent 可路由（矩阵与义务面不一致）`)
    const intent = allowed[index % allowed.length]
    const base = { intent, expectedCollection: collection, gold: name, genre }
    push(`${title} ${domain[0] ?? genre}`, { ...base, derivation: "title-probe" })
    push(domain.length > 0 ? domain.join(" ") : `${genre} ${title}`, {
      ...base,
      derivation: "domain-probe",
    })
    if (collection === "world_ref" || collection === "lexicon") {
      const rest = domain.slice(1)
      push(`${genre} ${rest.length > 0 ? rest.join(" ") : domain[0] ?? title}`, {
        ...base,
        derivation: "genre-domain-probe",
      })
    }
    // T4：name 拉丁面（去分隔符）—— 覆盖英文分词路径（golden-34 为中文面，非同源）
    push(`${name.replace(/[-_]/g, " ")} ${genre}`, { ...base, derivation: "name-probe" })
    // T5：purpose 头部（去「（自建 CC0…）」标注与括号尾段）—— 指针字段面
    const purposeHead = String(entry.purpose ?? "")
      .replace(/[（(][^）)]*[）)]/g, "")
      .trim()
    push(purposeHead ? `${purposeHead} ${genre}` : `${title} ${genre}`, {
      ...base,
      derivation: "purpose-probe",
    })
  })
  // 去重（同 query 只保留首条）；撞 golden-34 文本的行移入 dropped（审计可查，不静默）
  const seen = new Set()
  const unique = []
  for (const row of rows) {
    if (seen.has(row.query)) continue
    seen.add(row.query)
    const collide = goldenCollision(row.query, goldenTexts)
    if (collide) {
      dropped.push({ query: row.query, gold: row.gold, derivation: row.derivation, golden: collide })
      continue
    }
    unique.push(row)
  }
  unique.sort(
    (a, b) =>
      a.derivation.localeCompare(b.derivation) ||
      a.gold.localeCompare(b.gold) ||
      a.query.localeCompare(b.query),
  )
  dropped.sort((a, b) => a.query.localeCompare(b.query))
  droppedDegenerate.sort((a, b) => a.query.localeCompare(b.query))
  return { unique, dropped, droppedDegenerate }
}

/** 硬断言（fixture 与 qrels 同口径）。 */
function assertSet(queries, view) {
  if (queries.length < 200) {
    fail(1, `N=${queries.length} < 200（治理口径 spec:project:arch-decisions-071 Step1）`)
  }
  const genres = new Set(queries.map((q) => q.genre))
  if (genres.size < 4) fail(1, `流派数 ${genres.size} < 4`)
  const corpusNames = new Set((view.collections?.corpus ?? []).map((e) => String(e.name)))
  const goldenQueries = readJson(GOLDEN, "golden-queries.json")
  const goldenTexts = new Set(
    (goldenQueries.queries ?? []).map((q) =>
      String(q.query).replace(/\s+/g, " ").trim().toLowerCase(),
    ),
  )
  for (const row of queries) {
    if (corpusNames.has(row.gold)) fail(1, `gold 落 corpus 集合（禁止）：${row.gold}`)
    const q = row.query.toLowerCase()
    if (goldenCollision(row.query, goldenTexts) !== null) {
      fail(1, `query 与 golden-34 文本重叠（非同源性破坏）：${row.query}`)
    }
    const cjk = (row.query.match(/[\u4e00-\u9fa5]/g) ?? []).length
    if (cjk < 2) fail(1, `query 结构退化（<2 CJK 字符）：${row.query}`)
    if (!(view.collections?.[row.expectedCollection] ?? []).some((e) => String(e.name) === row.gold)) {
      fail(1, `gold 不在视图中：${row.gold}`)
    }
    if (!(view.routing?.agent?.[row.intent] ?? []).includes(row.expectedCollection)) {
      fail(1, `intent ${row.intent} 不可路由到 ${row.expectedCollection}（qrels 与最终矩阵不一致）`)
    }
  }
  return { genres: [...genres].sort(), goldenCount: goldenTexts.size }
}

function derive(fixture, view) {
  const { queries } = fixture
  const byGenre = {}
  const byIntent = {}
  const byCollection = {}
  const byDerivation = {}
  for (const q of queries) {
    byGenre[q.genre] = (byGenre[q.genre] ?? 0) + 1
    byIntent[q.intent] = (byIntent[q.intent] ?? 0) + 1
    byCollection[q.expectedCollection] = (byCollection[q.expectedCollection] ?? 0) + 1
    byDerivation[q.derivation] = (byDerivation[q.derivation] ?? 0) + 1
  }
  return {
    schemaVersion: 1,
    source: "reference-library-self-built",
    adjudicationScope: "internal-non-same-source-consistency",
    notThirdParty: true,
    notRealGateAnchor: true,
    builtFrom: view.builtFrom,
    provenance: {
      view: "kb-routing-view.generated.json",
      fixture: "internal-eval-queries.json",
      goldenReference: "__fixtures__/golden-queries.json",
      rule: "title/domain/genre-domain 三探针，qrels 由条目身份规则导出（非人工标注、非第三方标注）",
    },
    thresholds: THRESHOLDS,
    counts: { total: queries.length, byGenre, byIntent, byCollection, byDerivation },
    queries,
  }
}

// ---------------------------------------------------------------------------

const view = readJson(VIEW, "kb-routing-view.generated.json")

if (mode === "expand") {
  const goldenQueries = readJson(GOLDEN, "golden-queries.json")
  const goldenTexts = new Set(
    (goldenQueries.queries ?? []).map((q) =>
      String(q.query).replace(/\s+/g, " ").trim().toLowerCase(),
    ),
  )
  const { unique, dropped, droppedDegenerate } = expandQueries(view, goldenTexts)
  const info = assertSet(unique, view)
  writeFileSync(
    FIXTURE,
    stable({
      schemaVersion: 1,
      builtFrom: view.builtFrom,
      droppedGoldenCollisions: dropped,
      droppedDegenerateProbes: droppedDegenerate,
      queries: unique,
    }),
    "utf8",
  )
  console.log(
    `[internal-eval-set] EXPAND OK: N=${unique.length} genres=${info.genres.length} golden=${info.goldenCount} droppedGolden=${dropped.length} droppedDegenerate=${droppedDegenerate.length}`,
  )
  process.exit(0)
}

const fixture = readJson(FIXTURE, "internal-eval-queries.json")
const info = assertSet(fixture.queries, view)
const generated = derive(fixture, view)

if (mode === "check") {
  if (!existsSync(GENERATED)) fail(1, "产物缺失：internal-eval-set.generated.json（先跑一次不带 --check）")
  if (readFileSync(GENERATED, "utf8") !== stable(generated)) {
    fail(1, "产物与重新解析结果不一致（漂移：视图/qrels 或产物被手改）")
  }
  console.log(
    `[internal-eval-set] CHECK OK: N=${generated.counts.total} genres=${info.genres.length} builtFrom=${generated.builtFrom}`,
  )
  process.exit(0)
}

writeFileSync(GENERATED, stable(generated), "utf8")
console.log(
  `[internal-eval-set] DERIVE OK: N=${generated.counts.total} genres=${JSON.stringify(generated.counts.byGenre)} builtFrom=${generated.builtFrom}`,
)
