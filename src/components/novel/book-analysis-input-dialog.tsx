import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FileText, AlertCircle } from "lucide-react"

interface BookAnalysisInputDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (config: {
    sourceType: "file"
    sourcePath: string
  }) => void
}

export function BookAnalysisInputDialog({
  open,
  onOpenChange,
  onSubmit,
}: BookAnalysisInputDialogProps) {
  const { t } = useTranslation()
  const [filePath, setFilePath] = useState("")
  const [error, setError] = useState("")

  const handleSelectFile = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
      const selected = await openDialog({
        multiple: false,
        filters: [
          {
            name: "文本文件",
            extensions: ["txt"],
          },
        ],
      })

      if (selected && typeof selected === "string") {
        setFilePath(selected)
        setError("")
      }
    } catch (err) {
      setError("选择文件失败")
      console.error(err)
    }
  }

  const handleSubmit = () => {
    setError("")

    if (!filePath.trim()) {
      setError("请选择一个TXT文件")
      return
    }

    onSubmit({
      sourceType: "file",
      sourcePath: filePath,
    })

    // 重置表单
    setFilePath("")
    setError("")
  }

  const handleCancel = () => {
    setError("")
    setFilePath("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("bookAnalysis.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* 文件选择 */}
          <div className="space-y-2">
            <Label>{t("bookAnalysis.selectNovelFile")}</Label>
            <div className="flex gap-2">
              <Input
                value={filePath}
                placeholder={t("bookAnalysis.selectTxtHint")}
                readOnly
                className="flex-1"
              />
              <Button onClick={handleSelectFile} variant="outline">
                <FileText className="h-4 w-4 mr-2" />
                浏览
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              支持UTF-8和GBK编码的TXT文件，建议大小在50MB以内
            </p>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-md">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {/* 说明 */}
          <div className="p-4 bg-muted rounded-md text-sm text-muted-foreground space-y-2">
            <p className="font-medium text-foreground">{t("bookAnalysis.afterImport")}</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>{t("bookAnalysis.capabilityChapters")}</li>
              <li>{t("bookAnalysis.capabilityCharacters")}</li>
              <li>{t("bookAnalysis.capabilitySkills")}</li>
              <li>{t("bookAnalysis.capabilityLibrary")}</li>
            </ul>
            <p className="text-xs mt-3 text-muted-foreground/80">
              💡 提示：大型小说（500+章）分析耗时较长，支持随时暂停和继续
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            取消
          </Button>
          <Button onClick={handleSubmit}>{t("bookAnalysis.start")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
