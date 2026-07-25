'use client';

import { CheckCircle2, AlertCircle, HelpCircle, Clock } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import type { MatchStatus } from '@/types/unmanaged';

interface MatchStatusBadgeProps {
  status: MatchStatus;
  confidence?: number | null;
  className?: string;
}

const statusConfig: Record<MatchStatus, {
  label: string;
  icon: typeof CheckCircle2;
  tone: StatusTone;
}> = {
  matched: { label: 'Matched', icon: CheckCircle2, tone: 'success' },
  partial: { label: 'Partial Match', icon: AlertCircle, tone: 'warning' },
  unmatched: { label: 'No Match', icon: HelpCircle, tone: 'neutral' },
  pending: { label: 'Pending', icon: Clock, tone: 'info' },
};

function getConfidenceLabel(confidence: number): { label: string; color: string } {
  if (confidence >= 0.9) return { label: 'High', color: 'text-status-success' };
  if (confidence >= 0.7) return { label: 'Moderate', color: 'text-status-warning' };
  return { label: 'Low', color: 'text-status-error' };
}

function getConfidenceTooltip(status: MatchStatus, confidence: number | null | undefined): string {
  if (status === 'unmatched') return 'No WinGet package match was found for this app.';
  if (status === 'pending') return 'Match analysis is in progress.';
  if (confidence === null || confidence === undefined) return 'Match confidence data is not available.';

  const pct = Math.round(confidence * 100);
  if (pct >= 90) return `${pct}% confidence - strong match based on name, publisher, and version.`;
  if (pct >= 70) return `${pct}% confidence - likely match but verify the package is correct.`;
  return `${pct}% confidence - weak match. Consider linking a different package.`;
}

export function MatchStatusBadge({ status, confidence, className }: MatchStatusBadgeProps) {
  const config = statusConfig[status];

  const showConfidence = confidence !== null && confidence !== undefined && status !== 'unmatched';
  const confidenceInfo = showConfidence ? getConfidenceLabel(confidence!) : null;

  const badge = (
    <StatusBadge tone={config.tone} icon={config.icon} className={cn('cursor-default', className)}>
      <span>{config.label}</span>
      {showConfidence && confidenceInfo && (
        <span className={cn('font-semibold', confidenceInfo.color)}>
          {confidenceInfo.label}
        </span>
      )}
    </StatusBadge>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p>{getConfidenceTooltip(status, confidence)}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
