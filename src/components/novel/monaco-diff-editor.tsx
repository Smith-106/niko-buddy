import { useEffect, useRef } from "react"
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react"
import { configureMonaco } from "@/lib/novel/monaco-loader"

export interface MonacoDiffEditorProps {
  original: string
  modified: string
  language?: string
  height?: number
  readOnly?: boolean
  onModifiedChange?: (text: string) => void
}

/**
 * Monaco 差异编辑器封装（RPC-2 / TASK-004）。
 * 渲染 original ↔ modified 的可编辑 diff（左右分栏），供 de-ai 预览与
 * review finding 改写对比复用。
 */
export function MonacoDiffEditor({
  original,
  modified,
  language = "markdown",
  height = 480,
  readOnly = false,
  onModifiedChange,
}: MonacoDiffEditorProps) {
  const configured = useRef(false)
  useEffect(() => {
    if (!configured.current) {
      configureMonaco()
      configured.current = true
    }
  }, [])

  const handleMount: DiffOnMount = (editor) => {
    const modifiedEditor = editor.getModifiedEditor()
    modifiedEditor.onDidChangeModelContent(() => {
      onModifiedChange?.(modifiedEditor.getValue())
    })
  }

  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      height={height}
      theme="vs"
      onMount={handleMount}
      options={{
        readOnly,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      }}
    />
  )
}
