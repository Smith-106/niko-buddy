/**
 * canon-editor.tsx — F-01 canon 写路径编辑 UI（T29b：known_by/revealed_at 人工校正）。
 *
 * 职责（TASK-P3-29b）：
 *   - 数据源：T13 `canon_query_batch`（与 T18a 只读版同一 IPC 缝合点；本组件是
 *     认知轴校正面，必须看到原始边上的 `known_by` —— T14 `projectEdge` 的读出口
 *     剥离契约不适用于编辑面，POV 防泄密由本文件的白名单写入守卫承担）。
 *   - 写路径：复用 T13 既有命令 `canon_supersede_edges`（**不新开 Rust 面**）。
 *     校正语义 = 旧边封顶于其 `valid_at`（无缝替换，时态不变量 valid_at<=invalid_at
 *     恒成立）+ 插入校正后继边（仅改认知轴字段，世界时态原样继承）。
 *
 * POV 防泄密约束（known_by 白名单校验，fail-closed）：
 *   - `povAllowlist` 为项目角色注册表投影；known_by **增补**只接受白名单成员；
 *   - 白名单为空/缺省 = 禁止一切增补（只允许移除——缩减知晓集永不泄密）；
 *   - 空白条目 / 重复条目 / 白名单外条目一律在客户端拦截，不触达 IPC。
 *
 * 时态不变量（与 Rust `validate_edge_temporal` 对齐，客户端先行拦截）：
 *   - revealed_at >= valid_at（RevealedBeforeValid：揭示不得早于事实生效）；
 *   - revealed_at 留空合法；填值必须是 ≥1 的整数章号（章节号 1-based）；
 *   - revealed_at 非空但 known_by 为空 → 拒绝（无人知晓却已揭示，语义矛盾）。
 *
 * Draft-first（ADR-08）：canon 三表是正式事实层，人工校正走 supersede 显式写路径
 * （旧边封顶留痕 + 新边插入），不经草稿层、零 LLM。
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type {
  CanonEdgeFilter,
  CanonEdgeKind,
  RawCanonEdge,
} from "@/lib/novel/canon-graph-client"

// ============================================================================
// wire 契约（与 src-tauri/src/canon_commands.rs serde snake_case 对齐）
// ============================================================================

/** T13 `canon_supersede_edges` 请求体（SupersedeRequest 镜像）。 */
export interface CanonSupersedeRequest {
  /** 被取代的旧边 id 列表。 */
  old_edge_ids: string[]
  /** 封顶章节（旧边 invalid_at 写入值）。 */
  cap_chapter: number
  /** 后继新边（id 由调用方生成）。 */
  new_edges: RawCanonEdge[]
  /** §B 审计溯源标记：人工校正 supersede 的高审计粒度标记。 */
  caused_by?: string
}

/** T13 `canon_supersede_edges` 响应体（CanonSupersedeResponse 镜像）。 */
export interface CanonSupersedeResponse {
  result: {
    capped: number
    inserted: number
    missing: string[]
  }
  max_revision: number
}

/** T13 `canon_query_batch` 响应体（CanonQueryBatchResponse 镜像）。 */
interface CanonQueryBatchRawResponse {
  results: RawCanonEdge[][]
  max_revision: number
}

// ============================================================================
// 校正载荷构建（纯函数）
// ============================================================================

/**
 * 生成校正后继边的 id（纯函数；salt 由调用方注入时间戳/序数以保证全局唯一）。
 * Rust 侧约定「后继新边由调用方生成全新 id」。
 */
export function makeCorrectionId(oldId: string, salt: string): string {
  return `corr:${oldId}:${salt}`
}

