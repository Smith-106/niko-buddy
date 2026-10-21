import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useWikiStore } from "@/stores/wiki-store"
import { readSoulDoc, writeSoulDoc } from "@/lib/novel"
import { WikiReader } from "@/components/editor/wiki-reader"
import i18n from "@/i18n"

type SoulDocMode = "read" | "edit"

export function SoulDocEditor() {
  const project = useWikiStore((s) => s.project)
  const [content, setContent] = useState("")
  const [mode, setMode] = useState<SoulDocMode>("read")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!project) return
    // DEBUG#6：切换项目时，上一项目的 readSoulDoc 晚到会覆盖当前正文（可能随后被保存）。
    let cancelled = false
    const path = project.path
    readSoulDoc(path)
      .then((text) => {
        if (!cancelled) setContent(text)
      })
      .catch(() => {
        if (!cancelled) setContent("")
      })
    return () => {
      cancelled = true
    }
  }, [project?.path])

  async function handleSave() {
    if (!project) return
    setSaving(true)
    try {
      await writeSoulDoc(project.path, content)
      setMessage(i18n.t("novel.soul.saveProjectSoulSuccess"))
    } catch {
      setMessage(i18n.t("novel.soul.saveProjectSoulFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <Label>{i18n.t("novel.soul.projectSoul")}</Label>
          <div className="flex shrink-0 gap-1" role="group" aria-label={i18n.t("novel.soul.projectSoul")}>
            <Button
              size="sm"
              variant={mode === "read" ? "secondary" : "ghost"}
              onClick={() => setMode("read")}
            >
              {i18n.t("novel.soul.readMode")}
            </Button>
            <Button
              size="sm"
              variant={mode === "edit" ? "secondary" : "ghost"}
              onClick={() => setMode("edit")}
            >
              {i18n.t("novel.soul.editMode")}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {i18n.t("novel.soul.projectSoulDesc")}
        </p>
      </div>
      {mode === "read" ? (
        <div className="min-h-[300px] rounded-md border bg-card p-4">
          {content.trim() ? (
            <WikiReader body={content} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {i18n.t("novel.soul.projectSoulPlaceholder")}
            </p>
          )}
        </div>
      ) : (
        <>
          <Textarea
            className="min-h-[300px] font-mono text-sm"
            placeholder={i18n.t("novel.soul.projectSoulPlaceholder")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving || content.trim() === ""}>
              {saving ? "..." : i18n.t("novel.soul.saveProjectSoul")}
            </Button>
            {message && <span className="text-sm text-muted-foreground">{message}</span>}
          </div>
        </>
      )}
    </div>
  )
}
