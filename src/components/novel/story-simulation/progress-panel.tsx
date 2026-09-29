import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export interface ProgressPanelProps {
  progress: number;
  label: string;
  onCancel?: () => void;
  cancelling?: boolean;
}

/** 通用进度面板（F4-7 自 story-simulation-view.tsx 剥离，无行为变更）。 */
export function ProgressPanel({
  progress,
  label,
  onCancel,
  cancelling,
}: ProgressPanelProps) {
  const { t } = useTranslation()
  const clamped = Math.min(100, Math.max(0, progress));
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="text-base font-medium">{label}</div>
      <div className="h-2 w-64 max-w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground">{clamped}%</div>
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={cancelling}
          className="mt-2"
        >
          {cancelling ? t("storySimulation.cancelling") : "取消"}
        </Button>
      )}
    </div>
  );
}
