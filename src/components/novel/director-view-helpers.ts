// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

// 开书导演纯逻辑（UX 审计批次二·9）：从 director-view.tsx 拆出，主文件只做编排。

import type { DirectorIdeaInput } from "@/lib/novel"

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 立意阶段必填项中仍为空的字段名（按表单顺序，已本地化）。 */
export function missingIdeaFields(
  idea: Pick<DirectorIdeaInput, "title" | "genre" | "coreConflict"> | null | undefined,
  t: Translate,
): string[] {
  const missing: string[] = []
  if (!idea?.title?.trim()) missing.push(t("directorPanel.ideaTitleField"))
  if (!idea?.genre?.trim()) missing.push(t("directorPanel.ideaGenreField"))
  if (!idea?.coreConflict?.trim()) missing.push(t("directorPanel.ideaConflictField"))
  return missing
}
