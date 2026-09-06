/**
 * 64 号实施（63 号共识 §6 P0-5）：CoverImageProvider — 封面图生成执行器.
 *
 * 吸收来源：cover-brief.ts 封面 brief 契约（R-anwa-3，provider 无关）。本
 * 文件把契约接到执行端：确定性任务组装（尺寸/比例/提示词/落地路径）+ 注入
 * 式生成端口（CoverImagePort）——引擎层零图像 SDK 依赖，与 translation
 * runner 的 TranslationLlmPort 同构。幂等：目标文件已存在 → skip（零覆盖）。
 * Draft-first：产物先进 `.novel/covers/` pending 区，用户 accept 才进
 * wiki/发布目录（本文件只负责 pending 落地 + accept 移动语义由调用方执行）。
 */

import { createDirectory, fileExists, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { coverBriefToPrompt, type BookCoverMeta, type CoverBrief } from "./cover-brief"

export type CoverAspect = "portrait" | "square" | "landscape"

/** 比例 → 默认像素尺寸（表驱动确定性；provider 可 override）。 */
export const COVER_ASPECT_SIZE: Record<CoverAspect, { width: number; height: number }> = {
  portrait: { width: 1024, height: 1536 },
  square: { width: 1024, height: 1024 },
  landscape: { width: 1536, height: 1024 },
}

export interface CoverImageTask {
  /** 稳定文件名（slug，无绝对路径；含非法字符 → 调用方先 sanitize）。 */
  fileName: string
  prompt: string
  width: number
  height: number
  aspect: CoverAspect
}

export interface CoverImagePort {
  generate(input: { prompt: string; width: number; height: number; signal?: AbortSignal }): Promise<Uint8Array>
}

export interface CoverImageResult {
  ok: boolean
  reason?: "skipped" | "generated" | "failed" | "canceled"
  fileName?: string
  message?: string
}

/**
 * 组装封面图任务（纯函数零 IO 零 LLM）：
 * - prompt = coverBriefToPrompt + 尺寸/比例约束后缀（确定性拼装）
 * - 尺寸按 aspect 表驱动
 * - 竖版默认（封面以竖版为主流）
 */
export function buildCoverImageTask(
  meta: BookCoverMeta,
  brief: CoverBrief,
  aspect: CoverAspect = "portrait",
): CoverImageTask {
  const size = COVER_ASPECT_SIZE[aspect]
  const base = coverBriefToPrompt(brief, meta.title)
  return {
    fileName: `${slugify(meta.title)}-cover.png`,
    prompt: `${base}\n画面比例：${aspect === "portrait" ? "竖版 2:3" : aspect === "square" ? "方形 1:1" : "横版 16:9"}；尺寸 ${size.width}x${size.height}；无文字水印；无真实人脸特写（如禁止）。`,
    width: size.width,
    height: size.height,
    aspect,
  }
}

/** slug 化书名（安全文件名；非字母数字/中文字符 → -，连续 - 合并）。 */
export function slugify(title: string): string {
  const cleaned = title
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return cleaned === "" ? "untitled" : cleaned
}

/**
 * 执行封面生成：目标已存在 → skipped（幂等零覆盖）；port 抛错 → failed；
 * signal aborted → canceled。生成产物落 `.novel/covers/{fileName}`（pending
 * 区；accept 移动由调用方负责）。
 */
export async function runCoverImageGeneration(
  port: CoverImagePort,
  projectPath: string,
  task: CoverImageTask,
  signal?: AbortSignal,
): Promise<CoverImageResult> {
  const dir = `${normalizePath(projectPath)}/.novel/covers`
  const target = `${dir}/${task.fileName}`
  if (await fileExists(target)) {
    return { ok: true, reason: "skipped", fileName: task.fileName, message: "目标已存在，跳过（幂等）" }
  }
  if (signal?.aborted) return { ok: false, reason: "canceled", message: "已取消" }
  try {
    const bytes = await port.generate({
      prompt: task.prompt,
      width: task.width,
      height: task.height,
      signal,
    })
    await createDirectory(dir)
    await writeFile(target, new TextDecoder().decode(bytes))
    return { ok: true, reason: "generated", fileName: task.fileName, message: `已生成 ${target}` }
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      message: `封面生成失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
