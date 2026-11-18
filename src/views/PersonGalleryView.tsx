import { useMemo, useState } from 'react';
import { Check, Flag, Play, Trash2, Users } from 'lucide-react';
import { api, formatDuration, formatTimestamp, resolveApiUrl } from '../api/client.ts';
import { EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type {
  AnonymousTrackRecord,
  CameraRecord,
  NavModuleId,
  PersonEventRecord,
  PersonProfileRecord,
} from '../../shared/types.ts';

interface PersonGalleryViewProps {
  events: PersonEventRecord[];
  tracks: AnonymousTrackRecord[];
  cameras: CameraRecord[];
  profiles: PersonProfileRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onNavigate: (module: NavModuleId) => void;
  onJumpToTimeline: (videoId: string, timestampSec: number) => void;
}

export function PersonGalleryView({
  events,
  tracks,
  cameras,
  profiles,
  loading,
  error,
  onRefresh,
  onNavigate,
  onJumpToTimeline,
}: PersonGalleryViewProps) {
  const [cameraFilter, setCameraFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [trackFilter, setTrackFilter] = useState<string>('all');
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const consentedProfiles = useMemo(
    () => profiles.filter((p) => p.consent_status === 'granted'),
    [profiles]
  );

  const filteredEvents = useMemo(() => {
    return events.filter((evt) => {
      if (cameraFilter !== 'all' && evt.camera_id !== cameraFilter) return false;
      if (statusFilter !== 'all' && evt.status !== statusFilter) return false;
      if (trackFilter !== 'all' && evt.anonymous_track_id !== trackFilter) return false;
      return true;
    });
  }, [events, cameraFilter, statusFilter, trackFilter]);

  const handleReviewStatus = async (evt: PersonEventRecord, status: 'clustered' | 'dismissed') => {
    setBusyEventId(evt.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.updatePersonEvent(evt.id, { status });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update event status.');
    } finally {
      setBusyEventId(null);
    }
  };

  const handleLinkProfile = async (evt: PersonEventRecord, profileId: string) => {
    setBusyEventId(evt.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.updatePersonEvent(evt.id, {
        status: profileId ? 'linked' : 'unreviewed',
        profile_id: profileId || null,
      });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Consent policy blocked profile link.');
    } finally {
      setBusyEventId(null);
    }
  };

  const handleEscalate = async (evt: PersonEventRecord) => {
    setBusyEventId(evt.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.createWatchlistReview({
        title: `Event Review · ${evt.track_code || evt.id.slice(0, 8)}`,
        priority: 'medium',
        reason: `Operator escalated person event at ${evt.event_timestamp_sec.toFixed(2)}s in ${evt.video_name || evt.video_file_id}.`,
        video_file_id: evt.video_file_id,
        event_id: evt.id,
        profile_id: evt.profile_id,
        assigned_to: 'Security Operator',
      });
      setNotice(`Escalated event ${evt.track_code || evt.id.slice(0, 8)} to Watchlist Review.`);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to escalate event.');
    } finally {
      setBusyEventId(null);
    }
  };

  const handleDelete = async (evt: PersonEventRecord) => {
    setBusyEventId(evt.id);
    setActionError(null);
    try {
      await api.deletePersonEvent(evt.id);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete event.');
    } finally {
      setBusyEventId(null);
    }
  };

  if (loading && events.length === 0) return <LoadingSkeleton rows={4} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Person Gallery
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Session-scoped anonymous person events populated strictly by verified OpenCV detection runs. Biometric cross-camera matching remains disabled.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('ai-detection')}
          className="px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Run AI Detection
        </button>
      </div>

      {(error || actionError) && <ErrorBanner message={actionError || error || 'Gallery error'} onRetry={onRefresh} />}

      {notice && (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-4 py-3 text-xs text-slate-700 dark:text-slate-300">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Filter gallery by camera"
          value={cameraFilter}
          onChange={(e) => setCameraFilter(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
        >
          <option value="all">All Cameras</option>
          {cameras.map((cam) => (
            <option key={cam.id} value={cam.id}>
              {cam.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter gallery by review status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
        >
          <option value="all">All Statuses</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="clustered">Reviewed</option>
          <option value="linked">Linked (Consented)</option>
          <option value="dismissed">Dismissed</option>
        </select>

        {tracks.length > 0 && (
          <select
            aria-label="Filter gallery by anonymous track"
            value={trackFilter}
            onChange={(e) => setTrackFilter(e.target.value)}
            className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
          >
            <option value="all">All Session Tracks</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.track_code} ({t.camera_name || 'Local'})
              </option>
            ))}
          </select>
        )}
      </div>

      {filteredEvents.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={events.length === 0 ? 'No detected person events in database' : 'No events match active filters'}
          description={
            events.length === 0
              ? 'Run an OpenCV Person Detection job in the AI Detection module on imported or recorded footage. Zero synthetic detections are ever generated.'
              : 'Reset filters to inspect all recorded person events.'
          }
          action={
            <button
              type="button"
              onClick={() => onNavigate('ai-detection')}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white"
            >
              Open AI Detection
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredEvents.map((evt) => (
            <div
              key={evt.id}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-hidden flex flex-col justify-between"
            >
              <div>
                <div className="h-44 bg-slate-100 dark:bg-[#0D121D] border-b border-slate-200 dark:border-slate-800 flex items-center justify-center overflow-hidden">
                  {evt.crop_path ? (
                    <img
                      src={resolveApiUrl(`/api/person-events/${evt.id}/thumbnail`)}
                      alt={`Event ${evt.track_code || evt.id}`}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <Users className="h-7 w-7 text-slate-400" aria-hidden="true" />
                  )}
                </div>

                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {evt.track_code || 'Anonymous Subject'}
                    </span>
                    <StatusText
                      label={evt.status}
                      tone={
                        evt.status === 'linked'
                          ? 'success'
                          : evt.status === 'dismissed'
                            ? 'neutral'
                            : evt.status === 'clustered'
                              ? 'warning'
                              : 'warning'
                      }
                    />
                  </div>

                  <div className="text-xs text-slate-600 dark:text-slate-300 truncate">
                    {evt.camera_name || 'Local Archive'} · {evt.video_name || evt.video_file_id}
                  </div>

                  <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums space-y-0.5">
                    <div>
                      Offset: {formatDuration(evt.event_timestamp_sec)} ({evt.event_timestamp_sec.toFixed(2)}s)
                      {evt.frame_count ? ` · ${evt.frame_count} frame(s)` : ''}
                    </div>
                    <div>
                      Confidence: {evt.confidence ? `${Math.round(evt.confidence * 100)}%` : '—'} ·{' '}
                      {evt.model_name || 'opencv'}
                    </div>
                    <div>Recorded: {formatTimestamp(evt.created_at)}</div>
                  </div>
                </div>
              </div>

              <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800/80 space-y-2">
                {consentedProfiles.length > 0 && (
                  <select
                    aria-label="Associate event with consented profile"
                    value={evt.profile_id || ''}
                    disabled={busyEventId === evt.id}
                    onChange={(e) => handleLinkProfile(evt, e.target.value)}
                    className="w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2.5 py-1.5 text-[11px] text-slate-800 dark:text-slate-200"
                  >
                    <option value="">Unlinked (Anonymous)</option>
                    {consentedProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.profile_code} · {p.display_name}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => onJumpToTimeline(evt.video_file_id, evt.event_timestamp_sec)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[11px] font-medium bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    <Play className="h-3 w-3" />
                    <span>Playback</span>
                  </button>

                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busyEventId === evt.id}
                      onClick={() => handleReviewStatus(evt, 'clustered')}
                      className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                      title="Mark Reviewed"
                      aria-label="Mark event reviewed"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busyEventId === evt.id}
                      onClick={() => handleEscalate(evt)}
                      className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-amber-600 dark:text-amber-400"
                      title="Escalate to Watchlist Review"
                      aria-label="Escalate event"
                    >
                      <Flag className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={busyEventId === evt.id}
                      onClick={() => handleDelete(evt)}
                      className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                      title="Delete event"
                      aria-label="Delete event"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
