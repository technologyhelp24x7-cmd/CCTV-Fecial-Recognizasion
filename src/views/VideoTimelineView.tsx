import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Film, Shield } from 'lucide-react';
import { api, formatBytes, formatDuration, formatTimestamp, resolveApiUrl } from '../api/client.ts';
import { EmptyState } from '../components/StateViews.tsx';
import type { PersonEventRecord, VideoFileRecord } from '../../shared/types.ts';

interface VideoTimelineViewProps {
  videos: VideoFileRecord[];
  events: PersonEventRecord[];
  selectedVideoId: string | null;
  seekTimeSec?: number | null;
  privacyMaskMode?: 'blur' | 'pixelate';
  onSelectVideo: (videoId: string) => void;
  onOpenImportModal: () => void;
  onRefresh: () => Promise<void>;
}

export function VideoTimelineView({
  videos,
  events,
  selectedVideoId,
  seekTimeSec,
  privacyMaskMode = 'blur',
  onSelectVideo,
  onOpenImportModal,
  onRefresh,
}: VideoTimelineViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const activeVideo =
    videos.find((v) => v.id === selectedVideoId) ?? (videos.length > 0 ? videos[0] : null);

  const videoEvents = useMemo(() => {
    if (!activeVideo) return [];
    return events
      .filter((e) => e.video_file_id === activeVideo.id)
      .sort((a, b) => a.event_timestamp_sec - b.event_timestamp_sec);
  }, [events, activeVideo]);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(activeVideo?.duration_seconds ?? 0);
    setExportNotice(null);
    setExportError(null);
  }, [activeVideo?.id, activeVideo?.duration_seconds]);

  useEffect(() => {
    if (seekTimeSec !== null && seekTimeSec !== undefined && videoRef.current) {
      videoRef.current.currentTime = seekTimeSec;
      setCurrentTime(seekTimeSec);
    }
  }, [seekTimeSec, activeVideo?.id]);

  const seekTo = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      void videoRef.current.play().catch(() => {});
    }
    setCurrentTime(sec);
  };

  const handleExportRedacted = async (mode: 'blur' | 'pixelate') => {
    if (!activeVideo) return;
    setExporting(true);
    setExportNotice(null);
    setExportError(null);
    try {
      const created = await api.redactVideo(activeVideo.id, mode);
      setExportNotice(`Exported '${created.original_name}' (${mode}).`);
      await onRefresh();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to export privacy-masked video.');
    } finally {
      setExporting(false);
    }
  };

  if (!activeVideo) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Video Timeline
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Synchronized local playback and chronological event track inspection.
          </p>
        </div>

        <EmptyState
          icon={<Clock className="h-5 w-5" />}
          title="No video footage available for timeline playback"
          description="Import or record an MP4 or WebM CCTV video file into your local vault to inspect frames, duration tracks, and timeline markers."
          action={
            <button
              type="button"
              onClick={onOpenImportModal}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white"
            >
              Import Video
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Video Timeline
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Frame-accurate HTTP range playback, clickable AI person-event markers, and privacy-masked export.
          </p>
        </div>

        <select
          aria-label="Select video for timeline playback"
          value={activeVideo.id}
          onChange={(e) => onSelectVideo(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 max-w-xs"
        >
          {videos.map((v) => (
            <option key={v.id} value={v.id}>
              {v.original_name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-hidden">
          <div className="aspect-video bg-black flex items-center justify-center">
            <video
              ref={videoRef}
              key={activeVideo.id}
              controls
              preload="metadata"
              poster={activeVideo.thumbnail_path ? resolveApiUrl(`/api/videos/${activeVideo.id}/thumbnail`) : undefined}
              src={resolveApiUrl(`/api/videos/${activeVideo.id}/stream`)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => {
                const dur = e.currentTarget.duration || activeVideo.duration_seconds || 0;
                setDuration(dur);
                if (seekTimeSec !== null && seekTimeSec !== undefined) {
                  e.currentTarget.currentTime = seekTimeSec;
                }
              }}
              className="h-full w-full"
            />
          </div>

          <div className="p-5 space-y-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
              <span>Playhead: {formatDuration(currentTime)}</span>
              <span>Duration: {formatDuration(duration)}</span>
            </div>

            {/* Chronological Track Bar with Clickable Event Markers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>AI Event Marker Track</span>
                <span>{videoEvents.length} detected event(s)</span>
              </div>
              <div className="relative h-8 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D121D] overflow-hidden">
                {videoEvents.map((evt) => {
                  const pct = duration > 0 ? Math.min(98, Math.max(0, (evt.event_timestamp_sec / duration) * 100)) : 0;
                  return (
                    <button
                      key={evt.id}
                      type="button"
                      onClick={() => seekTo(evt.event_timestamp_sec)}
                      title={`${evt.track_code || 'Event'} @ ${evt.event_timestamp_sec.toFixed(2)}s`}
                      style={{ left: `${pct}%` }}
                      className="absolute top-1 bottom-1 w-1.5 rounded-sm bg-amber-500 hover:bg-amber-400 cursor-pointer"
                    />
                  );
                })}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-blue-600 pointer-events-none"
                  style={{
                    left: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                  }}
                />
              </div>

              {videoEvents.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {videoEvents.slice(0, 8).map((evt) => (
                    <button
                      key={evt.id}
                      type="button"
                      onClick={() => seekTo(evt.event_timestamp_sec)}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 font-mono text-[11px] tabular-nums text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {evt.track_code || 'EVT'} · {evt.event_timestamp_sec.toFixed(1)}s
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Film className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <span className="truncate">{activeVideo.original_name}</span>
          </div>

          <dl className="space-y-3 text-xs pt-2 border-t border-slate-100 dark:border-slate-800/80">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500 dark:text-slate-400">Camera / Origin</dt>
              <dd className="text-slate-900 dark:text-slate-100">
                {activeVideo.camera_name || 'Local Archive'} · {activeVideo.source_origin || 'imported'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500 dark:text-slate-400">Resolution</dt>
              <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {activeVideo.width && activeVideo.height ? `${activeVideo.width}×${activeVideo.height}` : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500 dark:text-slate-400">Codec / FPS</dt>
              <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {activeVideo.codec || '—'} · {activeVideo.fps ? `${activeVideo.fps} fps` : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500 dark:text-slate-400">File Size</dt>
              <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {formatBytes(activeVideo.file_size_bytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500 dark:text-slate-400">Imported At</dt>
              <dd className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {formatTimestamp(activeVideo.imported_at)}
              </dd>
            </div>
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <dt className="text-slate-500 dark:text-slate-400 mb-1">SHA-256 Digest</dt>
              <dd className="font-mono text-[11px] break-all text-slate-700 dark:text-slate-300">
                {activeVideo.sha256_hash}
              </dd>
            </div>
          </dl>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800/80 space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">Privacy-Masked Export</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={exporting}
                onClick={() => handleExportRedacted(privacyMaskMode)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                <Shield className="h-3.5 w-3.5" />
                <span>{exporting ? 'Exporting...' : `Export (${privacyMaskMode})`}</span>
              </button>
              <button
                type="button"
                disabled={exporting}
                onClick={() => handleExportRedacted(privacyMaskMode === 'blur' ? 'pixelate' : 'blur')}
                className="px-3 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                {privacyMaskMode === 'blur' ? 'Pixelate' : 'Blur'}
              </button>
            </div>
            {exportNotice && <div className="text-[11px] text-emerald-500">{exportNotice}</div>}
            {exportError && <div className="text-[11px] text-red-500">{exportError}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
