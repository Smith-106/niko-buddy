import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MonacoDiffEditor } from "./monaco-diff-editor"
import { useTranslation } from "react-i18next"

export interface DeAiPreviewDialogProps {
  open: boolean
  sourceContent: string
  candidateContent: string
  onApply: () => void
  onSaveDraft: () => void
  onClose: () => void
}

export function DeAiPreviewDialog({
  open,
  sourceContent,
  candidateContent,
  onApply,
  onSaveDraft,
  onClose,
}: DeAiPreviewDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("novel.deai.preview")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <MonacoDiffEditor
            original={sourceContent}
            modified={candidateContent}
            height={480}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="outline" onClick={onSaveDraft}>{t("novel.deai.saveDraft")}</Button>
          <Button onClick={onApply}>{t("novel.deai.replaceBody")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
