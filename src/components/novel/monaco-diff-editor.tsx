import { useEffect, useRef } from "react"
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react"
import { configureMonaco } from "@/lib/novel"

// P0-15：loader.config 全局 once，多实例/多路由不再重复初始化。
let monacoConfiguredOnce = false

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
  // P0-2：onDidChangeModelContent 返回的 disposable 必须显式释放，否则
  // model 重建/组件卸载时旧监听器残留导致内存泄漏。
  const contentDisposable = useRef<{ dispose(): void } | null>(null)
  const onModifiedChangeRef = useRef(onModifiedChange)
  onModifiedChangeRef.current = onModifiedChange
  useEffect(() => {
    if (monacoConfiguredOnce) {
      configured.current = true
      return
    }
    if (!configured.current) {
      configureMonaco()
      configured.current = true
      monacoConfiguredOnce = true
    }
  }, [])
  useEffect(() => {
    return () => {
      contentDisposable.current?.dispose()
      contentDisposable.current = null
    }
  }, [])

  const handleMount: DiffOnMount = (editor) => {
    const modifiedEditor = editor.getModifiedEditor()
    contentDisposable.current?.dispose()
    contentDisposable.current = modifiedEditor.onDidChangeModelContent(() => {
      onModifiedChangeRef.current?.(modifiedEditor.getValue())
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