/** FNV-1a 32 位摘要（十六进制）。校正后继边的写路径幂等键（确定性，同内容同值）。 */
export function computeCorrectionDigest(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * 把一条原始边 + 认知轴补丁装配为 `canon_supersede_edges` 请求（纯函数）。
 *
 * - 旧边封顶章 = `old.valid_at ?? 0`：旧边自生效点起即被后继取代（无缝替换，
 *   且恒满足 valid_at <= invalid_at 时态不变量）；已封顶旧边重复封顶无害。
 * - 后继边继承旧边全部字段（含 world 时态 valid_at/invalid_at 与技法列），
 *   仅覆盖 id / known_by / revealed_at，并重算 digest；archived 归一为 false。
 *
 * @param salt 校正 id 后缀盐（调用方注入，测试传固定值）
 */
export function buildSupersedeRequestForCorrection(
  old: RawCanonEdge,
  patch: { knownBy: readonly string[]; revealedAt: number | null },
  salt: string,
): CanonSupersedeRequest {
  const newId = makeCorrectionId(old.id, salt)
  const newEdge: RawCanonEdge = {
    ...old,
    id: newId,
    known_by: [...patch.knownBy],
    revealed_at: patch.revealedAt,
    archived: false,
    digest: computeCorrectionDigest(
      `${newId}|${patch.knownBy.join(",")}|${patch.revealedAt ?? ""}`,
    ),
  }
  return {
    old_edge_ids: [old.id],
    cap_chapter: old.valid_at ?? 0,
    new_edges: [newEdge],
    // §B causedBy：人工校正 supersede 的审计溯源标记
    caused_by: "manual-correction",
  }
}

// ============================================================================
// 校正校验（纯函数；POV 防泄密 + 时态不变量，客户端 fail-closed 拦截）
// ============================================================================

/** 校验违规码（与消息一一对应，供 spec 断言与 UI 徽标）。 */
export type CorrectionViolationCode =
  | "empty_pov"
  | "duplicate_pov"
  | "not_in_allowlist"
  | "invalid_revealed_at"
  | "revealed_before_valid"
  | "revealed_without_known_by"

export interface CorrectionViolation {
  code: CorrectionViolationCode
  message: string
}

export interface CorrectionValidation {
  ok: boolean
  violations: CorrectionViolation[]
}

/**
 * known_by 白名单校验（POV 防泄密核心守卫，fail-closed）：
 *   - 空白条目 → empty_pov；
 *   - 重复条目 → duplicate_pov；
 *   - 不在白名单 → not_in_allowlist（白名单空 = 全部拒绝增补，只允许移除）。
 */
export function validateKnownByCorrection(
  nextKnownBy: readonly unknown[],
  allowlist: readonly string[],
): CorrectionValidation {
  const violations: CorrectionViolation[] = []
  const seen = new Set<string>()
  for (const raw of nextKnownBy) {
    const pov = typeof raw === "string" ? raw.trim() : ""
    if (!pov) {
      violations.push({ code: "empty_pov", message: "known_by 含空白 POV 条目" })
      continue
    }
    if (seen.has(pov)) {
      violations.push({ code: "duplicate_pov", message: `known_by 重复 POV：${pov}` })
      continue
    }
    seen.add(pov)
    if (!allowlist.includes(pov)) {
      violations.push({
        code: "not_in_allowlist",
        message: `POV「${pov}」不在项目角色白名单内（POV 防泄密：known_by 增补仅接受白名单成员）`,
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/**
 * revealed_at 时态不变量校验（与 Rust validate_edge_temporal 对齐）：
 *   - 非 null 必须为 ≥1 整数（1-based 章节号）→ 否则 invalid_revealed_at；
 *   - revealed_at < valid_at → revealed_before_valid（揭示早于事实生效）；
 *   - revealed_at 非空但 known_by 为空 → revealed_without_known_by。
 */
export function validateRevealedAtCorrection(
  revealedAt: number | null,
  validAt: number | null | undefined,
  knownByCount: number,
): CorrectionValidation {
  const violations: CorrectionViolation[] = []
  if (revealedAt !== null) {
    if (!Number.isInteger(revealedAt) || revealedAt < 1) {
      violations.push({
        code: "invalid_revealed_at",
        message: "revealed_at 必须是 ≥1 的整数章号（或留空表示未登记揭示点）",
      })
    } else if (validAt != null && revealedAt < validAt) {
      violations.push({
        code: "revealed_before_valid",
        message: `revealed_at=${revealedAt} 早于 valid_at=${validAt}：揭示不得早于事实生效（POV 防泄密时态不变量）`,
      })
    } else if (knownByCount === 0) {
      violations.push({
        code: "revealed_without_known_by",
        message: "revealed_at 已登记但 known_by 为空：无人知晓的事实不可能被揭示",
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** 解析 revealed_at 输入框文本：空白 → null（未登记）；非法整数 → NaN。 */
function parseChapterInput(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return Number.parseInt(trimmed, 10)
}

// ============================================================================
// 组件
// ============================================================================

const EDGE_KIND_LABELS: Record<CanonEdgeKind, string> = {
  world_fact: "世界事实",
  motivation: "动机",
  arc: "弧光",
  foreshadow: "伏笔",
  hook: "钩子",
  attribute: "属性",
}

export interface CanonEditorProps {
  /** 项目 id（canon_commands 首参；对应 Rust project_id）。 */
  projectId: string
  /**
   * POV 白名单（项目角色注册表投影）。
   * fail-closed：缺省/空数组 = 禁止一切 known_by 增补（仅允许移除）。
   */
  povAllowlist?: readonly string[]
  className?: string
}

interface SaveOutcome {
  capped: number
  inserted: number
  missing: string[]
  maxRevision: number
}

export function CanonEditor({ projectId, povAllowlist = [], className }: CanonEditorProps) {
  // ── 列表态 ──
  const [edges, setEdges] = useState<RawCanonEdge[]>([])
  const [maxRevision, setMaxRevision] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [queryError, setQueryError] = useState<string | null>(null)

  // ── 校正草稿态 ──
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftKnownBy, setDraftKnownBy] = useState<string[]>([])
  const [draftRevealedAt, setDraftRevealedAt] = useState("")
  const [povInput, setPovInput] = useState("")
  const [addPovError, setAddPovError] = useState<string | null>(null)
  const [saveViolations, setSaveViolations] = useState<CorrectionViolation[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSave, setLastSave] = useState<SaveOutcome | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setQueryError(null)
    try {
      // 编辑面需要原始边（含 known_by），直连 canon_query_batch，不走 T14 投影剥离。
      const res = await invoke<CanonQueryBatchRawResponse>("canon_query_batch", {
        projectId,
        filters: [{} satisfies CanonEdgeFilter],
      })
      setEdges(res.results[0] ?? [])
      setMaxRevision(res.max_revision)
    } catch (err) {
      setEdges([])
      setMaxRevision(null)
      setQueryError(err instanceof Error ? err.message : "canon_query_batch 调用失败")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => edges.find((e) => e.id === selectedId) ?? null,
    [edges, selectedId],
  )

  // 无变更守卫：草稿与原边完全一致时禁止保存（避免零差异冗余后继边污染事实表）。
  const correctionDirty = useMemo(() => {
    if (!selected) return false
    const original = [...(selected.known_by ?? [])]
    const sameSet =
      original.length === draftKnownBy.length &&
      original.every((p) => draftKnownBy.includes(p))
    const originalRevealed = selected.revealed_at == null ? "" : String(selected.revealed_at)
    return !sameSet || originalRevealed !== draftRevealedAt.trim()
  }, [selected, draftKnownBy, draftRevealedAt])

  const handleSelect = useCallback((edge: RawCanonEdge) => {
    setSelectedId(edge.id)
    setDraftKnownBy([...(edge.known_by ?? [])])
    setDraftRevealedAt(edge.revealed_at == null ? "" : String(edge.revealed_at))
    setPovInput("")
    setAddPovError(null)
    setSaveViolations([])
    setSaveError(null)
    setLastSave(null)
  }, [])

  const handleDeselect = useCallback(() => {
    setSelectedId(null)
    setDraftKnownBy([])
    setDraftRevealedAt("")
    setPovInput("")
    setAddPovError(null)
    setSaveViolations([])
    setSaveError(null)
  }, [])

  const handleRemovePov = useCallback((pov: string) => {
    // 移除知晓成员永不扩大知晓面（POV 安全方向），不做白名单限制。
    setDraftKnownBy((prev) => prev.filter((p) => p !== pov))
    setSaveViolations([])
  }, [])

  const handleAddPov = useCallback(() => {
    const pov = povInput.trim()
    setAddPovError(null)
    if (!pov) return
    // 增补前即时白名单校验（fail-closed；违规不入草稿、更不触达 IPC）。
    const check = validateKnownByCorrection([...draftKnownBy, pov], povAllowlist)
    if (!check.ok) {
      setAddPovError(check.violations.map((v) => v.message).join("；"))
      return
    }
    setDraftKnownBy((prev) => [...prev, pov])
    setPovInput("")
  }, [povInput, draftKnownBy, povAllowlist])

  const handleSave = useCallback(async () => {
    if (!selected || saving) return
    setSaveError(null)
    setLastSave(null)

    const parsed = parseChapterInput(draftRevealedAt)
    const knownByCheck = validateKnownByCorrection(draftKnownBy, povAllowlist)
    const revealedCheck =
      Number.isNaN(parsed as number) && draftRevealedAt.trim() !== ""
        ? {
            ok: false,
            violations: [
              {
                code: "invalid_revealed_at" as const,
                message: "revealed_at 必须是 ≥1 的整数章号（或留空表示未登记揭示点）",
              },
            ],
          }
        : validateRevealedAtCorrection(parsed, selected.valid_at, draftKnownBy.length)
    const violations = [...knownByCheck.violations, ...revealedCheck.violations]
    if (violations.length > 0) {
      setSaveViolations(violations)
      return
    }
    setSaveViolations([])

    const request = buildSupersedeRequestForCorrection(
      selected,
      { knownBy: draftKnownBy, revealedAt: parsed },
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    )
    setSaving(true)
    try {
      const res = await invoke<CanonSupersedeResponse>("canon_supersede_edges", {
        projectId,
        request,
      })
      setLastSave({ ...res.result, maxRevision: res.max_revision })
      handleDeselect()
      await load()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "canon_supersede_edges 调用失败")
    } finally {
      setSaving(false)
    }
  }, [
    selected,
    saving,
    draftRevealedAt,
    draftKnownBy,
    povAllowlist,
    projectId,
    handleDeselect,
    load,
  ])

  return (
    <div className={className ?? "h-full overflow-auto bg-background p-6"} data-testid="canon-editor-root">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold" data-testid="canon-editor-title">
              Canon 认知轴校正（写路径）
            </h1>
            <span
              className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
              data-testid="canon-max-revision"
            >
              revision: {maxRevision === null ? "—" : maxRevision}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            项目 {projectId} · 选择事实边校正 known_by（白名单）与 revealed_at；保存走 canon_supersede_edges（旧边封顶留痕 + 校正后继边）。
          </p>
        </header>

        {queryError && (
          <div
            className="rounded-md border border-red-300 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
            role="alert"
            data-testid="canon-query-error"
          >
            {queryError}
          </div>
        )}

        <section aria-label="canon 事实边列表" className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">事实边</h2>
            <button
              type="button"
              className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void load()}
              disabled={loading}
              data-testid="canon-refresh"
            >
              刷新
            </button>
          </div>
          {loading ? (
            <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="canon-loading">
              加载中…
            </p>
          ) : edges.length === 0 ? (
            <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="canon-empty">
              无事实边（先完成章节摄取或调整过滤条件）。
            </p>
          ) : (
            <table className="w-full text-left text-xs" data-testid="canon-edge-table">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">id</th>
                  <th className="px-2 py-1.5">谓词</th>
                  <th className="px-2 py-1.5">类别</th>
                  <th className="px-2 py-1.5">known_by</th>
                  <th className="px-2 py-1.5">revealed_at</th>
                  <th className="px-2 py-1.5">操作</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((edge) => (
                  <tr key={edge.id} className="border-t">
                    <td className="px-2 py-1.5 font-mono">{edge.id}</td>
                    <td className="px-2 py-1.5">{edge.predicate}</td>
                    <td className="px-2 py-1.5">{EDGE_KIND_LABELS[edge.edge_kind] ?? edge.edge_kind}</td>
                    <td className="px-2 py-1.5">{(edge.known_by ?? []).join(", ") || "—"}</td>
                    <td className="px-2 py-1.5">{edge.revealed_at ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        className="rounded-md border px-2 py-0.5 transition-colors hover:bg-muted"
                        onClick={() => handleSelect(edge)}
                        data-testid={`canon-select-${edge.id}`}
                      >
                        校正
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {selected && (
          <section
            aria-label="认知轴校正面板"
            className="rounded-lg border bg-card p-4 shadow-sm"
            data-testid="correction-panel"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                校正认知轴 ·{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {selected.predicate}（{EDGE_KIND_LABELS[selected.edge_kind] ?? selected.edge_kind}
                  ，valid_at={selected.valid_at ?? "—"}）
                </span>
              </h2>
              <button
                type="button"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={handleDeselect}
                data-testid="correction-cancel"
              >
                取消
              </button>
            </div>

            {/* known_by 草稿 chips */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">known_by：</span>
              {draftKnownBy.length === 0 && (
                <span className="text-xs italic text-muted-foreground/70">（空 — 无人知晓）</span>
              )}
              {draftKnownBy.map((pov) => (
                <span
                  key={pov}
                  className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
                  data-testid={`correction-pov-chip-${pov}`}
                >
                  {pov}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`移除 ${pov}`}
                    onClick={() => handleRemovePov(pov)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>

            {/* 增补 POV（白名单 datalist） */}
            <div className="mb-3 flex items-center gap-2">
              <input
                type="text"
                list="canon-pov-allowlist"
                className="h-8 w-56 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="新增知晓 POV（限白名单）"
                value={povInput}
                onChange={(e) => {
                  setPovInput(e.target.value)
                  setAddPovError(null)
                }}
                data-testid="correction-pov-input"
              />
              <datalist id="canon-pov-allowlist">
                {povAllowlist.map((pov) => (
                  <option key={pov} value={pov} />
                ))}
              </datalist>
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted"
                onClick={handleAddPov}
                data-testid="correction-pov-add"
              >
                添加
              </button>
            </div>
            {addPovError && (
              <p className="mb-3 text-xs text-destructive" role="alert" data-testid="correction-pov-error">
                {addPovError}
              </p>
            )}

            {/* revealed_at（text+inputMode：让非法输入留在框内被校验拦截，而非被浏览器静默清洗） */}
            <label className="mb-3 flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">revealed_at（向 known_by 揭示的章节；留空=未登记）</span>
              <input
                type="text"
                inputMode="numeric"
                className="h-8 w-32 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={draftRevealedAt}
                onChange={(e) => {
                  setDraftRevealedAt(e.target.value)
                  setSaveViolations([])
                }}
                data-testid="correction-revealed-at"
              />
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleSave()}
                disabled={saving || !correctionDirty}
                data-testid="correction-save"
              >
                {saving ? "保存中…" : "保存校正"}
              </button>
              <span className="text-xs text-muted-foreground">
                保存 = canon_supersede_edges：旧边封顶于 valid_at={selected.valid_at ?? 0} + 校正后继边
              </span>
            </div>

            {saveViolations.length > 0 && (
              <ul
                className="mt-3 list-inside list-disc rounded-md border border-red-300 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
                role="alert"
                data-testid="correction-violations"
              >
                {saveViolations.map((v) => (
                  <li key={v.code}>
                    [{v.code}] {v.message}
                  </li>
                ))}
              </ul>
            )}

            {saveError && (
              <p className="mt-3 text-xs text-destructive" role="alert" data-testid="correction-save-error">
                {saveError}
              </p>
            )}
          </section>
        )}

        {lastSave && (
          <div
            className="rounded-md border border-green-300 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:border-green-800 dark:text-green-300"
            role="status"
            data-testid="correction-saved"
          >
            校正已写入：封顶 {lastSave.capped} 条 · 插入 {lastSave.inserted} 条 · revision → {lastSave.maxRevision}
            {lastSave.missing.length > 0 && ` · 未找到旧边：${lastSave.missing.join(", ")}`}
          </div>
        )}
      </div>
    </div>
  )
}
