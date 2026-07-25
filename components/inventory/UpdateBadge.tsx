'use client';

import { useAvailableUpdates } from '@/hooks/use-updates';
import { useMspOptional } from '@/hooks/useMspOptional';

export function UpdateBadge() {
  const { isMspUser, selectedTenantId } = useMspOptional();
  const tenantId = isMspUser ? selectedTenantId || undefined : undefined;
  const { data, isLoading, isError } = useAvailableUpdates({ tenantId });

  // Don't show badge while loading, on error, or when there are no updates
  if (isLoading || isError || !data || data.count === 0) {
    return null;
  }

  return (
    <span className="ml-auto inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium rounded-full bg-status-warning/10 text-status-warning">
      {data.count}
    </span>
  );
}
