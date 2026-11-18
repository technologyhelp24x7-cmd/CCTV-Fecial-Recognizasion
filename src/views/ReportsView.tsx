import { useState } from 'react';
import { Download, FileBarChart2 } from 'lucide-react';
import { api, formatBytes } from '../api/client.ts';
import { ErrorBanner } from '../components/StateViews.tsx';
import type { DashboardSummary } from '../../shared/types.ts';

interface ReportsViewProps {
  summary: DashboardSummary | null;
}

export function ReportsView({ summary }: ReportsViewProps) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastExportTime, setLastExportTime] = useState<string | null>(null);

  const handleDownloadJsonReport = async () => {
    setExporting(true);
    setError(null);
    try {
      const payload = await api.getReportsSummary();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lumaflux-compliance-report-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLastExportTime(payload.generated_at);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate compliance report.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Reports
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Export auditable snapshots of camera inventory, local video assets, profile consent status, and storage utilization.
          </p>
        </div>

        <button
          type="button"
          onClick={handleDownloadJsonReport}
          disabled={exporting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 whitespace-nowrap"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{exporting ? 'Generating...' : 'Export JSON Compliance Report'}</span>
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {lastExportTime && (
        <div className="rounded-md border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-200">
          Compliance report exported and logged to Security & Audit Logs ({lastExportTime}).
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-3">
          <div className="flex items-center gap-2.5">
            <FileBarChart2 className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Vault & Asset Inventory Snapshot
            </h3>
          </div>
          <dl className="grid grid-cols-2 gap-4 pt-2 text-xs">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Imported Videos</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {summary?.total_imported_videos ?? 0}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Configured Cameras</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {summary?.total_cameras ?? 0}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Vault Disk Footprint</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(summary?.storage_usage.total_app_bytes_used ?? 0)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Pending Reviews</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {summary?.pending_security_reviews ?? 0}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Privacy & Consent Governance Summary
          </h3>
          <dl className="grid grid-cols-2 gap-4 pt-2 text-xs">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Authorized Profiles</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {summary?.authorized_registered_profiles ?? 0}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Anonymous Profiles</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {summary?.anonymous_person_profiles ?? 0}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Biometric Matching</dt>
              <dd className="mt-1 font-medium text-slate-900 dark:text-slate-100">
                Disabled (Stage 1 Policy)
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Database Engine</dt>
              <dd className="mt-1 font-medium text-slate-900 dark:text-slate-100">
                {summary?.system_capabilities.database_engine ?? 'SQLite 3'}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
