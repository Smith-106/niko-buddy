// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useState, useEffect, useRef } from "react"
import { useWikiStore } from "@/stores/wiki-store"

/**
 * Manages Sigma.js lifecycle in response to layout changes.
 *
 * Sigma crashes with "could not find suitable program for node type circle"
 * when its canvas is resized by external layout changes (panel open/close,
 * drag-resize). This hook detects such changes and forces a Sigma remount
 * via an incrementing key, with a brief isResizing guard to show a
 * placeholder instead of a crashing canvas.
 *
 * Detects two resize triggers:
 * 1. Panel open/close — monitored via selectedFile and showInsights changes
 * 2. Panel drag-resize — monitored via body[data-panel-resizing] mutation
 *
 * Extracted from graph-view.tsx to isolate WebGL lifecycle management.
 */
export function useGraphLayout(showInsights: boolean) {
  const selectedFileForLayout = useWikiStore((s) => s.selectedFile)
  const [sigmaKey, setSigmaKey] = useState(0)
  const [isResizing, setIsResizing] = useState(false)

  const layoutKey = `${!!selectedFileForLayout}-${showInsights}`
  const prevLayoutKey = useRef(layoutKey)

  // Detect panel open/close (selectedFile, insights)
  useEffect(() => {
    if (prevLayoutKey.current !== layoutKey) {
      prevLayoutKey.current = layoutKey
      setIsResizing(true)
      const timer = setTimeout(() => {
        setSigmaKey((k) => k + 1)
        setIsResizing(false)
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [layoutKey])

  // Detect panel drag resize via data-panel-resizing attribute on body
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dragging = document.body.dataset.panelResizing === "true"
      if (dragging && !isResizing) {
        setIsResizing(true)
      }
      if (!dragging && isResizing) {
        // Drag ended — remount sigma after a tick
        setTimeout(() => {
          setSigmaKey((k) => k + 1)
          setIsResizing(false)
        }, 50)
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-panel-resizing"] })
    return () => observer.disconnect()
  }, [isResizing])

  return {
    sigmaKey,
    isResizing,
    setSigmaKey,
  }
}
