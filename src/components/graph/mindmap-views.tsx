import { useSigma } from "@react-sigma/core"
import { ZoomIn, ZoomOut, Maximize } from "lucide-react"
import { Button } from "@/components/ui/button"
import { type MindMapNode } from "@/lib/graph-readable"

export function MindMapBranch({ node, level = 0 }: { node: MindMapNode; level?: number }) {
  return (
    <div className={level === 0 ? "space-y-2" : "ml-4 border-l border-border pl-3"}>
      <div className="rounded border bg-background px-3 py-2 text-sm shadow-sm">
        {node.label}
      </div>
      {node.children.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.children.map((child) => (
            <MindMapBranch key={child.id} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function MindMapGraphView({ mindMap }: { mindMap: MindMapNode[] }) {
  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="min-w-[720px] space-y-3">
        {mindMap.map((node) => (
          <MindMapBranch key={node.id} node={node} />
        ))}
      </div>
    </div>
  )
}

export function ZoomControls() {
  const sigma = useSigma()

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1">
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedZoom({ duration: 200 })
        }}
      >
        <ZoomIn className="h-3.5 w-3.5 shrink-0" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedUnzoom({ duration: 200 })
        }}
      >
        <ZoomOut className="h-3.5 w-3.5 shrink-0" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedReset({ duration: 300 })
        }}
      >
        <Maximize className="h-3.5 w-3.5 shrink-0" />
      </Button>
    </div>
  )
}
