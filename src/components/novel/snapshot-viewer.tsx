import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { readFile } from "@/commands/fs"
import { listSnapshotHistory, loadSnapshot, restoreSnapshotHistory, syncSnapshotToMemory, type ChapterSnapshot, type SnapshotHistoryEntry } from "@/lib/novel/chapter-ingest"
import { MonacoDiffEditor } from "./monaco-diff-editor"

interface SnapshotViewerProps {
  projectPath: string
  chapterNumber: number
  onClose: () => void
}

function listToText(items: string[] | undefined): string {
  return (items ?? []).join("\n")
}

function textToList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

function updateListField(snapshot: ChapterSnapshot, key: keyof ChapterSnapshot, value: string): ChapterSnapshot {
  return { ...snapshot, [key]: textToList(value) }
}

function updateTextField(snapshot: ChapterSnapshot, key: keyof ChapterSnapshot, value: string): ChapterSnapshot {
  return { ...snapshot, [key]: value }
}

function formatSyncTime(value: string | undefined): string {
  /* v8 ignore next */
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("zh-CN", { hour12: false })
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-sm font-semibold text-foreground">{title}</h4>
      <ul className="list-inside list-disc space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-muted-foreground">{item}</li>
        ))}
      </ul>
    </div>
  )
}

function TextSection({ title, content }: { title: string; content: string }) {
  if (!content) return null
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-sm font-semibold text-foreground">{title}</h4>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{content}</p>
    </div>
  )
}

function EditableTextSection({ title, value, onChange }: { title: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-sm font-semibold text-foreground">{title}</h4>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[90px] w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring"
      />
    </div>
  )
}

function EditableListSection({ title, value, onChange }: { title: string; value: string[]; onChange: (value: string) => void }) {
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-sm font-semibold text-foreground">{title}</h4>
      <textarea
        value={listToText(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder="每行一条，可删除、修改或新增"
        className="min-h-[86px] w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-ring"
      />
    </div>
  )
}

// TASK-303 历史版本对比：单行历史版本条目，含「对比当前版本」与「恢复」操作。
export interface HistoryEntryRowProps {
  entry: SnapshotHistoryEntry
  disabled: boolean
  restoring: boolean
  onCompare: () => void
  onRestore: () => void
}

export function HistoryEntryRow({ entry, disabled, restoring, onCompare, onRestore }: HistoryEntryRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1.5">
      <span className="truncate text-xs text-muted-foreground">{entry.createdAt}</span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onCompare}
          disabled={disabled}
          title="对比该历史版本与当前快照的内容差异（只读）。"
          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          对比当前版本
        </button>
        <button
          type="button"
          onClick={onRestore}
          disabled={disabled}
          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {restoring ? "恢复中" : "恢复"}
        </button>
      </div>
    </div>
  )
}

// TASK-303 版本对比模态：只读 MonacoDiffEditor 展示 历史(original) ↔ 当前(modified) 的 JSON diff。
export interface SnapshotDiffModalProps {
  open: boolean
  original: string
  modified: string
  onClose: () => void
}

