import { useState, useEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { join } from "@tauri-apps/api/path"

// 从新的skill文件导入默认规则
import defaultDeAiSkill from "../../../skills/de-ai-writing/SKILL.md?raw"
import {
  TIERED_DEAI_TABLE,
  computeTieredDeAiStats,
  type TieredDeAiEntry,
  type TieredDeAiTier,
} from "@/lib/novel/de-ai-tiered-table"

const DEFAULT_DE_AI_SKILL = defaultDeAiSkill.trim()

/** 编辑模式: 结构化分级表 / 自由文本 */
type EditorTab = "tiered" | "free-text"

/** 单条分级表编辑状态 */
interface EditableTieredEntry {
  index: number
  term: string
  tier: TieredDeAiTier
  category: string
  weight: number
  suggestion: string
  /** 是否已修改 (视觉标记) */
  dirty: boolean
}

/** 将只读表转为可编辑状态 */
function toEditableEntries(table: readonly TieredDeAiEntry[]): EditableTieredEntry[] {
  return table.map((e, i) => ({
    index: i,
    term: e.term,
    tier: e.tier,
    category: e.category,
    weight: e.weight,
    suggestion: e.suggestion,
    dirty: false,
  }))
}

export function DeAiSkillEditor() {
  const project = useWikiStore((s) => s.project)
  const [activeTab, setActiveTab] = useState<EditorTab>("free-text")
  // 自由文本状态
  const [content, setContent] = useState("")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [isDefault, setIsDefault] = useState(true)
  // 结构化分级状态
  const [entries, setEntries] = useState<EditableTieredEntry[]>(() => toEditableEntries(TIERED_DEAI_TABLE))
  const [filterTier, setFilterTier] = useState<TieredDeAiTier | "all">("all")
  const [searchTerm, setSearchTerm] = useState("")

  const stats = useMemo(() => computeTieredDeAiStats(), [])

  const filteredEntries = useMemo(() => {
    let result = entries
    if (filterTier !== "all") {
      result = result.filter((e) => e.tier === filterTier)
    }
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase()
      result = result.filter(
        (e) =>
          e.term.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          e.suggestion.toLowerCase().includes(q),
      )
    }
    return result
  }, [entries, filterTier, searchTerm])

  useEffect(() => {
    if (!project) return
    loadSkill()
  }, [project?.path])

  async function loadSkill() {
    /* v8 ignore next */
    if (!project) return
    try {
      const skillPath = await join(project.path, "de-ai-skill.txt")
      const skillContent = await readFile(skillPath)
      setContent(skillContent)
      setIsDefault(false)
    } catch {
      setContent(DEFAULT_DE_AI_SKILL)
      setIsDefault(true)
    }
  }

  async function handleSave() {
    if (!project) return
    setSaving(true)
    try {
      const skillPath = await join(project.path, "de-ai-skill.txt")
      await writeFile(skillPath, content)
      setMessage("保存成功")
      setIsDefault(false)
    } catch {
      setMessage("保存失败，请稍后重试")
    } finally {
      setSaving(false)
      setTimeout(() => setMessage(""), 2000)
    }
  }

  async function handleReset() {
    setContent(DEFAULT_DE_AI_SKILL)
    setMessage("已重置为默认规则")
    setTimeout(() => setMessage(""), 2000)
  }

  function handleTierChange(index: number, newTier: TieredDeAiTier) {
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, tier: newTier, dirty: true } : e)),
    )
  }

  function handleWeightChange(index: number, newWeight: number) {
    const clamped = Math.round(Math.max(0, Math.min(1, newWeight)) * 100) / 100
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, weight: clamped, dirty: true } : e)),
    )
  }

  function handleSuggestionChange(index: number, newSuggestion: string) {
    setEntries((prev) =>
      prev.map((e) => (e.index === index ? { ...e, suggestion: newSuggestion, dirty: true } : e)),
    )
  }

  function handleResetTable() {
    setEntries(toEditableEntries(TIERED_DEAI_TABLE))
    setMessage("已重置分级表为默认")
    setTimeout(() => setMessage(""), 2000)
  }

  const dirtyCount = entries.filter((e) => e.dirty).length

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Label>去AI味Skill</Label>
        <p className="text-sm text-muted-foreground mt-1">
          自定义去AI味规则，将应用到全局所有去AI味功能（章节去AI味、选中文本去AI味、AI会话深度思考阶段6）
        </p>
        {isDefault && activeTab === "free-text" && (
          <p className="text-xs text-amber-600 mt-2">
            当前使用系统默认skill（de-AI-writing - 12项硬门槛 + 24项AI痕迹检测）。保存后将创建项目自定义规则文件，优先级最高。
          </p>
        )}
      </div>

      {/* 切换标签 */}
      <div className="flex gap-1 border-b">
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "free-text"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("free-text")}
        >
          自由文本
        </button>
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "tiered"
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("tiered")}
        >
          结构化分级
          {dirtyCount > 0 && (
            <span className="ml-2 text-xs text-amber-500">({dirtyCount}改)</span>
          )}
        </button>
      </div>

      {activeTab === "free-text" && (
        <>
          <Textarea
            className="min-h-[400px] font-mono text-sm"
            placeholder="在此输入你的去AI味规则..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving || content.trim() === ""}>
              {saving ? "保存中..." : "保存"}
            </Button>
            <Button onClick={handleReset} variant="outline" disabled={saving}>
              重置为默认
            </Button>
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
          </div>
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium mb-2">使用提示：</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>编辑规则后点击"保存"，将自动应用到所有去AI味功能</li>
              <li>系统默认使用 de-AI-writing skill（保真改写，适合网络小说）</li>
              <li>支持多行文本，可以使用分点、分段的形式组织规则</li>
              <li>规则会保存为项目根目录下的 de-ai-skill.txt 文件（优先级最高）</li>
              <li>完整skill系统位于软件安装目录的 skills/ 文件夹，包含 references/ 详细规则</li>
            </ul>
          </div>
        </>
      )}

      {activeTab === "tiered" && (
        <>
          {/* 统计概览 */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span>共 {stats.totalEntries} 词</span>
            <span>1A 高 {stats.tierCounts["1A"]}</span>
            <span>1B 低 {stats.tierCounts["1B"]}</span>
            <span>3 弱 {stats.tierCounts["3"]}</span>
            <span>权重范围 {stats.weightRange.min}-{stats.weightRange.max}</span>
            <span className="text-amber-600">信号非证据 · 误报率 &gt;60%</span>
          </div>

          {/* 过滤器 */}
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded border bg-background px-2 text-xs"
              value={filterTier}
              onChange={(e) => setFilterTier(e.target.value as TieredDeAiTier | "all")}
            >
              <option value="all">全部分级</option>
              <option value="1A">1A 高权重</option>
              <option value="1B">1B 低权重</option>
              <option value="3">3 弱提示</option>
            </select>
            <Input
              className="h-8 w-48 text-xs"
              placeholder="搜索词/分类/建议..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              显示 {filteredEntries.length}/{entries.length} 条
            </span>
          </div>

          {/* 分级表 */}
          <div className="overflow-auto max-h-[500px] border rounded-md">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="border-b">
                  <th className="px-2 py-1.5 text-left font-medium w-28">词/短语</th>
                  <th className="px-2 py-1.5 text-left font-medium w-16">分级</th>
                  <th className="px-2 py-1.5 text-left font-medium w-20">分类</th>
                  <th className="px-2 py-1.5 text-left font-medium w-16">权重</th>
                  <th className="px-2 py-1.5 text-left font-medium">改写建议</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr
                    key={entry.index}
                    className={`border-b hover:bg-muted/30 ${
                      entry.dirty ? "bg-amber-50 dark:bg-amber-950/20" : ""
                    }`}
                  >
                    <td className="px-2 py-1.5 font-mono">{entry.term}</td>
                    <td className="px-2 py-1.5">
                      <select
                        className={`h-7 w-14 rounded border bg-background px-1 text-xs font-medium ${
                          entry.tier === "1A"
                            ? "text-red-600"
                            : entry.tier === "1B"
                              ? "text-amber-600"
                              : "text-blue-600"
                        }`}
                        value={entry.tier}
                        onChange={(e) => handleTierChange(entry.index, e.target.value as TieredDeAiTier)}
                      >
                        <option value="1A">1A</option>
                        <option value="1B">1B</option>
                        <option value="3">3</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{entry.category}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          className="w-12 h-3"
                          value={entry.weight}
                          onChange={(e) => handleWeightChange(entry.index, parseFloat(e.target.value))}
                        />
                        <span className="w-5 text-right">{entry.weight.toFixed(1)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        className="w-full bg-transparent border-b border-dashed border-muted-foreground/30 text-xs px-1 py-0.5 focus:outline-none focus:border-primary"
                        value={entry.suggestion}
                        onChange={(e) => handleSuggestionChange(entry.index, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleResetTable}>
              重置分级表
            </Button>
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
          </div>

          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium mb-2">分级说明：</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>
                <span className="text-red-600 font-medium">1A 高权重</span> — 强 AI 信号（总结腔/解释腔/模板句首/机械公式），共 {stats.tierCounts["1A"]} 词
              </li>
              <li>
                <span className="text-amber-600 font-medium">1B 低权重</span> — 弱 AI 信号（装饰副词/模糊限制/机械过渡），仅轻提示不升压，共 {stats.tierCounts["1B"]} 词
              </li>
              <li>
                <span className="text-blue-600 font-medium">3 弱提示</span> — 边缘信号（轻度 AI 腔/弱解释），仅参考不断，共 {stats.tierCounts["3"]} 词
              </li>
              <li className="text-amber-600">
                保持「信号非证据」立场，误报率 &gt;60%，1B 不升级为 Anti-AI(P1) 硬门控
              </li>
              <li>保留 de-ai-skill.txt 兜底通道（自由文本标签）</li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
