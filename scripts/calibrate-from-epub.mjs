/**
 * ISS-20260719-001: 直接从中文 epub 文本跑连续性阈值校准.
 *
 * 绕过 QMAI 生成流程产 snapshot chain 的依赖 — 角色是否在每章出现可直接
 * 从章节文本检测 (角色名是否在文本里), 推出 lastSeenChapter, 算 absent
 * gap 分布取 P75. 与 calibrate-continuity-thresholds.mjs (需 .novel/
 * snapshots + character-states store) 互补, 后者校准 QMAI 项目内样本,
 * 本脚本校准任意中文长篇 epub.
 *
 * 用法:
 *   node scripts/calibrate-from-epub.mjs <chaptersJson...> [--names name1,name2,...]
 *
 * <chaptersJson...> = 一个或多个 read_epub.py --out 产出的章节文本 JSON
 *                     (多文件 = 多卷合并校准, 每卷内独立统计 absent gap
 *                     不跨卷 — 跨卷缺席是剧情跨度非连续性断裂, 引擎
 *                     absentThresholdChapters 针对单项目内章节节奏)
 * --names 可选, 显式指定角色名 (逗号分隔). 缺省用内置 Re0 主要角色名表.
 *
 * 流程:
 *   1. 读 chapters JSON, 跳过目录/非正文章 (text 长度阈值过滤)
 *   2. 对每个角色 × 每章, 角色名 in 该章 text → 该章角色"出现"
 *   3. lastSeenChapter = 角色最后一次出现的章号 (镜像引擎 detectAbsentCharacter
 *      的 lastSeen 语义; ADR-31 additive — 不区分 lastSeen vs lastUpdated)
 *   4. absent gap 分布: 对每章 N (currentChapter), 对每角色,
 *      gap = N - lastSeenChapter (lastSeen 取 <= N 的最新), gap > 0 即角色
 *      已缺席 gap 章. 收集所有 gap > 0 样本取 P75.
 *   5. 输出候选 absentThresholdChapters + 分布统计
 *
 * 镜像 deterministic-continuity-engine.ts detectAbsentCharacter (271-296):
 *   gap = currentChapter - (c.lastSeenChapter ?? c.lastUpdatedChapter)
 *   gap > absentThresholdChapters → absent_character
 * 本脚本从文本检测的"出现章" == lastSeenChapter, gap 语义一致. 死亡角色
 * (引擎 detectDeadCharacterState 单独处理) 在 epub 校准无法识别 isAlive,
 * 故全角色纳入 (保守偏高, 与 P75 防假阳性一致).
 *
 * PAT-G2 孪生: absent gap 计算 == 引擎 detectAbsentCharacter 的 gap 公式.
 */
import { readFileSync } from "node:fs"

/** @typedef {{chapter: number, filename: string, text: string}} ChapterJson */

// Re0 主要角色名表 (中文译名变体都收录). 用户可用 --names 覆盖.
const DEFAULT_NAMES = [
  "昴",
  "雷姆",
  "拉姆",
  "爱蜜莉雅",
  "艾米莉亚",
  "帕克",
  "碧翠丝",
  "罗兹瓦尔",
  "菲鲁特",
  "威尔海姆",
  "库珐",
  "由里乌斯",
  "尤里乌斯",
  "普莉希拉",
  "克莱因",
]

// Re0 贯穿剧情线索关键词表 (作 subplot.title 代理). 每个关键词 = 一条伏笔/
// 副线, 引擎 detectDormantThread 检测其 lastSeenChapter (关键词最后出现章),
// gap = currentChapter - lastSeen > threshold 产 dormant_thread. 镜像引擎
// deriveSubplotLastSeenChapter (413-430) 的 includes(subplot.title) 逻辑 —
// epub 章节正文是 snapshot summary 的超集, 同样可做关键词出现检测.
// 用户可用 --subplots 覆盖.
const DEFAULT_SUBPLOT_KEYWORDS = [
  "魔女教",
  "圣域",
  "强欲",
  "嫉妒",
  "暴食",
  "傲慢",
  "愤怒",
  "色欲",
  "契约",
  "诅咒",
  "贤者",
  "试炼",
  "死亡回归",
  "半精灵",
  "多娜",
  "书信",
]

const MIN_CHAPTER_TEXT_LEN = 200 // 跳过目录/版权页等非正文"章"

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return undefined
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1
  return sortedValues[Math.max(0, Math.min(idx, sortedValues.length - 1))]
}

