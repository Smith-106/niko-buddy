// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useCallback } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { useTranslation } from "react-i18next"
import { readFile, writeFileAtomic, createDirectory, fileExists } from "@/commands/fs"
import { buildEditableGraphNodePage } from "@/lib/graph-node-page"
import type { GraphNode } from "@/lib/wiki-graph"
import type { EmbeddingConfig } from "@/stores/wiki-store"

/**
 * Manages graph node inline editing operations.
 *
 * Responsibilities:
 * - Edit a wiki page node inline via textarea edit box
 * - Save edited content to disk with embedding reindex if enabled
 * - Cancel editing and reset state
 * - Open or create a new wiki profile page for a node
 *
 * Extracted from graph-view.tsx to isolate node-editing concern from the main
 * graph component logic.
 */
export function useGraphNodeEditing() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const handleEditNode = useCallback(
    async (node: GraphNode) => {
      if (!project) return
      const page = buildEditableGraphNodePage(project.path, node)
      let content = page.content
      try {
        if (await fileExists(page.path)) {
          content = await readFile(page.path)
        }
      } catch {
        content = page.content
      }
      return {
        path: page.path,
        content,
        title: page.title,
      }
    },
    [project],
  )

  const handleOpenNodeProfilePage = useCallback(
    async (node: GraphNode) => {
      if (!project) return
      const page = buildEditableGraphNodePage(project.path, node)
      let content = page.content
      let created = false
      try {
        if (await fileExists(page.path)) {
          content = await readFile(page.path)
        } else {
          const dir = page.path.split(/[/\\]/).slice(0, -1).join("/")
          if (dir) await createDirectory(dir)
          await writeFileAtomic(page.path, content)
          created = true
        }
        setSelectedFile(page.path)
        setFileContent(content)
        // setActiveView("sources") should be called by caller
        if (created) bumpDataVersion()
      } catch (err) {
        console.error("Failed to open graph node profile page:", err)
      }
    },
    [project, setSelectedFile, setFileContent, bumpDataVersion],
  )

  const handleSaveNodeEdit = useCallback(
    async (params: {
      editingPath: string
      editingContent: string
      editingNode: GraphNode | null
      embeddingConfig?: EmbeddingConfig
    }) => {
      const { editingPath, editingContent, editingNode, embeddingConfig } = params
      if (!project || !editingNode || !editingPath) return { success: false as const }
      try {
        const dir = editingPath.split(/[/\\]/).slice(0, -1).join("/")
        if (dir) await createDirectory(dir)
        await writeFileAtomic(editingPath, editingContent)
        const page = buildEditableGraphNodePage(project.path, editingNode)

        if (embeddingConfig?.enabled && embeddingConfig.model) {
          const { embedPage } = await import("@/lib/embedding")
          await embedPage(project.path, page.pageId, page.title, editingContent, embeddingConfig)
        }

        return {
          success: true as const,
          msg: embeddingConfig?.enabled && embeddingConfig.model
            ? t("graph.savedRealProfileWithEmbedding")
            : t("graph.savedRealProfile"),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t("graph.saveNodeFailed")
        return { success: false as const, msg: message }
      }
    },
    [project, t],
  )

  const handleCancelNodeEdit = useCallback(() => {
    return {
      editingNode: null,
      editingPath: "",
      editingContent: "",
      editStatus: null,
    }
  }, [])

  return {
    handleEditNode,
    handleOpenNodeProfilePage,
    handleSaveNodeEdit,
    handleCancelNodeEdit,
    bumpDataVersion,
  }
}
