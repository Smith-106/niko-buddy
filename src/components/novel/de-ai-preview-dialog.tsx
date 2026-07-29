import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { MonacoDiffEditor } from "./monaco-diff-editor"

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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>去AI味预览</DialogTitle>
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
          <Button variant="outline" onClick={onSaveDraft}>另存草稿</Button>
          <Button onClick={onApply}>替换正文</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
