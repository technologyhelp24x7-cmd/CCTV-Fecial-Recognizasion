import { useState } from 'react';
import { Cpu, Play } from 'lucide-react';
import { api, formatTimestamp } from '../api/client.ts';
import { EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type { AiEngineDescriptor, AppSettingsMap, ProcessingJobRecord, VideoFileRecord } from '../../shared/types.ts';

interface AiDetectionViewProps {
  engines: AiEngineDescriptor[];
  jobs: ProcessingJobRecord[];
  videos: VideoFileRecord[];
  settings: AppSettingsMap | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

export function AiDetectionView({
  engines,
  jobs,
  videos,
  settings,
  loading,
  error,
  onRefresh,
}: AiDetectionViewProps) {
  const [selectedVideoId, setSelectedVideoId] = useState<string>('');
  const [sampleFps, setSampleFps] = useState<string>(settings?.detection_sample_fps || '2.0');
  const [confidenceThreshold, setConfidenceThreshold] = useState<string>(
    settings?.detection_confidence_threshold || '0.45'
  );
  const [runningEngineId, setRunningEngineId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const effectiveVideoId = selectedVideoId || videos[0]?.id || '';

  const handleRunEngine = async (engineId: string) => {
    if (!effectiveVideoId) {
      setActionError('Import or record at least one video file before running detection pipelines.');
      return;
    }
    setRunningEngineId(engineId);
    setActionError(null);
    try {
      await api.runAiJob(effectiveVideoId, engineId, {
        sample_fps: Number(sampleFps) || 2.0,
        confidence_threshold: Number(confidenceThreshold) || 0.45,
      });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pipeline execution blocked.');
      await onRefresh();
    } finally {
      setRunningEngineId(null);
    }
  };

  if (loading && engines.length === 0) return <LoadingSkeleton rows={5} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            AI Detection
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Modular OpenCV person detection, FFmpeg inspection, and privacy redaction pipelines. Biometric matching remains policy-disabled.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <span>FPS:</span>
            <input
              type="number"
              step="0.5"
              min={0.5}
              max={15}
              value={sampleFps}
              onChange={(e) => setSampleFps(e.target.value)}
              className="w-16 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-2 py-1.5 text-xs tabular-nums text-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <span>Min Conf:</span>
            <input
              type="number"
              step="0.05"
              min={0.1}
              max={0.95}
              value={confidenceThreshold}
              onChange={(e) => setConfidenceThreshold(e.target.value)}
              className="w-16 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-2 py-1.5 text-xs tabular-nums text-slate-900 dark:text-slate-100"
            />
          </label>
          {videos.length > 0 && (
            <select
              aria-label="Target video for inspection job"
              value={effectiveVideoId}
              onChange={(e) => setSelectedVideoId(e.target.value)}
              className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-3 py-2 text-xs text-slate-900 dark:text-slate-100 max-w-xs"
            >
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  Target: {v.original_name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {(error || actionError) && (
        <ErrorBanner message={actionError || error || 'AI module error'} onRetry={onRefresh} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {engines.map((engine) => (
          <div
            key={engine.id}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-5 flex flex-col justify-between gap-4"
          >
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {engine.name}
                  </h3>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{engine.stage}</div>
                </div>
                <StatusText
                  label={
                    engine.status === 'ready'
                      ? 'Active'
                      : engine.status === 'disabled_by_policy'
                        ? 'Disabled by Policy'
                        : engine.status === 'missing_dependency'
                          ? 'Dependency Missing'
                          : 'Pending'
                  }
                  tone={
                    engine.status === 'ready'
                      ? 'success'
                      : engine.status === 'disabled_by_policy'
                        ? 'danger'
                        : 'warning'
                  }
                />
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {engine.description}
              </p>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 pt-1">
                Guardrail: {engine.privacy_guardrail}
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                disabled={!effectiveVideoId || runningEngineId === engine.id}
                onClick={() => handleRunEngine(engine.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45"
              >
                <Play className="h-3 w-3" aria-hidden="true" />
                <span>{runningEngineId === engine.id ? 'Running...' : 'Run Pipeline'}</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724]">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Processing Job Execution Log
          </h3>
        </div>

        {jobs.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Cpu className="h-5 w-5" />}
              title="No processing jobs recorded"
              description="Import a video file or run a detection/inspection pipeline above to log real processing telemetry."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-6 font-medium">Timestamp</th>
                  <th className="py-3 px-4 font-medium">Video Asset</th>
                  <th className="py-3 px-4 font-medium">Engine</th>
                  <th className="py-3 px-4 font-medium">Output</th>
                  <th className="py-3 px-6 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                    <td className="py-3 px-6 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {formatTimestamp(job.created_at)}
                    </td>
                    <td className="py-3 px-4 text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {job.video_name || job.video_file_id}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      {job.engine_name}
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-md truncate" title={job.log_output}>
                      {job.log_output}
                    </td>
                    <td className="py-3 px-6 text-right">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