function main() {
  // 收集所有非 --names/--subplots 的位置参数作 chaptersJson (支持多卷合并)
  const namesArgIdx = process.argv.indexOf("--names")
  const subplotsArgIdx = process.argv.indexOf("--subplots")
  const argv = process.argv.slice(2)
  const chaptersJsonPaths = argv.filter(
    (a, i) => a !== "--names" && a !== "--subplots" && argv[i - 1] !== "--names" && argv[i - 1] !== "--subplots",
  )
  if (chaptersJsonPaths.length === 0) {
    console.error("Usage: node scripts/calibrate-from-epub.mjs <chaptersJson...> [--names name1,...] [--subplots kw1,...]")
    process.exit(1)
  }

  let names = DEFAULT_NAMES
  if (namesArgIdx !== -1 && process.argv[namesArgIdx + 1]) {
    names = process.argv[namesArgIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
  }

  let subplotKeywords = DEFAULT_SUBPLOT_KEYWORDS
  if (subplotsArgIdx !== -1 && process.argv[subplotsArgIdx + 1]) {
    subplotKeywords = process.argv[subplotsArgIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
  }

  // 合并多卷, 但每卷内独立统计 absent gap (不跨卷 — 跨卷缺席是剧情跨度
  // 非连续性断裂). 每卷章号从该卷正文起始章连续编号 (卷1: 1..N1,
  // 卷2: 1..N2, ...), 角色出现/缺席只在卷内算 gap.
  const perVolumeChapters = []
  for (const path of chaptersJsonPaths) {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    const filtered = raw
      .filter((c) => c.text.length >= MIN_CHAPTER_TEXT_LEN)
      .sort((a, b) => a.chapter - b.chapter)
    // 卷内重编号: 正文起始章=1, 后续递增
    if (filtered.length > 0) {
      const base = filtered[0].chapter
      const renumbered = filtered.map((c) => ({ ...c, chapter: c.chapter - base + 1 }))
      perVolumeChapters.push(renumbered)
    }
  }
  const totalChapters = perVolumeChapters.reduce((s, v) => s + v.length, 0)

  if (totalChapters < 10) {
    console.warn(`WARN: 仅 ${totalChapters} 章正文, 校准需 50+ 章样本, 结果不稳定`)
  }

  console.log(`Loaded ${totalChapters} 正文章 from ${perVolumeChapters.length} 卷 (每卷内独立统计 gap, 不跨卷)`)

  const allChapters = perVolumeChapters.flat().sort((a, b) => a.chapter - b.chapter)
  console.log(`校准角色 (${names.length}): ${names.join(", ")}`)

  // absent gap 分布: 每卷内独立算. 对每卷, 对每角色 × 每章,
  //   lastSeen = 角色在该卷 <= N 的最新出现章号
  //   gap = N - lastSeen, gap > 0 即角色在 N 章缺席了 gap 章
  const absences = []
  const perCharacterGaps = new Map()
  for (const name of names) {
    perCharacterGaps.set(name, [])
  }
  for (const volChapters of perVolumeChapters) {
    // 每卷的角色出现章号集合
    const presenceByChapter = new Map()
    for (const name of names) presenceByChapter.set(name, new Set())
    for (const ch of volChapters) {
      for (const name of names) {
        if (ch.text.includes(name)) presenceByChapter.get(name).add(ch.chapter)
      }
    }
    // 每卷内算 gap
    for (const name of names) {
      const presentChapters = [...presenceByChapter.get(name)].sort((a, b) => a - b)
      for (const ch of volChapters) {
        if (presentChapters.length === 0) continue
        let lastSeen
        for (const pc of presentChapters) {
          if (pc <= ch.chapter) lastSeen = pc
          else break
        }
        if (lastSeen === undefined) continue
        const gap = ch.chapter - lastSeen
        if (gap > 0) {
          absences.push(gap)
          perCharacterGaps.get(name).push(gap)
        }
      }
    }
  }

  const absentSorted = absences.sort((a, b) => a - b)
  const absentP75 = percentile(absentSorted, 75)

  console.log(`\n=== 角色缺席分布 (absent_character) — 镜像引擎 detectAbsentCharacter gap ===`)
  console.log(`样本数: ${absentSorted.length}`)
  if (absentSorted.length > 0) {
    console.log(`分布: min=${absentSorted[0]} max=${absentSorted[absentSorted.length - 1]}`)
    console.log(`P50=${percentile(absentSorted, 50)} P75=${absentP75} P90=${percentile(absentSorted, 90)}`)
  } else {
    console.log(`WARN: 无缺席样本`)
  }

  console.log(`\n=== 每角色缺席 gap 分布 ===`)
  for (const name of names) {
    const gaps = perCharacterGaps.get(name).sort((a, b) => a - b)
    if (gaps.length > 0) {
      const p75 = percentile(gaps, 75)
      console.log(`  ${name}: 样本${gaps.length} min=${gaps[0]} max=${gaps[gaps.length - 1]} P75=${p75}`)
    }
  }

  // dormant gap 分布: 每卷内独立算 (不跨卷, 同 absent). 对每卷, 对每关键词 × 每章,
  //   lastSeen = 关键词在该卷 <= N 的最新出现章号 (镜像引擎 deriveSubplotLastSeenChapter
  //   413-430 的 includes(subplot.title) 逻辑 — epub 正文是 snapshot summary 超集)
  //   gap = N - lastSeen, gap > 0 即线索在 N 章休眠了 gap 章.
  //   镜像引擎 detectDormantThread (245-280): gap > threshold 产 dormant_thread.
  //   注: 引擎 resolveDormantThreshold = max(3, floor(total*0.02)) 比例保底,
  //   校准统计 gap 分布取 P75 作候选绝对值 (dormantThresholdChapters 字段).
  //   已 resolved 的 subplot 引擎跳过 — epub 无法判断线索 resolved, 故全纳入
  //   (保守偏高, 与 P75 防假阳性一致).
  const dormancies = []
  const perKeywordGaps = new Map()
  for (const kw of subplotKeywords) {
    perKeywordGaps.set(kw, [])
  }
  for (const volChapters of perVolumeChapters) {
    const presenceByChapter = new Map()
    for (const kw of subplotKeywords) presenceByChapter.set(kw, new Set())
    for (const ch of volChapters) {
      for (const kw of subplotKeywords) {
        if (ch.text.includes(kw)) presenceByChapter.get(kw).add(ch.chapter)
      }
    }
    for (const kw of subplotKeywords) {
      const presentChapters = [...presenceByChapter.get(kw)].sort((a, b) => a - b)
      for (const ch of volChapters) {
        if (presentChapters.length === 0) continue
        let lastSeen
        for (const pc of presentChapters) {
          if (pc <= ch.chapter) lastSeen = pc
          else break
        }
        if (lastSeen === undefined) continue
        const gap = ch.chapter - lastSeen
        if (gap > 0) {
          dormancies.push(gap)
          perKeywordGaps.get(kw).push(gap)
        }
      }
    }
  }

  const dormantSorted = dormancies.sort((a, b) => a - b)
  const dormantP75 = percentile(dormantSorted, 75)

  console.log(`\n=== 线索休眠分布 (dormant_thread) — 镜像引擎 detectDormantThread gap ===`)
  console.log(`样本数: ${dormantSorted.length}`)
  if (dormantSorted.length > 0) {
    console.log(`分布: min=${dormantSorted[0]} max=${dormantSorted[dormantSorted.length - 1]}`)
    console.log(`P50=${percentile(dormantSorted, 50)} P75=${dormantP75} P90=${percentile(dormantSorted, 90)}`)
  } else {
    console.log(`WARN: 休眠样本`)
  }

  console.log(`\n=== 每关键词休眠 gap 分布 ===`)
  for (const kw of subplotKeywords) {
    const gaps = perKeywordGaps.get(kw).sort((a, b) => a - b)
    if (gaps.length > 0) {
      const p75 = percentile(gaps, 75)
      console.log(`  ${kw}: 样本${gaps.length} min=${gaps[0]} max=${gaps[gaps.length - 1]} P75=${p75}`)
    }
  }

  console.log(`\n=== 候选阈值 (手动替换 DEFAULT_CONTINUITY_CONFIG) ===`)
  console.log(JSON.stringify({
    dormantThresholdChapters: dormantP75 ?? 3,
    absentThresholdChapters: absentP75 ?? 5,
    absentSampleCount: absentSorted.length,
    dormantSampleCount: dormantSorted.length,
    note: "P75 保守偏高防假阳性 (GRL-011 Risk 3); 直接从 epub 文本检测角色/关键词出现推 lastSeenChapter, gap 公式镜像引擎 detectAbsentCharacter (289-296) + detectDormantThread (245-280); 死亡角色/已 resolved subplot epub 无法识别故全纳入 (保守); 引擎 resolveDormantThreshold = max(3, floor(total*0.02)) 比例保底, 校准 P75 作绝对值候选; 需 >=3 本合并统计后替换默认值 5/3",
  }, null, 2))
}

main()
