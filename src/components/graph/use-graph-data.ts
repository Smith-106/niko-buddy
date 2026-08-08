// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useState, useEffect, useRef, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { buildWikiGraph, type GraphNode, type GraphEdge, type CommunityInfo } from "@/lib/wiki-graph"
import { findSurprisingConnections, detectKnowledgeGaps, type SurprisingConnection, type KnowledgeGap } from "@/lib/graph-insights"
import { normalizePath } from "@/lib/path-utils"
import { loadForeshadowingTracker, type ForeshadowingStore } from "@/lib/novel/foreshadowing-tracker"

/**
 * Manages graph data loading, versioning, and derived state.
 *
 * Responsibilities:
 * - Load graph data (nodes, edges, communities) via buildWikiGraph
 * - Track dataVersion to reload when wiki data changes
 * - Compute surprising connections and knowledge gaps
 * - Load foreshadowing tracker for novel mode
 * - Provide refresh capability for manual reloads
 *
 * Extracted from graph-view.tsx to isolate data-loading concern.
 */
export function useGraphData() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setRefreshGraph = useWikiStore((s) => s.setRefreshGraph)

  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [communities, setCommunities] = useState<CommunityInfo[]>([])
  const [surprisingConns, setSurprisingConns] = useState<SurprisingConnection[]>([])
  const [knowledgeGaps, setKnowledgeGaps] = useState<KnowledgeGap[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [foreshadowingStore, setForeshadowingStore] = useState<ForeshadowingStore | null>(null)

  const lastLoadedVersion = useRef(-1)

  const loadGraph = useCallback(async () => {
    if (!project) return
    setLoading(true)
    setError(null)
    try {
      const result = await buildWikiGraph(normalizePath(project.path))
      setNodes(result.nodes)
      setEdges(result.edges)
      setCommunities(result.communities)
      setSurprisingConns(findSurprisingConnections(result.nodes, result.edges, result.communities))
      setKnowledgeGaps(detectKnowledgeGaps(result.nodes, result.edges, result.communities))
      lastLoadedVersion.current = useWikiStore.getState().dataVersion
    } catch (err) {
      const message = err instanceof Error ? err.message : t("graph.buildFailed")
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [project])

  useEffect(() => {
    setRefreshGraph(() => loadGraph)
    return () => setRefreshGraph(null)
  }, [loadGraph, setRefreshGraph])

  useEffect(() => {
    if (!project) return
    loadForeshadowingTracker(project.path)
      .then(setForeshadowingStore)
      .catch(() => setForeshadowingStore(null))
  }, [project])

  useEffect(() => {
    if (dataVersion !== lastLoadedVersion.current) {
      loadGraph()
    }
  }, [loadGraph, dataVersion])

  return {
    nodes,
    edges,
    communities,
    surprisingConns,
    knowledgeGaps,
    loading,
    error,
    foreshadowingStore,
    loadGraph,
  }
}
