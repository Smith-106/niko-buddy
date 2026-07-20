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
 *   5. 同步角色缺席分布 (currentChapter - (lastSeenChapter ?? lastUpdatedChapter),
 *      排除死亡角色 isAlive===false)
 *
 * 输出: 候选阈值 JSON (dormantThresholdChapters / absentThresholdChapters),
 *       供手动替换 DEFAULT_CONTINUITY_CONFIG (deterministic-continuity-engine.ts)。
 *
 * 状态: 双分布统计就绪 (dormant_thread + absent_character 两条腿), 待用户提供
 *       >=3 本中文长篇 QMAI 项目样本 (50+ 章/本, 群像/慢热/快节奏各一) 跑校准。
 *       当前 DEFAULT_CONTINUITY_CONFIG 沿用默认值标 [需校准-样本不足]。
 *       (absent 分布已排除死亡角色 isAlive===false, 引擎 detectDeadCharacterState
 *       单独处理; lastSeenChapter 优先回退 lastUpdatedChapter 守 ADR-31 additive。)
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

/**
 * 镜像 character-state.ts loadCharacterStates + 引擎 detectAbsentCharacter
 * (deterministic-continuity-engine.ts:271-296) 的 lastSeen 优先回退逻辑。
 * store 路径: .novel/character-states.json → { characters: CharacterState[] }
 * CharacterState 含 characterName (必填) + lastUpdatedChapter (必填) +
 * lastSeenChapter? (ADR-31 Phase 4 deferred 可选)。引擎判缺席:
 *   gap = currentChapter - (c.lastSeenChapter ?? c.lastUpdatedChapter)
 *   gap > absentThresholdChapters → absent_character
 * 校准统计所有 character × currentChapter 的 gap 分布取 P75 (镜像 dormant 分布逻辑)。
 */
function loadCharacterStates(projectPath) {
  try {
    const raw = JSON.parse(readFileSync(join(projectPath, ".novel", "character-states.json"), "utf8"))
    const list = raw.characters || raw
    if (Array.isArray(list)) return list
  } catch {}
  console.warn("WARN: character-states store 未找到, 校准跳过角色缺席分布统计")
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

  // 角色缺席分布: 镜像引擎 detectAbsentCharacter (engine.ts:271-296)
  // 对每个 character, 每个 currentChapter 计算
  //   gap = currentChapter - (c.lastSeenChapter ?? c.lastUpdatedChapter)
  // (lastSeenChapter 优先, undefined 回退 lastUpdatedChapter, 守 ADR-31 additive)
  // gap 分布取 P75 作 absentThresholdChapters 候选。死亡角色 (isAlive===false 或
  // deathChapter 存在) 排除 — 引擎 detectDeadCharacterState 单独处理, 不进缺席统计。
  const characters = loadCharacterStates(projectPath)
  const absences = []
  for (const c of characters) {
    if (!c?.characterName) continue
    if (c.isAlive === false) continue // 死亡角色排除 (引擎 detectDeadCharacterState 处理)
    const lastSeen = c.lastSeenChapter ?? c.lastUpdatedChapter
    if (typeof lastSeen !== "number") continue
    for (const snap of snapshots) {
      const gap = snap.chapterNumber - lastSeen
      if (gap >= 0) absences.push(gap)
    }
  }

  const dormantSorted = dormancies.filter((d) => d >= 0).sort((a, b) => a - b)
  const dormantP75 = percentile(dormantSorted, 75)
  const absentSorted = absences.filter((d) => d >= 0).sort((a, b) => a - b)
  const absentP75 = percentile(absentSorted, 75)

  console.log(`\n=== 休眠分布 (dormant_thread) ===`)
  console.log(`样本数: ${dormantSorted.length}`)
  console.log(`分布: min=${dormantSorted[0]} max=${dormantSorted[dormantSorted.length - 1]}`)
  console.log(`P75 候选 dormantThresholdChapters: ${dormantP75}`)
  console.log(`\n=== 角色缺席分布 (absent_character) ===`)
  console.log(`样本数: ${absentSorted.length}`)
  if (absentSorted.length > 0) {
    console.log(`分布: min=${absentSorted[0]} max=${absentSorted[absentSorted.length - 1]}`)
    console.log(`P75 候选 absentThresholdChapters: ${absentP75}`)
  } else {
    console.log(`WARN: 无角色缺席样本 (character-states store 缺失或角色全无 lastUpdatedChapter)`)
  }

  console.log(`\n=== 候选阈值 (手动替换 DEFAULT_CONTINUITY_CONFIG) ===`)
  console.log(JSON.stringify({
    dormantThresholdChapters: dormantP75 ?? 3,
    absentThresholdChapters: absentP75 ?? 5,
    note: "P75 保守偏高防假阳性; 单本样本不足, 需 >=3 本合并统计后替换; " +
          "absent 已排除死亡角色 (isAlive===false), 引擎 detectDeadCharacterState 单独处理",
  }, null, 2))
}

main()
