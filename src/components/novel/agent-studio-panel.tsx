// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * agent-studio-panel.tsx — 代理工作室设置规范化「只读面板」。
 *
 * 定位：
 *   EPIC「代理工作室设置规范化」步骤① 的展示面。它**只渲染**传入的投影，
 *   不读 store、不读文件、不写任何配置，也不挂载到 activeView。
 *
 * 为什么投影走 props 而不是在组件内计算：
 *   novel 领域受 eslint-plugin-boundaries 硬门约束（eslint.config.js
 *   `boundaries/dependencies`：app 层只能经 `src/lib/novel/index.ts` barrel 或
 *   novel-deferred 白名单进入 novel）。barrel 已 re-export 本投影模块（`@/lib/novel`），
 *   面板因此不深导入领域实现；仍保留镜像类型以隔离领域类型变更。
 *
 * 诚实原则（Fix Don't Hide）：
 *   重复真源（`duplicatedIn` 非空）**必须显式渲染**，不允许折叠、截断或
 *   只在 tooltip 里出现；缺失真源（`status === "missing"`）同样显式列出，
 *   并额外汇总 `missingSources`，避免「没显示 = 没问题」的误读。
 *
 * 文案：中文直接写在组件内（本 EPIC 禁止改 i18n json）。
 *
 * @license MIT © Niko Buddy
 */

import { AGENT_STUDIO_SETTING_CATALOG, projectAgentStudioSettings } from "@/lib/novel"

// ── 投影的结构化镜像（barrel 已追加导出；镜像类型保留以便面板不依赖领域类型） ─────

/** 行状态（与 `AgentStudioSettingStatus` 同构）。 */
export type AgentStudioPanelStatus = "ok" | "duplicated" | "missing"

/** 一行设置（与 `AgentStudioSettingRow` 同构）。 */
export interface AgentStudioPanelRow {
  readonly id: string
  readonly label: string
  readonly sourceFile: string
  readonly hasDefault: boolean
  readonly duplicatedIn: readonly string[]
  readonly status: AgentStudioPanelStatus
}

/** 不适用项（与 `AgentStudioNotApplicableItem` 同构）。 */
export interface AgentStudioPanelNotApplicable {
  readonly id: string
  readonly label: string
  readonly reason: string
}

/** 只读投影的消费面（与 `AgentStudioProjection` 同构）。 */
export interface AgentStudioPanelProjection {
  readonly rows: readonly AgentStudioPanelRow[]
  readonly missingSources: readonly string[]
  readonly duplicateRowIds: readonly string[]
  readonly notApplicable: readonly AgentStudioPanelNotApplicable[]
  readonly defaultsById: Readonly<Record<string, string>>
  readonly totals: {
    readonly total: number
    readonly ok: number
    readonly duplicated: number
    readonly missing: number
  }
}

export interface AgentStudioPanelProps {
  /** 由 `projectAgentStudioSettings` 产出的只读投影。 */
  readonly projection: AgentStudioPanelProjection
  /** true = 静态声明表（运行时未探测文件是否仍存在）。 */
  readonly staticDeclarationOnly?: boolean
}

// ── 文案（中文直写，不走 i18n） ───────────────────────────────────────────────────

const STATUS_LABEL: Record<AgentStudioPanelStatus, string> = {
  ok: "一致",
  duplicated: "重复真源",
  missing: "缺失",
}

/**
 * 静态声明模式下的徽章：不探测磁盘就不许说「一致」（那是在声称"文件还在、符号还在"）。
 */
const STATIC_STATUS_LABEL: Record<AgentStudioPanelStatus, string> = {
  ok: "已登记",
  duplicated: "重复声明",
  missing: "缺失（未探测）",
}

const STATUS_CLASS: Record<AgentStudioPanelStatus, string> = {
  ok: "border-border text-muted-foreground",
  duplicated: "border-warning/40 text-warning-foreground",
  missing: "border-destructive/60 text-destructive",
}

// ── 组件 ─────────────────────────────────────────────────────────────────────────

/**
 * 代理工作室设置只读面板。
 *
 * testid 契约：
 *   - 根：`agent-studio-panel`
 *   - 每行：`agent-studio-row-<id>`
 *   - 重复真源标记（有副本的行必有）：`agent-studio-duplicate-<id>`
 *   - 不适用项：`agent-studio-na-<id>`
 *   - 缺失真源汇总：`agent-studio-missing-sources`
 */
