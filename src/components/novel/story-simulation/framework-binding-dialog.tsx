import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { useWikiStore } from "@/stores/wiki-store"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import {
  saveBinding,
  clearBinding,
} from "@/lib/novel/story-simulation/framework-binding"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { StoryFramework } from "@/lib/novel/story-simulation/types"

const CHAPTER_OPTIONS = [5, 10, 20, 30, 50]

interface FrameworkBindingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  framework: StoryFramework
  onBound: () => void
}

export function FrameworkBindingDialog({
  open,
  onOpenChange,
  framework,
  onBound,
}: FrameworkBindingDialogProps) {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const bumpBindingVersion = useWikiStore((s) => s.bumpBindingVersion)
  const binding = useStorySimulationStore((s) => s.binding)
  const setBinding = useStorySimulationStore((s) => s.setBinding)

  const [chapterCount, setChapterCount] = useState(10)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isBound = binding?.frameworkId === framework.id

  useEffect(() => {
    if (!open) return
    const bound =
      binding && binding.frameworkId === framework.id ? binding : null
    setChapterCount(bound ? bound.targetChapterCount : 10)
    setError(null)
  }, [open, binding, framework])

  const handleConfirm = async () => {
    if (!projectPath) return
    setSubmitting(true)
    setError(null)
    try {
      const updated = await saveBinding(projectPath, framework, chapterCount)
      setBinding(updated)
      bumpBindingVersion()
      onBound()
      onOpenChange(false)
    } catch (err) {
      setError(t("storySimulation.bindingFailed"))
      console.error(err)
    } finally {
      setSubmitting(false)
    }
  }

  const handleClear = async () => {
    if (!projectPath) return
    setSubmitting(true)
    setError(null)
    try {
      await clearBinding(projectPath)
      setBinding(null)
      bumpBindingVersion()
      onBound()
      onOpenChange(false)
    } catch (err) {
      setError(t("storySimulation.unbindFailed"))
      console.error(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t("storySimulation.bindDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("storySimulation.bindDialogDesc", { title: framework.title })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <span className="text-sm font-medium">{t("storySimulation.targetChapters")}</span>
            <div className="flex flex-wrap gap-2">
              {CHAPTER_OPTIONS.map((count) => (
                <Button
                  key={count}
                  size="sm"
                  variant={chapterCount === count ? "default" : "outline"}
                  onClick={() => setChapterCount(count)}
                  disabled={submitting}
                >
                  {count} {t("storySimulation.chapters")}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("storySimulation.bindNodeSummary", { count: framework.nodes.length })}
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          {isBound && (
            <Button
              variant="destructive"
              onClick={handleClear}
              disabled={submitting}
            >
              {t("storySimulation.unbind")}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("storySimulation.close")}
          </Button>
          <Button onClick={handleConfirm} disabled={submitting}>
            {submitting ? t("storySimulation.processing") : t("storySimulation.confirmBinding")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
