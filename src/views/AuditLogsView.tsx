import { useMemo, useState } from 'react';
import { Download, ScrollText, Search } from 'lucide-react';
import { formatTimestamp } from '../api/client.ts';
import { EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type { AuditLogRecord } from '../../shared/types.ts';

interface AuditLogsViewProps {
  logs: AuditLogRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

export function AuditLogsView({ logs, loading, error, onRefresh }: AuditLogsViewProps) {
  const [query, setQuery] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | 'success' | 'denied' | 'error'>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((entry) => {
      if (outcomeFilter !== 'all' && entry.outcome !== outcomeFilter) return false;
      if (!q) return true;
      return (
        entry.action.toLowerCase().includes(q) ||
        entry.actor.toLowerCase().includes(q) ||
        entry.details.toLowerCase().includes(q) ||
        entry.resource_type.toLowerCase().includes(q)
      );
    });
  }, [logs, query, outcomeFilter]);

  const handleExportCsv = () => {
    const header = ['created_at', 'actor', 'actor_role', 'action', 'resource_type', 'resource_id', 'outcome', 'details'];
    const escapeCsv = (val: string | null) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const rows = filtered.map((r) =>
      [r.created_at, r.actor, r.actor_role, r.action, r.resource_type, r.resource_id, r.outcome, r.details]
        .map(escapeCsv)
        .join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumaflux-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading && logs.length === 0) return <LoadingSkeleton rows={6} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Security & Audit Logs
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Append-only operational trail tracking imports, access policy checks, settings updates, and system lifecycle.
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 whitespace-nowrap"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Export CSV</span>
        </button>
      </div>

      {error && <ErrorBanner message={error} onRetry={onRefresh} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by action, actor, resource, or details..."
            className="w-full rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div className="flex items-center gap-1 p-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724]">
          {(['all', 'success', 'denied', 'error'] as const).map((outcome) => (
            <button
              key={outcome}
              type="button"
              onClick={() => setOutcomeFilter(outcome)}
              className={`px-3 py-1.5 rounded text-xs font-medium capitalize transition-colors ${
                outcomeFilter === outcome
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {outcome}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title="No matching audit events"
          description="Try clearing your search filter or outcome selector."
        />
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-3 px-5 font-medium">Timestamp</th>
                <th className="py-3 px-4 font-medium">Actor</th>
                <th className="py-3 px-4 font-medium">Action</th>
                <th className="py-3 px-4 font-medium">Resource</th>
                <th className="py-3 px-4 font-medium">Details</th>
                <th className="py-3 px-5 font-medium text-right">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {filtered.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-3 px-5 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimestamp(entry.created_at)}
                  </td>
                  <td className="py-3 px-4 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {entry.actor} · <span className="text-slate-500">{entry.actor_role}</span>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {entry.action}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                    {entry.resource_type}
                  </td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-lg">
                    {entry.details}
                  </td>
                  <td className="py-3 px-5 text-right">
                    <StatusText
                      label={entry.outcome}
                      tone={
                        entry.outcome === 'success'
                          ? 'success'
                          : entry.outcome === 'denied'
                            ? 'warning'
                            : 'danger'
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
