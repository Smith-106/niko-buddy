// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * B7 挂载覆盖门：`src/components/settings/sections` 下的**每个非 spec 模块**必须二选一——
 *
 *   1. 被 `settings-view.tsx` 挂载：从入口出发沿值 import / 动态 import / re-export
 *      可达（允许经 llm-provider-section 等中间组件传递，如 custom-provider-cards）；
 *   2. 列入下方 `LEGACY_UNMOUNTED_SECTIONS` 显式清单：每条写清「为什么未挂载」与
 *      「什么条件下恢复挂载」。
 *
 * 双向校验：新增孤立 section（或把已挂载文件移出挂载链）→ 红；
 * legacy 文件被接回挂载但没从清单移除 → 也红。`import type` 不算渲染挂载。
 *
 * 新增 section 的标准动作：在 settings-view.tsx 注册类目/渲染，或在此清单登记。
 */

const REPO_ROOT = resolve(__dirname, "../../..")
const SRC_DIR = join(REPO_ROOT, "src")
const SECTIONS_DIR = join(SRC_DIR, "components/settings/sections")
const SETTINGS_VIEW_ENTRY = join(SRC_DIR, "components/settings/settings-view.tsx")

interface LegacyUnmountedSection {
  /** settings/sections 下的相对文件名（含子目录）。 */
  file: string
  /** 为什么当前没有用户可达入口（有意维持现状的原因）。 */
  reason: string
  /** 什么条件下应该接回挂载（恢复条件）。 */
  recovery: string
}

const LEGACY_UNMOUNTED_SECTIONS: readonly LegacyUnmountedSection[] = [
  {
    file: "about-section.tsx",
    reason:
      "版本信息组件从未接入设置导航（CATEGORIES 无 about 类目）：版本号已在 changelog-section 以「当前版本：v…」呈现，该组件属重复入口。",
    recovery: "在 settings-view.tsx 注册类目/渲染，或确认无独立价值后删除组件与其 spec。",
  },
  {
    file: "multimodal-section.tsx",
    reason:
      "图片 caption（多模态）配置 UI 未挂载：SettingsView 的 initialDraft/handleSave 仍读写 multimodalConfig，但没有可编辑入口。",
    recovery: "挂到 llm 类目的模型能力子块（或单独类目），并同步补 settings-view 挂载断言。",
  },
  {
    file: "output-section.tsx",
    reason:
      "AI 输出语言/历史消息数旧 UI 未挂载：maxHistoryMessages 已有新入口（novel-section），outputLanguage 暂无 UI 编辑入口。",
    recovery: "将 outputLanguage 并入 interface-section（或 novel-section），随后删除本组件或保留并挂载。",
  },
  {
    file: "scheduled-import-section.tsx",
    reason:
      "有意隐藏的历史类目（settings-hidden-legacy-sections.spec.ts 负断言）：定时导入配置仍被 SettingsView 读取/保存，但不在设置导航暴露。",
    recovery:
      "产品决定重新暴露时：在 settings-view.tsx 增加类目，并同步移除 settings-hidden-legacy-sections.spec.ts 对应负断言与本清单条目。",
  },
  {
    file: "source-watch-section.tsx",
    reason:
      "有意隐藏的历史类目（settings-hidden-legacy-sections.spec.ts 负断言）：目录监视配置仍被 SettingsView 读取/保存，但不在设置导航暴露。",
    recovery:
      "产品决定重新暴露时：在 settings-view.tsx 增加类目，并同步移除 settings-hidden-legacy-sections.spec.ts 对应负断言与本清单条目。",
  },
  {
    file: "web-search-section.tsx",
    reason:
      "搜索 provider 配置 section 未挂载：searchApiConfig 的消费/写入散落在拆文、大纲聊天等视图的内联设置中，该集中式组件无入口。",
    recovery: "挂到 network 或 mcp 类目（外部服务配置），或先收敛内联入口后再挂载并补挂载断言。",
  },
]

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const

