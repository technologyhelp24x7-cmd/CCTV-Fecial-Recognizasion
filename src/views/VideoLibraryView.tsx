import { useMemo, useState } from 'react';
import { Film, Play, RefreshCw, Search, Shield, Trash2, Upload } from 'lucide-react';
import { api, formatBytes, formatDuration, formatTimestamp, resolveApiUrl } from '../api/client.ts';
import { ConfirmDialog, EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type { VideoFileRecord } from '../../shared/types.ts';

interface VideoLibraryViewProps {
  videos: VideoFileRecord[];
  loading: boolean;
  error: string | null;
  privacyMaskMode?: 'blur' | 'pixelate';
  onRefresh: () => Promise<void>;
  onOpenImportModal: () => void;
  onOpenTimelineForVideo: (videoId: string) => void;
}

export function VideoLibraryView({
  videos,
  loading,
  error,
  privacyMaskMode = 'blur',
  onRefresh,
  onOpenImportModal,
  onOpenTimelineForVideo,
}: VideoLibraryViewProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [redactingId, setRedactingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoFileRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return videos.filter((v) => {
      if (statusFilter !== 'all' && v.processing_status !== statusFilter) return false;
      if (!q) return true;
      return (
        v.original_name.toLowerCase().includes(q) ||
        (v.camera_name || '').toLowerCase().includes(q) ||
        (v.codec || '').toLowerCase().includes(q) ||
        (v.source_origin || '').toLowerCase().includes(q)
      );
    });
  }, [videos, query, statusFilter]);

  const handleInspect = async (videoId: string) => {
    setInspectingId(videoId);
    setActionError(null);
    setNotice(null);
    try {
      await api.inspectVideo(videoId);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to inspect video.');
    } finally {
      setInspectingId(null);
    }
  };

  const handleRedact = async (video: VideoFileRecord) => {
    setRedactingId(video.id);
    setActionError(null);
    setNotice(null);
    try {
      const exported = await api.redactVideo(video.id, privacyMaskMode);
      setNotice(`Created privacy-masked export '${exported.original_name}' (${privacyMaskMode}).`);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to export privacy-masked video.');
    } finally {
      setRedactingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await api.deleteVideo(deleteTarget.id);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete video.');
    }
  };

  if (loading && videos.length === 0) return <LoadingSkeleton rows={5} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            CCTV Video Library
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Local video vault for imported clips, live camera recordings, and privacy-masked exports with SHA-256 verification.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenImportModal}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Import Video File</span>
        </button>
      </div>

      {(error || actionError) && (
        <ErrorBanner message={actionError || error || 'Unexpected error'} onRetry={onRefresh} />
      )}

      {notice && (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-4 py-3 text-xs text-slate-700 dark:text-slate-300">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by filename, camera, origin, or codec..."
            className="w-full rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div className="flex items-center gap-1 p-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724]">
          {(['all', 'ready', 'imported', 'failed'] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded text-xs font-medium capitalize transition-colors ${
                statusFilter === status
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Film className="h-5 w-5" />}
          title={videos.length === 0 ? 'No CCTV videos imported yet' : 'No videos match your filter'}
          description={
            videos.length === 0
              ? 'Import an MP4, MKV, MOV, or WebM recording into the local vault to extract real codec, resolution, and duration metadata.'
              : 'Clear your search filter or import additional footage.'
          }
          action={
            videos.length === 0 ? (
              <button
                type="button"
                onClick={onOpenImportModal}
                className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white"
              >
                Import First Video
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-3 px-5 font-medium">Asset</th>
                <th className="py-3 px-4 font-medium">Camera / Origin</th>
                <th className="py-3 px-4 font-medium">Resolution / Codec</th>
                <th className="py-3 px-4 font-medium text-right">Duration</th>
                <th className="py-3 px-4 font-medium text-right">Size</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium">Imported</th>
                <th className="py-3 px-5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {filtered.map((video) => (
                <tr key={video.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-3 px-5">
                    <div className="flex items-center gap-3 min-w-[200px]">
                      <div className="h-10 w-16 shrink-0 rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 overflow-hidden flex items-center justify-center">
                        {video.thumbnail_path ? (
                          <img
                            src={resolveApiUrl(`/api/videos/${video.id}/thumbnail`)}
                            alt={video.original_name}
                            referrerPolicy="no-referrer"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <Film className="h-4 w-4 text-slate-400" aria-hidden="true" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate max-w-[240px]">
                          {video.original_name}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          SHA-256: {video.sha256_hash.slice(0, 12)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <div className="text-slate-700 dark:text-slate-200">{video.camera_name || 'Local Archive'}</div>
                    <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {video.source_origin || 'imported'}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {video.width && video.height ? `${video.width}×${video.height}` : '—'}
                    {video.codec ? ` · ${video.codec}` : ''}
                    {video.fps ? ` · ${video.fps}fps` : ''}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                    {formatDuration(video.duration_seconds)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                    {formatBytes(video.file_size_bytes)}
                  </td>
                  <td className="py-3 px-4">
                    <StatusText
                      label={video.processing_status}
                      tone={
                        video.processing_status === 'ready'
                          ? 'success'
                          : video.processing_status === 'failed'
                            ? 'danger'
                            : 'warning'
                      }
                    />
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimestamp(video.imported_at)}
                  </td>
                  <td className="py-3 px-5 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenTimelineForVideo(video.id)}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title="Open in Video Timeline"
                        aria-label={`Play ${video.original_name} in timeline`}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRedact(video)}
                        disabled={redactingId === video.id}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-40"
                        title={`Export privacy-masked copy (${privacyMaskMode})`}
                        aria-label={`Export privacy-masked ${video.original_name}`}
                      >
                        <Shield className={`h-3.5 w-3.5 ${redactingId === video.id ? 'animate-pulse' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInspect(video.id)}
                        disabled={inspectingId === video.id}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-40"
                        title="Re-run FFmpeg inspection"
                        aria-label={`Inspect ${video.original_name}`}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${inspectingId === video.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(video)}
                        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                        title="Delete video"
                        aria-label={`Delete ${video.original_name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Imported Video"
        message={
          deleteTarget
            ? `Permanently remove "${deleteTarget.original_name}" and its thumbnail from the local vault? This action is logged in Security & Audit Logs.`
            : ''
        }
        confirmLabel="Delete Video"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
