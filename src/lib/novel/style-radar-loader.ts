/**
 * style-radar-loader.ts — 风格雷达的**真实数据入口**（唯一读盘处）。
 *
 * 投影层（`style-radar-projection.ts`）保持纯函数；本文件负责把它需要的数据从项目里取出来：
 *   1. 当前章正文：`.novel/chapters/{n}/draft.md`（Draft-first 的正式正文落点）；
 *   2. 当前章号：`.novel/status.json` 的 `current_task.chapter_number`（运行时唯一真源）；
 *   3. 目标节奏：章纲里的定位子弹（`- 压力级：3` / `- 情绪强度：7`）；解析不到 → 投影侧落 N/A。
 *
 * 任一步读取失败都不编数据：缺正文 → 投影给空态；缺章号 → 只读不到正文；缺定位 → N/A。
 * 不读 `BookStyleProfile`（那要用户先选作品库），因此目标风格文本默认 N/A。
 *
 * @license MIT © Niko Buddy
 */

import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

import { readChapterOutlineContent } from "./context-engine-outline"
import { loadNovelSessionStatus } from "./novel-session-status"
import type { StyleRadarInput } from "./style-radar-projection"

/** 正式正文路径（Draft-first 落点）。 */
export function chapterDraftPath(projectPath: string, chapterNumber: number): string {
  return `${normalizePath(projectPath)}/.novel/chapters/${chapterNumber}/draft.md`
}

/**
 * 从**章纲**的定位子弹里取目标节奏（章纲模板是 `- 压力级：1-5` / `- 情绪强度：1-10`）。
 *
 * 不用卷纲分布表：那张表只出现在卷纲，章纲正文里没有；拿章纲去套卷纲表必然 N/A。
 * 解析失败一律 `null`（投影侧落 N/A），**不**默认 1。
 */
export function parseOutlinePositionBullets(outline: string): {
  pressureLevel: number | null
  emotionIntensity: number | null
} {
  const pick = (label: RegExp, min: number, max: number): number | null => {
    const match = outline.match(label)
    if (!match) return null
    const value = Number.parseInt(match[1] ?? "", 10)
    if (!Number.isFinite(value) || value < min || value > max) return null
    return value
  }
  return {
    pressureLevel: pick(/(?:压力级|压力)[:：]\s*(\d{1,2})/, 1, 5),
    emotionIntensity: pick(/(?:情绪强度|情绪)[:：]\s*(\d{1,2})/, 1, 10),
  }
}

/**
 * 从项目读出风格雷达输入。
 *
 * 返回 `null` 表示「项目没有可用章号」——此时面板显示空态，而不是画一张空雷达。
 */
export async function loadStyleRadarInput(projectPath: string): Promise<StyleRadarInput | null> {
  if (!projectPath) return null

  const status = await loadNovelSessionStatus(projectPath).catch(() => null)
  // 章号真源：status.json 的 current_task.chapter_number（deep-chapter 断点同源）。
  const rawNumber = status?.current_task?.chapter_number
  const chapterNumber =
    typeof rawNumber === "number" && Number.isFinite(rawNumber) && rawNumber > 0 ? rawNumber : null
  if (chapterNumber === null) return null

  const text = await readFile(chapterDraftPath(projectPath, chapterNumber))
    .then((raw) => raw)
    .catch(() => "")

  const outline = await readChapterOutlineContent(normalizePath(projectPath), chapterNumber).catch(
    () => "",
  )
  const position = parseOutlinePositionBullets(outline)

  return {
    text,
    target: {
      chapterLabel: `第 ${chapterNumber} 章`,
      pressureLevel: position.pressureLevel,
      emotionIntensity: position.emotionIntensity,
    },
  }
}
