import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, GripVertical, Pencil, X } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStorySimulationStore } from "@/stores/story-simulation-store";
import type { StoryNode } from "@/lib/novel/story-simulation/types";
import { cn } from "@/lib/utils";

interface FrameworkConfirmPanelProps {
  onConfirm: () => void;
  onRegenerate: () => void;
  onSave?: () => void;
  onViewHistory?: () => void; // 新增：查看历史结果
}

// 起/承/转/合 阶段对应的标签配色
const PHASE_STYLES: Record<StoryNode["phase"], string> = {
  起: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  承: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  转: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  合: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
};

export function FrameworkConfirmPanel({
  onConfirm,
  onRegenerate,
  onSave,
  onViewHistory,
}: FrameworkConfirmPanelProps) {
  const { t } = useTranslation();
  const currentFramework = useStorySimulationStore((s) => s.currentFramework);
  const setCurrentFramework = useStorySimulationStore(
    (s) => s.setCurrentFramework,
  );
  const [savedTip, setSavedTip] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingPremise, setEditingPremise] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [shortTitleDraft, setShortTitleDraft] = useState("");
  const [premiseDraft, setPremiseDraft] = useState("");

  // 拖拽传感器（需在 early return 之前调用，避免违反 Rules of Hooks）
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (!currentFramework) return null;

  // 节点按 index 排序后的引用，供渲染与拖拽复用
  const sortedNodes = currentFramework.nodes
    .slice()
    .sort((a, b) => a.index - b.index);

  const handleSave = () => {
    if (!onSave) return;
    onSave();
    setSavedTip(true);
    setTimeout(() => setSavedTip(false), 2000);
  };

  const startEditTitle = () => {
    setTitleDraft(currentFramework.title);
    setShortTitleDraft(currentFramework.shortTitle || "");
    setEditingTitle(true);
  };

  const saveTitle = () => {
    if (!titleDraft.trim()) return;
    setCurrentFramework({
      ...currentFramework,
      title: titleDraft.trim(),
      shortTitle: shortTitleDraft.trim() || undefined,
    });
    setEditingTitle(false);
  };

  const cancelEditTitle = () => {
    setEditingTitle(false);
  };

  const startEditPremise = () => {
    setPremiseDraft(currentFramework.premise);
    setEditingPremise(true);
  };

  const savePremise = () => {
    setCurrentFramework({
      ...currentFramework,
      premise: premiseDraft,
    });
    setEditingPremise(false);
  };

  const cancelEditPremise = () => {
    setEditingPremise(false);
  };

  const updateNode = (nodeIndex: number, updates: Partial<StoryNode>) => {
    setCurrentFramework({
      ...currentFramework,
      nodes: currentFramework.nodes.map((n) =>
        n.index === nodeIndex ? { ...n, ...updates } : n,
      ),
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !currentFramework) return;

    const oldIndex = sortedNodes.findIndex((n) => n.index === active.id);
    const newIndex = sortedNodes.findIndex((n) => n.index === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(sortedNodes, oldIndex, newIndex);
    const updatedNodes = reordered.map((n, i) => ({ ...n, index: i }));
    setCurrentFramework({
      ...currentFramework,
      nodes: updatedNodes,
    });
    setSavedTip(false);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 顶部：标题 + 操作按钮 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editingTitle ? (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <Input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="框架标题"
                className="h-8 flex-1 min-w-[200px] text-base font-semibold"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") cancelEditTitle();
                }}
              />
              <Input
                value={shortTitleDraft}
                onChange={(e) => setShortTitleDraft(e.target.value)}
                placeholder="短标题（可选）"
                className="h-8 w-32 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") cancelEditTitle();
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={saveTitle}
              >
                <Check className="h-4 w-4 text-emerald-500" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={cancelEditTitle}
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <>
              <h3 className="truncate text-lg font-semibold">
                {currentFramework.title}
              </h3>
              {currentFramework.shortTitle && (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                  {currentFramework.shortTitle}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 opacity-50 hover:opacity-100"
                onClick={startEditTitle}
                title="编辑标题"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
        {!editingTitle && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={onViewHistory}>
              历史推演
            </Button>
            <Button variant="outline" onClick={onRegenerate}>
              {t("storySimulation.regenerateFramework")}
            </Button>
            {onSave && (
              <Button variant="outline" onClick={handleSave}>
                {savedTip ? (
                  <>
                    <Check className="mr-1 h-4 w-4 text-emerald-500" />
                    已保存
                  </>
                ) : (
                  "保存框架"
                )}
              </Button>
            )}
            <Button onClick={onConfirm}>
              {t("storySimulation.confirmFramework")}
            </Button>
          </div>
        )}
      </div>

      {/* 前提区 - 支持编辑 */}
      <div className="rounded-lg bg-muted p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-muted-foreground">
            {t("storySimulation.frameworkPremise")}
          </div>
          {!editingPremise && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 opacity-50 hover:opacity-100"
              onClick={startEditPremise}
              title="编辑前提"
            >
              <Pencil className="h-3 w-3" />
            </Button>
          )}
        </div>
        {editingPremise ? (
          <div className="space-y-2">
            <Textarea
              value={premiseDraft}
              onChange={(e) => setPremiseDraft(e.target.value)}
              rows={3}
              className="text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={cancelEditPremise}>
                取消
              </Button>
              <Button size="sm" onClick={savePremise}>
                <Check className="mr-1 h-3.5 w-3.5" />
                保存
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {currentFramework.premise || "（无前提）"}
          </p>
        )}
      </div>

      {/* 节点列表 */}
      <div
        className="flex min-h-0 flex-col gap-3 overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 320px)" }}
      >
        <div className="text-sm font-medium text-muted-foreground">
          {t("storySimulation.frameworkNodes")}
          <span className="ml-2 text-xs font-normal text-muted-foreground/70">
            （拖拽手柄可排序）
          </span>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortedNodes.map((n) => n.index)}
            strategy={verticalListSortingStrategy}
          >
            {sortedNodes.map((node) => (
              <SortableNodeCard
                key={node.index}
                node={node}
                onUpdate={(updates) => updateNode(node.index, updates)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

function SortableNodeCard({
  node,
  onUpdate,
}: {
  node: StoryNode;
  onUpdate: (updates: Partial<StoryNode>) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.index });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <button
        type="button"
        className="absolute left-0 top-0 z-10 flex h-full w-6 cursor-grab items-center justify-center text-muted-foreground/30 hover:text-primary active:cursor-grabbing"
        {...attributes}
        {...listeners}
        title="拖拽排序"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="pl-6">
        <FrameworkNodeCard node={node} onUpdate={onUpdate} />
      </div>
    </div>
  );
}

function FrameworkNodeCard({
  node,
  onUpdate,
}: {
  node: StoryNode;
  onUpdate: (updates: Partial<StoryNode>) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<
    Omit<StoryNode, "involvedCharacters"> & { involvedCharacters: string }
  >({
    ...node,
    involvedCharacters: node.involvedCharacters.join("、"),
  });

  const startEdit = () => {
    setDraft({
      ...node,
      involvedCharacters: node.involvedCharacters.join("、"),
    });
    setEditing(true);
  };

  const save = () => {
    onUpdate({
      title: draft.title.trim() || node.title,
      coreConflict: draft.coreConflict,
      involvedCharacters: String(draft.involvedCharacters)
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      goal: draft.goal,
      causeFromPrev: draft.causeFromPrev,
      expectedOutcome: draft.expectedOutcome,
    });
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
  };

  const involvedCharsStr = String(draft.involvedCharacters);

  return (
    <div className="rounded-lg border p-4">
      {/* 阶段标签 + 节点标题 */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
              PHASE_STYLES[node.phase],
            )}
          >
            {node.phase}
          </span>
          {editing ? (
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="h-7 flex-1 text-sm font-medium"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") cancel();
              }}
            />
          ) : (
            <span className="truncate font-medium">{node.title}</span>
          )}
        </div>
        {!editing ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 opacity-50 hover:opacity-100"
            onClick={startEdit}
            title="编辑节点"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={save}
            >
              <Check className="h-4 w-4 text-emerald-500" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={cancel}
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        )}
      </div>

      {/* 节点字段 */}
      {editing ? (
        <div className="space-y-3 text-sm">
          <FieldEdit label={t("storySimulation.coreConflict")}>
            <Textarea
              value={draft.coreConflict}
              onChange={(e) =>
                setDraft({ ...draft, coreConflict: e.target.value })
              }
              rows={2}
              className="text-sm"
            />
          </FieldEdit>
          <FieldEdit label={t("storySimulation.involvedCharacters")}>
            <Input
              value={involvedCharsStr}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  involvedCharacters: e.target.value,
                })
              }
              placeholder="用逗号或顿号分隔"
              className="h-8 text-sm"
            />
          </FieldEdit>
          <FieldEdit label={t("storySimulation.goal")}>
            <Textarea
              value={draft.goal}
              onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
              rows={2}
              className="text-sm"
            />
          </FieldEdit>
          <FieldEdit label={t("storySimulation.cause")}>
            <Textarea
              value={draft.causeFromPrev}
              onChange={(e) =>
                setDraft({ ...draft, causeFromPrev: e.target.value })
              }
              rows={2}
              className="text-sm"
            />
          </FieldEdit>
          <FieldEdit label={t("storySimulation.expectedOutcome")}>
            <Textarea
              value={draft.expectedOutcome}
              onChange={(e) =>
                setDraft({ ...draft, expectedOutcome: e.target.value })
              }
              rows={2}
              className="text-sm"
            />
          </FieldEdit>
        </div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="whitespace-nowrap text-muted-foreground">
            {t("storySimulation.coreConflict")}
          </dt>
          <dd className="break-words leading-relaxed">{node.coreConflict}</dd>

          <dt className="whitespace-nowrap text-muted-foreground">
            {t("storySimulation.involvedCharacters")}
          </dt>
          <dd className="break-words leading-relaxed">
            {Array.isArray(node.involvedCharacters)
              ? node.involvedCharacters.join("、")
              : node.involvedCharacters}
          </dd>

          <dt className="whitespace-nowrap text-muted-foreground">
            {t("storySimulation.goal")}
          </dt>
          <dd className="break-words leading-relaxed">{node.goal}</dd>

          <dt className="whitespace-nowrap text-muted-foreground">
            {t("storySimulation.cause")}
          </dt>
          <dd className="break-words leading-relaxed">{node.causeFromPrev}</dd>

          <dt className="whitespace-nowrap text-muted-foreground">
            {t("storySimulation.expectedOutcome")}
          </dt>
          <dd className="break-words leading-relaxed">
            {node.expectedOutcome}
          </dd>
        </dl>
      )}
    </div>
  );
}

function FieldEdit({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