export function SnapshotDiffModal({ open, original, modified, onClose }: SnapshotDiffModalProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={(e) => {
        // 阻止冒泡到外层 SnapshotViewer 遮罩的 onClose，避免点对比遮罩连带关闭整个查看器。
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="对比当前版本"
        tabIndex={-1}
        className="flex max-h-[80vh] w-[860px] flex-col rounded-lg border border-border bg-background shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-lg font-semibold text-foreground">对比当前版本</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭对比"
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-4">
          <MonacoDiffEditor
            original={original}
            modified={modified}
            language="json"
            readOnly
            height={520}
          />
        </div>
      </div>
    </div>
  )
}

export function SnapshotViewer({ projectPath, chapterNumber, onClose }: SnapshotViewerProps) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ChapterSnapshot | null>(null)
  const [draft, setDraft] = useState<ChapterSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [showJson, setShowJson] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<SnapshotHistoryEntry[]>([])
  const [restoring, setRestoring] = useState(false)
  const [saveMessage, setSaveMessage] = useState("")
  // TASK-303 版本对比状态：open 时渲染 SnapshotDiffModal，original=历史快照 JSON 文本。
  const [diffState, setDiffState] = useState<{ open: boolean; original: string }>({ open: false, original: "" })

  // ISS-20260712-016 (WCAG 4.1.2 dialog semantics): 手写模态补 a11y。
  // role=dialog/aria-modal 让屏幕阅读器识别为模态; Escape 键关闭; 打开时
  // 聚焦模态(非背景元素),Tab 循环限于模态内(focus trap)。
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        // 对比模态打开时先关对比，避免一次 Escape 连带关闭整个查看器。
        if (diffState.open) {
          setDiffState((value) => ({ ...value, open: false }))
          return
        }
        onClose()
        return
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        /* v8 ignore next */
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    // 打开时聚焦模态容器(不抢第一个按钮的焦点,但让 Tab 从模态内开始)
    dialogRef.current?.focus()
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [onClose, diffState.open])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setEditing(false)
    setSaveMessage("")
    loadSnapshot(projectPath, chapterNumber)
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data)
          setDraft(data)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    listSnapshotHistory(projectPath, chapterNumber)
      .then((items) => {
        if (!cancelled) setHistory(items)
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    return () => { cancelled = true }
  }, [projectPath, chapterNumber]
  )

  const refreshHistory = async () => {
    setHistory(await listSnapshotHistory(projectPath, chapterNumber))
  }

  const startEditing = () => {
    /* v8 ignore next */
    if (!snapshot) return
    setDraft(snapshot)
    setEditing(true)
    setSaveMessage("")
  }

  const cancelEditing = () => {
    setDraft(snapshot)
    setEditing(false)
    setSaveMessage("")
  }

  const saveEditing = async () => {
    /* v8 ignore next */
    if (!draft || saving) return
    setSaving(true)
    setSaveMessage("")
    try {
      const result = await syncSnapshotToMemory(projectPath, draft)
      const updatedSnapshot = { ...draft, memorySyncedAt: result.memorySyncedAt }
      await refreshHistory()
      setSnapshot(updatedSnapshot)
      setDraft(updatedSnapshot)
      setEditing(false)
      setSaveMessage(t("novel.snapshot.syncMemorySuccess", { count: result.writtenEntityPaths.length }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveMessage(`保存失败：${message}`)
    } finally {
      setSaving(false)
    }
  }

  const restoreHistory = async (entry: SnapshotHistoryEntry) => {
    /* v8 ignore next */
    if (restoring || saving) return
    if (!window.confirm("恢复历史快照会恢复快照内容，并自动重建小说记忆。是否继续？")) return
    setRestoring(true)
    setSaveMessage("")
    try {
      const restored = await restoreSnapshotHistory(projectPath, chapterNumber, entry.fileName)
      setSnapshot(restored)
      setDraft(restored)
      setEditing(false)
      await refreshHistory()
      setSaveMessage("已恢复历史快照，并自动重建小说记忆。")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveMessage(`恢复失败：${message}`)
    } finally {
      setRestoring(false)
    }
  }

  // TASK-303: 历史条目无 content 字段，按 entry.path readFile 读取历史 JSON，
  // 解析后重排为 2 空格缩进，与当前快照文本（JSON.stringify(snapshot, null, 2)）做只读 diff。
  const compareHistory = async (entry: SnapshotHistoryEntry) => {
    /* v8 ignore next */
    if (restoring || saving) return
    setSaveMessage("")
    try {
      const raw = await readFile(entry.path)
      setDiffState({ open: true, original: JSON.stringify(JSON.parse(raw), null, 2) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSaveMessage(`对比失败：${message}`)
    }
  }

  const editList = (key: keyof ChapterSnapshot, value: string) => {
    /* v8 ignore next */
    setDraft((current) => current ? updateListField(current, key, value) : current)
  }

  const editText = (key: keyof ChapterSnapshot, value: string) => {
    /* v8 ignore next */
    setDraft((current) => current ? updateTextField(current, key, value) : current)
  }

  const renderReadOnly = (data: ChapterSnapshot) => (
    <div className="space-y-2">
      <TextSection title={t("novel.snapshot.summary")} content={data.summary} />
      <Section title={t("novel.snapshot.characters")} items={data.characters} />
      <Section title={t("novel.snapshot.locations")} items={data.locations} />
      <Section title={t("novel.snapshot.organizations")} items={data.organizations} />
      <Section title={t("novel.snapshot.items")} items={data.items} />
      <Section title={t("novel.snapshot.events")} items={data.events} />
      <Section title={t("novel.snapshot.characterStateChanges")} items={data.characterStateChanges} />
      <Section title={t("novel.snapshot.relationshipChanges")} items={data.relationshipChanges} />
      <Section title={t("novel.snapshot.knowledgeChanges")} items={data.knowledgeChanges} />
      <Section title={t("novel.snapshot.foreshadowingChanges")} items={data.foreshadowingChanges} />
      <Section title={t("novel.snapshot.newCanonFacts")} items={data.newCanonFacts} />
      <Section title={t("novel.snapshot.timelineEvents")} items={data.timelineEvents} />
      <Section title={t("novel.snapshot.conflicts")} items={data.conflicts} />
      <TextSection title={t("novel.snapshot.endingHook")} content={data.endingHook} />
      <Section title="图谱节点" items={data.graphNodes} />
      <Section title="图谱关系边" items={data.graphEdges} />
    </div>
  )

  const renderEditor = (data: ChapterSnapshot) => (
    <div className="space-y-2">
      <EditableTextSection title={t("novel.snapshot.summary")} value={data.summary} onChange={(value) => editText("summary", value)} />
      <EditableListSection title={t("novel.snapshot.characters")} value={data.characters} onChange={(value) => editList("characters", value)} />
      <EditableListSection title={t("novel.snapshot.locations")} value={data.locations} onChange={(value) => editList("locations", value)} />
      <EditableListSection title={t("novel.snapshot.organizations")} value={data.organizations} onChange={(value) => editList("organizations", value)} />
      <EditableListSection title={t("novel.snapshot.items")} value={data.items} onChange={(value) => editList("items", value)} />
      <EditableListSection title={t("novel.snapshot.events")} value={data.events} onChange={(value) => editList("events", value)} />
      <EditableListSection title={t("novel.snapshot.characterStateChanges")} value={data.characterStateChanges} onChange={(value) => editList("characterStateChanges", value)} />
      <EditableListSection title={t("novel.snapshot.relationshipChanges")} value={data.relationshipChanges} onChange={(value) => editList("relationshipChanges", value)} />
      <EditableListSection title={t("novel.snapshot.knowledgeChanges")} value={data.knowledgeChanges} onChange={(value) => editList("knowledgeChanges", value)} />
      <EditableListSection title={t("novel.snapshot.foreshadowingChanges")} value={data.foreshadowingChanges} onChange={(value) => editList("foreshadowingChanges", value)} />
      <EditableListSection title={t("novel.snapshot.newCanonFacts")} value={data.newCanonFacts} onChange={(value) => editList("newCanonFacts", value)} />
      <EditableListSection title={t("novel.snapshot.timelineEvents")} value={data.timelineEvents} onChange={(value) => editList("timelineEvents", value)} />
      <EditableListSection title={t("novel.snapshot.conflicts")} value={data.conflicts} onChange={(value) => editList("conflicts", value)} />
      <EditableTextSection title={t("novel.snapshot.endingHook")} value={data.endingHook} onChange={(value) => editText("endingHook", value)} />
      <EditableListSection title="图谱节点" value={data.graphNodes} onChange={(value) => editList("graphNodes", value)} />
      <EditableListSection title="图谱关系边" value={data.graphEdges} onChange={(value) => editList("graphEdges", value)} />
    </div>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={chapterNumber < 0 && snapshot?.chapterTitle
          ? `${snapshot.chapterTitle}快照`
          : t("novel.snapshot.title", { number: chapterNumber })}
        tabIndex={-1}
        className="flex max-h-[80vh] w-[720px] flex-col rounded-lg border border-border bg-background shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-foreground">
              {chapterNumber < 0 && snapshot?.chapterTitle
                ? `${snapshot.chapterTitle}快照`
                : t("novel.snapshot.title", { number: chapterNumber })}
            </h3>
            {snapshot && !loading ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {snapshot.memorySyncedAt
                  ? t("novel.snapshot.memorySyncedAt", { time: formatSyncTime(snapshot.memorySyncedAt) })
                  : t("novel.snapshot.notSynced")}
              </p>
            ) : null}
            {saveMessage ? <p className="mt-1 text-xs text-muted-foreground">{saveMessage}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {snapshot && !loading ? (
              <button
                type="button"
                onClick={() => setShowHistory((value) => !value)}
                disabled={saving || restoring}
                title="查看保存快照前自动备份的历史版本，可恢复旧快照但不会自动同步记忆。"
                className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                历史版本
              </button>
            ) : null}
            {snapshot && !loading ? (
              editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => void saveEditing()}
                    disabled={saving}
                    className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? "保存中" : "保存"}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditing}
                    disabled={saving}
                    className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={startEditing}
                  className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
                >
                  编辑
                </button>
              )
            ) : null}
            <button
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 py-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("novel.snapshot.loading")}</p>
          ) : !snapshot ? (
            <p className="text-sm text-muted-foreground">{t("novel.snapshot.noSnapshot")}</p>
          ) : (
            <>
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                这些内容会加入小说记忆与后续上下文。AI 生成新章节时会依托这些摘要、人物状态、角色认知、伏笔和时间线进行续写。如果这里有错误，可能会影响后续剧情连贯性，请在保存前检查并修正。保存后会影响后续上下文中读取的快照内容，但不会自动重建实体页、角色认知、伏笔追踪等衍生记忆。
              </div>
              {showHistory ? (
                <div className="mb-4 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <div className="mb-2 text-sm font-medium text-foreground">历史版本</div>
                  {history.length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无历史版本。保存快照时会自动备份旧版本。</p>
                  ) : (
                    <div className="space-y-2">
                      {history.map((entry) => (
                        <HistoryEntryRow
                          key={entry.fileName}
                          entry={entry}
                          disabled={restoring || saving}
                          restoring={restoring}
                          onCompare={() => void compareHistory(entry)}
                          onRestore={() => void restoreHistory(entry)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              {editing && draft ? renderEditor(draft) : renderReadOnly(snapshot)}
              <div className="border-t border-border pt-2">
                <button
                  onClick={() => setShowJson(!showJson)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {showJson ? "▲ " : "▼ "}{t("novel.snapshot.jsonDetails")}
                </button>
                {showJson && (
                  <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs text-muted-foreground">
                    {JSON.stringify(editing && draft ? draft : snapshot, null, 2)}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <SnapshotDiffModal
        open={diffState.open}
        original={diffState.original}
        modified={snapshot ? JSON.stringify(snapshot, null, 2) : ""}
        onClose={() => setDiffState((value) => ({ ...value, open: false }))}
      />
    </div>
  )
}
