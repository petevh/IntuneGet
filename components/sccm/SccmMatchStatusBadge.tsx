'use client';

import {
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Clock,
  XCircle,
  UserCheck,
  SkipForward,
} from 'lucide-react';
import { StatusBadge, getStatusToneClasses, type StatusTone } from '@/components/ui/status-badge';
import type { SccmMatchStatus } from '@/types/sccm';

interface SccmMatchStatusBadgeProps {
  status: SccmMatchStatus;
  confidence?: number | null;
  className?: string;
  showConfidence?: boolean;
}

const statusConfig: Record<
  SccmMatchStatus,
  {
    label: string;
    icon: typeof CheckCircle2;
    tone: StatusTone;
  }
> = {
  matched: { label: 'Matched', icon: CheckCircle2, tone: 'success' },
  partial: { label: 'Partial', icon: AlertCircle, tone: 'warning' },
  unmatched: { label: 'No Match', icon: HelpCircle, tone: 'neutral' },
  pending: { label: 'Pending', icon: Clock, tone: 'info' },
  manual: { label: 'Manual', icon: UserCheck, tone: 'accent' },
  excluded: { label: 'Excluded', icon: XCircle, tone: 'muted' },
  skipped: { label: 'Skipped', icon: SkipForward, tone: 'muted' },
};

export function SccmMatchStatusBadge({
  status,
  confidence,
  className,
  showConfidence = true,
}: SccmMatchStatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.pending;

  // Only show confidence for matched and partial statuses
  const shouldShowConfidence =
    showConfidence &&
    confidence !== null &&
    confidence !== undefined &&
    (status === 'matched' || status === 'partial' || status === 'manual');

  return (
    <StatusBadge tone={config.tone} icon={config.icon} className={className}>
      <span>{config.label}</span>
      {shouldShowConfidence && (
        <span className="opacity-70">({Math.round(confidence * 100)}%)</span>
      )}
    </StatusBadge>
  );
}

/**
 * Get the match status color classes for use in other components
 */
export function getMatchStatusColors(status: SccmMatchStatus): string {
  return getStatusToneClasses((statusConfig[status] || statusConfig.pending).tone);
}

/**
 * Get the match status label
 */
export function getMatchStatusLabel(status: SccmMatchStatus): string {
  return statusConfig[status]?.label || 'Unknown';
}