/** static import、side-effect import、动态 import、re-export 均为「值」挂载边。 */
const STATIC_IMPORT_RE = /^[ \t]*import\s+(?!\()(type\s+)?([\s\S]*?)\sfrom\s*["']([^"']+)["']/gm
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
const REEXPORT_RE = /^[ \t]*export\s+(?!type\b)(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm

function isSpecFile(filePath: string): boolean {
  return /\.(spec|test)\.[jt]sx?$/.test(filePath)
}

function extractValueSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    if (match[1]) continue // `import type …` 是纯类型边，不构成渲染挂载。
    specifiers.push(match[3])
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) specifiers.push(match[1])
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) specifiers.push(match[1])
  for (const match of source.matchAll(REEXPORT_RE)) specifiers.push(match[1])
  return specifiers
}

function resolveModule(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) {
    base = join(SRC_DIR, specifier.slice(2))
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    return null // 三方/内置模块，与挂载覆盖无关。
  }
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...MODULE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** 从入口做值可达遍历；spec 文件不是节点（它们不算用户可达挂载）。 */
function collectMountedModules(entryFile: string): Set<string> {
  const visited = new Set<string>()
  const queue: string[] = [entryFile]
  while (queue.length > 0) {
    const file = queue.shift()
    if (!file || visited.has(file)) continue
    visited.add(file)
    for (const specifier of extractValueSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveModule(specifier, file)
      if (!resolved || !resolved.startsWith(SRC_DIR) || isSpecFile(resolved)) continue
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }
  return visited
}

function listNonSpecSectionModules(dir: string): string[] {
  const modules: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      modules.push(...listNonSpecSectionModules(fullPath))
      continue
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name) || isSpecFile(entry.name)) continue
    modules.push(fullPath)
  }
  return modules.sort()
}

const mountedModules = collectMountedModules(SETTINGS_VIEW_ENTRY)
const sectionModules = listNonSpecSectionModules(SECTIONS_DIR)
const legacyByPath = new Map(
  LEGACY_UNMOUNTED_SECTIONS.map((entry) => [resolve(SECTIONS_DIR, entry.file), entry]),
)

function displayPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).replace(/\\/g, "/")
}

describe("B7 settings sections 挂载覆盖门", () => {
  it("settings-view.tsx 入口存在且 sections 目录有可扫描模块（扫描前提）", () => {
    expect(existsSync(SETTINGS_VIEW_ENTRY)).toBe(true)
    expect(sectionModules.length).toBeGreaterThan(0)
  })

  it("sections 下每个非 spec 模块都被 settings-view.tsx 挂载或列入显式 legacy 清单", () => {
    const uncovered = sectionModules.filter(
      (modulePath) => !mountedModules.has(modulePath) && !legacyByPath.has(modulePath),
    )
    expect(
      uncovered.map(displayPath),
      "新增 section 必须被 settings-view.tsx 挂载，或在 LEGACY_UNMOUNTED_SECTIONS 登记（含原因与恢复条件）",
    ).toEqual([])
  })

  it("legacy 清单条目真实存在且确实未挂载（被接回挂载后必须移出清单）", () => {
    for (const entry of LEGACY_UNMOUNTED_SECTIONS) {
      const absolutePath = resolve(SECTIONS_DIR, entry.file)
      expect(existsSync(absolutePath), `legacy 条目 ${entry.file} 不存在`).toBe(true)
      expect(
        mountedModules.has(absolutePath),
        `${entry.file} 已可从 settings-view.tsx 挂载——请从 LEGACY_UNMOUNTED_SECTIONS 移除`,
      ).toBe(false)
      expect(entry.reason.trim().length, `${entry.file} 必须写清未挂载原因`).toBeGreaterThan(0)
      expect(entry.recovery.trim().length, `${entry.file} 必须写清恢复条件`).toBeGreaterThan(0)
    }
  })

  it("legacy 清单无重复条目", () => {
    const files = LEGACY_UNMOUNTED_SECTIONS.map((entry) => entry.file)
    expect(new Set(files).size).toBe(files.length)
  })
})
