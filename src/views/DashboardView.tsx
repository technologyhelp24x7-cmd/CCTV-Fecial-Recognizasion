import { ArrowRight, HardDrive } from 'lucide-react';
import { formatBytes, formatTimestamp } from '../api/client.ts';
import { ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type { DashboardSummary, NavModuleId } from '../../shared/types.ts';

interface DashboardViewProps {
  summary: DashboardSummary | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onNavigate: (module: NavModuleId) => void;
  onOpenImportModal: () => void;
}

export function DashboardView({
  summary,
  loading,
  error,
  onRetry,
  onNavigate,
  onOpenImportModal,
}: DashboardViewProps) {
  if (loading && !summary) {
    return <LoadingSkeleton rows={6} />;
  }

  if (error && !summary) {
    return <ErrorBanner message={error} onRetry={onRetry} />;
  }

  if (!summary) return null;

  const { storage_usage: storage, video_processing_status: processing, system_capabilities: caps } = summary;
  const quotaPct =
    storage.quota_bytes > 0
      ? Math.min(100, Math.round((storage.total_app_bytes_used / storage.quota_bytes) * 100))
      : 0;

  const kpiCards: Array<{
    label: string;
    value: number;
    subtext: string;
    target: NavModuleId;
  }> = [
    {
      label: 'Total Imported Video Files',
      value: summary.total_imported_videos,
      subtext: 'Stored in local video vault',
      target: 'video-library',
    },
    {
      label: 'Connected Cameras',
      value: summary.connected_cameras,
      subtext: `${summary.total_cameras} configured · ${summary.active_streams ?? 0} live · ${summary.active_recordings ?? 0} rec`,
      target: 'camera-management',
    },
    {
      label: 'Detected Person Events',
      value: summary.detected_person_events,
      subtext: `${summary.anonymous_tracks_count ?? 0} session track(s)`,
      target: 'person-gallery',
    },
    {
      label: 'Anonymous Person Profiles',
      value: summary.anonymous_person_profiles,
      subtext: 'Unlinked privacy-masked subjects',
      target: 'person-profiles',
    },
    {
      label: 'Authorized Registered Profiles',
      value: summary.authorized_registered_profiles,
      subtext: 'Consent-governed profiles',
      target: 'person-profiles',
    },
    {
      label: 'Pending Security Reviews',
      value: summary.pending_security_reviews,
      subtext: 'Watchlist & incident queue',
      target: 'watchlist-review',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Operational Overview
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Live telemetry aggregated directly from your local SQLite metadata store and configured storage vault.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{caps.database_engine}</span>
          <span aria-hidden="true">·</span>
          <span>{caps.ffmpeg_available ? 'FFmpeg Ready' : 'FFmpeg Unavailable'}</span>
          <span aria-hidden="true">·</span>
          <span>{caps.opencv_available ? 'OpenCV Ready' : 'OpenCV Missing'}</span>
          <span aria-hidden="true">·</span>
          <span>Biometrics Disabled</span>
        </div>
      </div>

      {/* 6 Primary Database-Backed KPI Metrics */}
      <section aria-label="Core operational metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {kpiCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => onNavigate(card.target)}
            className="text-left rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-5 hover:border-slate-300 dark:hover:border-slate-700 transition-colors group"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {card.label}
              </span>
              <ArrowRight
                className="h-3.5 w-3.5 text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors"
                aria-hidden="true"
              />
            </div>
            <div className="mt-2 font-display text-3xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {card.value}
            </div>
            <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              {card.subtext}
            </div>
          </button>
        ))}
      </section>

      {/* Storage Usage & Video Processing Status */}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Storage Usage
              </h3>
              <p className="mt-1 text-xs font-mono text-slate-500 dark:text-slate-400 break-all">
                {storage.storage_directory}
              </p>
            </div>
            <HardDrive className="h-4 w-4 text-slate-400 shrink-0" aria-hidden="true" />
          </div>

          <div className="mt-5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(storage.total_app_bytes_used)}
              </span>
              <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                Quota: {formatBytes(storage.quota_bytes)} ({quotaPct}%)
              </span>
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-600 transition-all"
                style={{ width: `${Math.max(quotaPct, storage.total_app_bytes_used > 0 ? 2 : 0)}%` }}
              />
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-100 dark:border-slate-800/80 text-xs">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Video Vault</dt>
              <dd className="mt-1 font-mono font-medium tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(storage.video_bytes_used)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Thumbnails</dt>
              <dd className="mt-1 font-mono font-medium tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(storage.thumbnail_bytes_used)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">SQLite DB</dt>
              <dd className="mt-1 font-mono font-medium tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(storage.database_bytes_used)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Host Disk Free</dt>
              <dd className="mt-1 font-mono font-medium tabular-nums text-slate-900 dark:text-slate-100">
                {storage.disk_free_bytes !== null ? formatBytes(storage.disk_free_bytes) : '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Video Processing Status
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                FFmpeg metadata inspection & Stage 1 pipeline queue
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('ai-detection')}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
            >
              Open AI Detection
            </button>
          </div>

          <div className="mt-5 grid grid-cols-5 gap-2 text-center">
            {[
              { label: 'Imported', count: processing.imported },
              { label: 'Queued', count: processing.queued },
              { label: 'Inspecting', count: processing.inspecting },
              { label: 'Ready', count: processing.ready },
              { label: 'Failed', count: processing.failed },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121D] py-3 px-2"
              >
                <div className="font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                  {item.count}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{item.label}</div>
              </div>
            ))}
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800/80">
            {processing.recent_jobs.length === 0 ? (
              <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                <span>No video processing jobs have run yet.</span>
                <button
                  type="button"
                  onClick={onOpenImportModal}
                  className="font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                >
                  Import Video
                </button>
              </div>
            ) : (
              <ul className="space-y-2">
                {processing.recent_jobs.slice(0, 3).map((job) => (
                  <li key={job.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-slate-700 dark:text-slate-300">
                      {job.video_name || job.video_file_id} · {job.engine_name}
                    </span>
                    <StatusText
                      label={job.status}
                      tone={
                        job.status === 'completed'
                          ? 'success'
                          : job.status === 'failed'
                            ? 'danger'
                            : job.status === 'skipped'
                              ? 'neutral'
                              : 'warning'
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* Recent Activity (Real Audit Trail) */}
      <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Recent Activity
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Chronological record of system initialization, imports, configuration changes, and security actions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('audit-logs')}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
          >
            View All Logs
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-3 px-6 font-medium">Timestamp</th>
                <th className="py-3 px-4 font-medium">Actor</th>
                <th className="py-3 px-4 font-medium">Action</th>
                <th className="py-3 px-4 font-medium">Details</th>
                <th className="py-3 px-6 font-medium text-right">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {summary.recent_activity.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-3 px-6 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimestamp(entry.created_at)}
                  </td>
                  <td className="py-3 px-4 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {entry.actor}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {entry.action}
                  </td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-md truncate">
                    {entry.details}
                  </td>
                  <td className="py-3 px-6 text-right">
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
      </section>
    </div>
  );
}
