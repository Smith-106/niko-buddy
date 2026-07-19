/**
 * ISS-20260719-001: 连续性检测阈值中文校准脚本框架。
 *
 * 用法:
 *   node scripts/calibrate-continuity-thresholds.mjs <projectPath> [--p75]
 *
 * <projectPath> = 已用 QMAI 跑过完整生成、产出 .novel/snapshots/*.snapshot.json
 *                 的中文长篇项目目录 (非裸 epub — deriveSubplotLastSeenChapter
 *                 需 ChapterSnapshot 结构: summary + characterStateChanges +
 *                 foreshadowingChanges, 由 QMAI 生成流程产出, 非原始 epub 文本)。
 *
 * 流程:
 *   1. 扫描 .novel/snapshots/*.snapshot.json, 构造 ChapterSnapshot[]
 *   2. 对每个 subplot (从 foreshadowing-tracker / subplot-board store 读),
 *      跑 deriveSubplotLastSeenChapter fold 反推 lastSeenChapter
 *   3. 统计休眠分布 (currentChapter - lastSeenChapter 直方图)
 *   4. 取 P75 分位作候选值 (保守偏高防假阳性, 守 GRL-011 Risk 3 mitigation)
 *   5. 同步角色缺席分布 (currentChapter - lastUpdatedChapter)
 *
 * 输出: 候选阈值 JSON (dormantThresholdChapters / absentThresholdChapters),
 *       供手动替换 DEFAULT_CONTINUITY_CONFIG (deterministic-continuity-engine.ts)。
 *
 * 状态: 框架就绪, 待用户提供 >=3 本中文长篇 QMAI 项目样本 (50+ 章/本, 群像/
 *       慢热/快节奏各一) 跑校准。当前 DEFAULT_CONTINUITY_CONFIG 沿用默认值标
 *       [需校准-样本不足]。
 *
 * PAT-G2 孪生镜像: deriveSubplotLastSeenChapterInline 镜像
 * deterministic-continuity-engine.ts:397-414 纯函数逻辑。引擎逻辑变更须同步
 * (校准脚本是线下工具, 不走 TS import 因 QMAI 无预编译产物, 守 calibrate-
 * review-weights.mjs 自包含模式)。
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const SNAPSHOT_GLOB = /\.snapshot\.json$/

/**
 * 镜像 deterministic-continuity-engine.ts:397-414 deriveSubplotLastSeenChapter。
 * 纯函数: subplot + snapshots → lastSeenChapter (反向遍历降序, 文本 includes
 * subplot.title 的最新章号)。PAT-G2 孪生 — 引擎变更须同步。
 */
function deriveSubplotLastSeenChapterInline(subplot, snapshots) {
  const sorted = [...snapshots].sort((a, b) => b.chapterNumber - a.chapterNumber)
  for (const snap of sorted) {
    const haystack = [
      snap.summary,
      ...(snap.characterStateChanges || []),
      ...(snap.foreshadowingChanges || []),
    ].join("\n")
    if (haystack.includes(subplot.title)) {
      return snap.chapterNumber
    }
  }
  return undefined
}

function loadSnapshots(projectPath) {
  const dir = join(projectPath, ".novel", "snapshots")
  let files
  try {
    files = readdirSync(dir).filter((f) => SNAPSHOT_GLOB.test(f))
  } catch {
    console.error(`ERROR: snapshots dir not found: ${dir}`)
    console.error("项目需先用 QMAI 跑完整生成产出 snapshot chain。裸 epub 无法直接校准。")
    process.exit(1)
  }
  const snapshots = []
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"))
      if (typeof raw.chapterNumber === "number") {
        snapshots.push(raw)
      }
    } catch (e) {
      console.error(`skip ${f}: ${e.message}`)
    }
  }
  return snapshots.sort((a, b) => a.chapterNumber - b.chapterNumber)
}

function loadSubplots(projectPath) {
  // subplot-board store: .novel/subplot-board.json (createAtomicJsonStore 派生路径)
  const candidates = ["subplot-board.json", "subplots.json"]
  for (const name of candidates) {
    try {
      const raw = JSON.parse(readFileSync(join(projectPath, ".novel", name), "utf8"))
      const list = raw.subplots || raw.items || raw
      if (Array.isArray(list)) return list
    } catch {}
  }
  console.warn("WARN: subplot store 未找到, 校准跳过休眠分布统计")
  return []
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return undefined
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1
  return sortedValues[Math.max(0, Math.min(idx, sortedValues.length - 1))]
}

function main() {
  const projectPath = process.argv[2]
  if (!projectPath) {
    console.error("Usage: node scripts/calibrate-continuity-thresholds.mjs <projectPath> [--p75]")
    process.exit(1)
  }

  const snapshots = loadSnapshots(projectPath)
  console.log(`Loaded ${snapshots.length} snapshots (chapters ${snapshots[0]?.chapterNumber}-${snapshots[snapshots.length - 1]?.chapterNumber})`)

  if (snapshots.length < 20) {
    console.warn(`WARN: 仅 ${snapshots.length} 章, 阈值校准需 50+ 章样本, 结果不稳定`)
  }

  const subplots = loadSubplots(projectPath)

  // 休眠分布: 对每个 subplot, 每个 currentChapter 计算 (currentChapter - lastSeenChapter)
  const dormancies = []
  for (const subplot of subplots) {
    if (!subplot?.title) continue
    for (const snap of snapshots) {
      const lastSeen = deriveSubplotLastSeenChapterInline(subplot, snapshots.filter((s) => s.chapterNumber <= snap.chapterNumber))
      if (lastSeen !== undefined) {
        dormancies.push(snap.chapterNumber - lastSeen)
      }
    }
  }

  // 角色缺席分布: currentChapter - lastUpdatedChapter (character-state store)
  const absences = []
  // TODO: 角色缺席需读 character-state store + per-character lastUpdatedChapter,
  //   框架待补 (需确认 character-state store 路径与结构, 详见
  //   deterministic-continuity-engine.ts absent_character 检测逻辑)

  const dormantSorted = dormancies.filter((d) => d >= 0).sort((a, b) => a - b)
  const dormantP75 = percentile(dormantSorted, 75)

  console.log(`\n=== 休眠分布 (dormant_thread) ===`)
  console.log(`样本数: ${dormantSorted.length}`)
  console.log(`分布: min=${dormantSorted[0]} max=${dormantSorted[dormantSorted.length - 1]}`)
  console.log(`P75 候选 dormantThresholdChapters: ${dormantP75}`)
  console.log(`\n=== 角色缺席分布 (absent_character) ===`)
  console.log(`TODO: 待补 character-state store 读取逻辑`)

  console.log(`\n=== 候选阈值 (手动替换 DEFAULT_CONTINUITY_CONFIG) ===`)
  console.log(JSON.stringify({
    dormantThresholdChapters: dormantP75 ?? 3,
    absentThresholdChapters: 5, // 待角色缺席统计补齐后替换
    note: "P75 保守偏高防假阳性; 单本样本不足, 需 >=3 本合并统计后替换",
  }, null, 2))
}

main()