export function AgentStudioPanel({ projection, staticDeclarationOnly = false }: AgentStudioPanelProps) {
  const { rows, missingSources, notApplicable, defaultsById, totals } = projection

  return (
    <section data-testid="agent-studio-panel" className="space-y-4">
      {staticDeclarationOnly ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-studio-static-scope">
          静态声明表：位置来自代码内 catalog 的 <code>file:line</code>；运行时<b>未</b>探测文件是否仍存在、行内是否仍是该符号，文件被删或挪行本面板不会变红。因此下面只统计「已登记 / 重复声明」，不判断「缺失」。
        </p>
      ) : null}
      <header className="space-y-1">
        <h3 className="text-base font-semibold">代理工作室设置规范化（只读）</h3>
        <p className="text-xs leading-5 text-muted-foreground" data-testid="agent-studio-subtitle">
          {staticDeclarationOnly
            ? "本面板只负责展示：不写入任何配置，也不改变任何模型路由。重复声明已登记；文件是否仍存在未探测（见上方范围说明）。"
            : "本面板只负责展示：不写入任何配置，也不改变任何模型路由。重复来源与缺失来源一律显式列出。"}
        </p>
        <p className="text-xs leading-5 text-muted-foreground" data-testid="agent-studio-totals">
          {staticDeclarationOnly
            ? `共 ${totals.total} 项 · 已登记 ${totals.ok} · 重复声明 ${totals.duplicated} · 缺失判定 N/A（未探测磁盘）`
            : `共 ${totals.total} 项 · 一致 ${totals.ok} · 重复真源 ${totals.duplicated} · 缺失 ${totals.missing}`}
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="agent-studio-empty">
          没有可展示的设置项。完成相关设置后，这里会显示汇总。
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const defaultValue = defaultsById[row.id]
            return (
              <li
                key={row.id}
                data-testid={`agent-studio-row-${row.id}`}
                data-status={row.status}
                className="space-y-1 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.label}</span>
                  <code className="text-xs text-muted-foreground">{row.id}</code>
                  <span
                    data-badge={
                      staticDeclarationOnly ? STATIC_STATUS_LABEL[row.status] : STATUS_LABEL[row.status]
                    }
                    className={`rounded border px-1.5 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}
                  >
                    {staticDeclarationOnly ? STATIC_STATUS_LABEL[row.status] : STATUS_LABEL[row.status]}
                  </span>
                </div>

                <p className="text-xs leading-5 text-muted-foreground">
                  真源：<code>{row.sourceFile}</code>
                </p>

                <p className="text-xs leading-5 text-muted-foreground">
                  {row.hasDefault
                    ? defaultValue === undefined
                      ? "有默认值"
                      : `默认值：${defaultValue}`
                    : "无默认值（未配置即未配置，不伪造）"}
                </p>

                {row.duplicatedIn.length > 0 ? (
                  <div
                    data-testid={`agent-studio-duplicate-${row.id}`}
                    className="rounded border border-warning/40 bg-warning/5 p-2"
                  >
                    <p className="text-xs font-medium text-warning-foreground">
                      同一口径在 {row.duplicatedIn.length} 处被重复声明（口径漂移风险）：
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {row.duplicatedIn.map((ref) => (
                        <li key={ref} className="text-xs text-muted-foreground">
                          <code>{ref}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {row.status === "missing" ? (
                  <p className="text-xs leading-5 text-destructive">
                    真源文件不存在，该设置目前没有落点。
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <div className="space-y-1 rounded-md border p-3">
        <h4 className="text-sm font-medium">
          {staticDeclarationOnly ? "缺失真源汇总（静态模式下不适用）" : "缺失真源汇总"}
        </h4>
        {staticDeclarationOnly ? (
          <p className="text-xs leading-5 text-muted-foreground" data-testid="agent-studio-missing-sources">
            N/A：静态声明表不做磁盘探测，因此不给出「有/无缺失」的结论。
          </p>
        ) : missingSources.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground" data-testid="agent-studio-missing-sources">
            无缺失真源。
          </p>
        ) : (
          <ul className="space-y-0.5" data-testid="agent-studio-missing-sources">
            {missingSources.map((path) => (
              <li key={path} className="text-xs leading-5 text-destructive">
                <code>{path}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <h4 className="text-sm font-medium">不适用项（N/A）</h4>
        {notApplicable.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">无不适用项。</p>
        ) : (
          <ul className="space-y-2">
            {notApplicable.map((item) => (
              <li key={item.id} data-testid={`agent-studio-na-${item.id}`} className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{item.label}</span>
                  <code className="text-xs text-muted-foreground">{item.id}</code>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{item.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/**
 * 已挂载包装（诊断中心用）：**静态盘点**，不做运行时文件探测。
 *
 * 为什么去掉 `fileExists` 探针（审查阻断项）：
 * - catalog 的 `sourceFile` 形如 `src/stores/wiki-store.ts:112`（含行号），
 *   Rust 路径守卫会因段内 `:` 拒绝，`invoke` 抛错被 `.catch` 吞掉 → 面板永远「盘点中」。
 * - 即便去掉行号，安装包的 cwd 是启动目录、包内没有 `src/**`，探测会全 false，
 *   把「已声明」说成「缺失」，同样是假信息。
 * 因此这里只把 catalog 当成**静态声明表**渲染，并在范围说明里写清「运行时未探测」，
 * 文件改名/挪行不会自动更新（属已知限制，不是"通过"）。
 */
export function AgentStudioPanelMounted() {
  const projection = projectAgentStudioSettings({
    existingFiles: AGENT_STUDIO_SETTING_CATALOG.map((entry) =>
      entry.sourceFile.replace(/:\d+(?:-\d+)?$/, ""),
    ),
  })
  return <AgentStudioPanel projection={projection} staticDeclarationOnly />
}
