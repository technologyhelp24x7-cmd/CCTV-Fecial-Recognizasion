import type {
  AiEngineDescriptor,
  AnonymousTrackRecord,
  AppSettingsMap,
  AuditLogRecord,
  CameraRecord,
  CameraStreamSessionRecord,
  DashboardSummary,
  DiscoveredOnvifDevice,
  NvrAdapterType,
  NvrChannelRecord,
  NvrRecord,
  PersonEventRecord,
  PersonProfileRecord,
  ProcessingJobRecord,
  RecordingSessionRecord,
  RtspTransport,
  StreamProfileType,
  VideoFileRecord,
  WatchlistReviewRecord,
} from '../../shared/types.ts';

interface TauriInternals {
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export interface DesktopRuntimeInfo {
  app_name: string;
  version: string;
  os: string;
  arch: string;
  backend_url: string;
  api_token: string;
  data_dir: string;
  backend_ready: boolean;
  backend_error?: string | null;
}

let cachedApiBase: string | null = null;
let cachedApiToken = '';

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__?.invoke === 'function';
}

export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo | null> {
  if (!isTauriDesktop() || !window.__TAURI_INTERNALS__?.invoke) return null;
  try {
    return await window.__TAURI_INTERNALS__.invoke<DesktopRuntimeInfo>('get_runtime_info');
  } catch {
    return null;
  }
}

export async function pickDesktopDirectory(title: string): Promise<string | null> {
  if (!isTauriDesktop() || !window.__TAURI_INTERNALS__?.invoke) return null;
  try {
    return await window.__TAURI_INTERNALS__.invoke<string | null>('pick_storage_directory', { title });
  } catch {
    return null;
  }
}

export function resolveApiUrl(path: string): string {
  const base = cachedApiBase ?? '';
  if (!cachedApiToken) return `${base}${path}`;
  const sep = path.includes('?') ? '&' : '?';
  return `${base}${path}${sep}token=${encodeURIComponent(cachedApiToken)}`;
}

async function ensureApiContext(): Promise<{ base: string; token: string }> {
  if (cachedApiBase !== null) {
    return { base: cachedApiBase, token: cachedApiToken };
  }
  if (isTauriDesktop()) {
    const info = await getDesktopRuntimeInfo();
    cachedApiToken = info?.api_token ?? '';
    if (
      typeof window !== 'undefined' &&
      (window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost')
    ) {
      cachedApiBase = info?.backend_url ?? 'http://127.0.0.1:8420';
    } else {
      cachedApiBase = '';
    }
  } else {
    cachedApiBase = '';
  }
  return { base: cachedApiBase, token: cachedApiToken };
}

export async function waitForDesktopBackend(maxAttempts = 8, delayMs = 350): Promise<void> {
  if (!isTauriDesktop()) return;
  const { base } = await ensureApiContext();
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // Backend still initializing
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = 'API_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const { base, token } = await ensureApiContext();
  const response = await fetch(`${base}${url}`, {
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code = 'API_ERROR';
    try {
      const data = await response.json();
      if (data?.message) message = String(data.message);
      if (data?.error) code = String(data.error);
    } catch {
      // Ignore non-JSON error payloads
    }
    throw new ApiError(message, response.status, code);
  }

  return response.json() as Promise<T>;
}

export const api = {
  getDashboardSummary: () => requestJson<DashboardSummary>('/api/dashboard/summary'),

  listVideos: () => requestJson<VideoFileRecord[]>('/api/videos'),
  importVideo: (file: File, cameraId?: string | null) => {
    const form = new FormData();
    form.append('file', file);
    if (cameraId) form.append('camera_id', cameraId);
    return requestJson<VideoFileRecord>('/api/videos/import', { method: 'POST', body: form });
  },
  inspectVideo: (videoId: string) =>
    requestJson<VideoFileRecord>(`/api/videos/${encodeURIComponent(videoId)}/inspect`, { method: 'POST' }),
  deleteVideo: (videoId: string) =>
    requestJson<{ deleted: boolean; id: string }>(`/api/videos/${encodeURIComponent(videoId)}`, { method: 'DELETE' }),
  listVideoEvents: (videoId: string) =>
    requestJson<PersonEventRecord[]>(`/api/videos/${encodeURIComponent(videoId)}/events`),
  redactVideo: (videoId: string, mode: 'blur' | 'pixelate' = 'blur') =>
    requestJson<VideoFileRecord>(`/api/videos/${encodeURIComponent(videoId)}/redact`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  enforceRetention: () =>
    requestJson<{ expired_videos_deleted: number; orphaned_events_purged: number }>('/api/retention/enforce', {
      method: 'POST',
    }),

  listCameras: () => requestJson<CameraRecord[]>('/api/cameras'),
  discoverCameras: (payload?: { timeout_sec?: number; target_host?: string; target_port?: number }) =>
    requestJson<{ discovered_count: number; devices: DiscoveredOnvifDevice[] }>('/api/cameras/discover', {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    }),
  createCamera: (payload: {
    name: string;
    location_zone: string;
    source_type: string;
    stream_uri: string;
    ip_address?: string | null;
    rtsp_port?: number;
    onvif_port?: number;
    username?: string | null;
    password?: string | null;
    rtsp_transport?: RtspTransport;
    stream_profile?: StreamProfileType;
    main_stream_uri?: string | null;
    sub_stream_uri?: string | null;
    connection_timeout_sec?: number;
    enabled: boolean;
    retention_days: number;
    recording_mode: string;
    target_fps?: number;
    target_resolution?: string;
    max_reconnect_attempts?: number;
    recording_schedule?: string | null;
  }) => requestJson<CameraRecord>('/api/cameras', { method: 'POST', body: JSON.stringify(payload) }),
  updateCamera: (
    cameraId: string,
    payload: Partial<CameraRecord> & { password?: string | null; clear_password?: boolean }
  ) =>
    requestJson<CameraRecord>(`/api/cameras/${encodeURIComponent(cameraId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  checkCamera: (cameraId: string) =>
    requestJson<{ camera: CameraRecord; message: string }>(`/api/cameras/${encodeURIComponent(cameraId)}/check`, {
      method: 'POST',
    }),
  reconnectCamera: (cameraId: string) =>
    requestJson<{
      camera: CameraRecord;
      message: string;
      stream_restarted?: boolean;
    }>(`/api/cameras/${encodeURIComponent(cameraId)}/reconnect`, {
      method: 'POST',
    }),
  getCameraSnapshotUrl: (cameraId: string, captureOnDemand = true) =>
    resolveApiUrl(
      `/api/cameras/${encodeURIComponent(cameraId)}/snapshot${captureOnDemand ? '?capture=1' : ''}&ts=${Date.now()}`
    ),
  ingestLocalCamera: (cameraId: string) =>
    requestJson<{ ingested_count: number; videos: VideoFileRecord[] }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/ingest-local`,
      { method: 'POST' }
    ),
  deleteCamera: (cameraId: string) =>
    requestJson<{ deleted: boolean; id: string }>(`/api/cameras/${encodeURIComponent(cameraId)}`, { method: 'DELETE' }),

  listNvrs: () => requestJson<NvrRecord[]>('/api/nvrs'),
  createNvr: (payload: {
    name: string;
    adapter_type: NvrAdapterType;
    host: string;
    port?: number;
    rtsp_port?: number;
    username?: string | null;
    password?: string | null;
    rtsp_transport?: RtspTransport;
    rtsp_url_template?: string | null;
    channel_count?: number;
  }) => requestJson<NvrRecord>('/api/nvrs', { method: 'POST', body: JSON.stringify(payload) }),
  deleteNvr: (nvrId: string) =>
    requestJson<{ deleted: boolean; id: string }>(`/api/nvrs/${encodeURIComponent(nvrId)}`, { method: 'DELETE' }),
  testNvr: (nvrId: string) =>
    requestJson<{ nvr: NvrRecord; message: string }>(`/api/nvrs/${encodeURIComponent(nvrId)}/test`, { method: 'POST' }),
  discoverNvrChannels: (nvrId: string) =>
    requestJson<{ nvr: NvrRecord; channels: NvrChannelRecord[]; message: string }>(
      `/api/nvrs/${encodeURIComponent(nvrId)}/discover-channels`,
      { method: 'POST' }
    ),
  listNvrChannels: (nvrId: string) =>
    requestJson<NvrChannelRecord[]>(`/api/nvrs/${encodeURIComponent(nvrId)}/channels`),
  updateNvrChannel: (nvrId: string, channelId: string, enabled: boolean) =>
    requestJson<NvrChannelRecord>(
      `/api/nvrs/${encodeURIComponent(nvrId)}/channels/${encodeURIComponent(channelId)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) }
    ),
  registerNvrChannel: (nvrId: string, channelId: string, locationZone?: string) =>
    requestJson<CameraRecord>(
      `/api/nvrs/${encodeURIComponent(nvrId)}/channels/${encodeURIComponent(channelId)}/register`,
      { method: 'POST', body: JSON.stringify(locationZone ? { location_zone: locationZone } : {}) }
    ),

  listStreams: () => requestJson<CameraStreamSessionRecord[]>('/api/streams'),
  startCameraStream: (cameraId: string) =>
    requestJson<CameraStreamSessionRecord>(`/api/cameras/${encodeURIComponent(cameraId)}/stream/start`, {
      method: 'POST',
    }),
  stopCameraStream: (cameraId: string) =>
    requestJson<{ stopped: boolean; session: CameraStreamSessionRecord | null }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/stream/stop`,
      { method: 'POST' }
    ),

  listRecordings: () => requestJson<RecordingSessionRecord[]>('/api/recordings'),
  startCameraRecording: (cameraId: string, triggerMode: 'manual' | 'scheduled' | 'continuous' = 'manual') =>
    requestJson<RecordingSessionRecord>(`/api/cameras/${encodeURIComponent(cameraId)}/recording/start`, {
      method: 'POST',
      body: JSON.stringify({ trigger_mode: triggerMode }),
    }),
  stopCameraRecording: (cameraId: string) =>
    requestJson<RecordingSessionRecord>(`/api/cameras/${encodeURIComponent(cameraId)}/recording/stop`, {
      method: 'POST',
    }),
  evaluateCameraSchedule: (cameraId: string) =>
    requestJson<{ camera_id: string; schedule_active: boolean; action_taken: string }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/schedule/evaluate`,
      { method: 'POST' }
    ),

  listPersonEvents: (filters?: {
    camera_id?: string;
    video_file_id?: string;
    status?: string;
    track_id?: string;
    from?: string;
    to?: string;
  }) => {
    const qs = new URLSearchParams();
    if (filters?.camera_id) qs.set('camera_id', filters.camera_id);
    if (filters?.video_file_id) qs.set('video_file_id', filters.video_file_id);
    if (filters?.status) qs.set('status', filters.status);
    if (filters?.track_id) qs.set('track_id', filters.track_id);
    if (filters?.from) qs.set('from', filters.from);
    if (filters?.to) qs.set('to', filters.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return requestJson<PersonEventRecord[]>(`/api/person-events${suffix}`);
  },
  updatePersonEvent: (
    eventId: string,
    payload: { status?: string; profile_id?: string | null; reviewed_by?: string }
  ) =>
    requestJson<PersonEventRecord>(`/api/person-events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deletePersonEvent: (eventId: string) =>
    requestJson<{ deleted: boolean; id: string }>(`/api/person-events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
    }),
  listAnonymousTracks: () => requestJson<AnonymousTrackRecord[]>('/api/anonymous-tracks'),

  listProfiles: () => requestJson<PersonProfileRecord[]>('/api/profiles'),
  createProfile: (payload: {
    display_name: string;
    category: 'authorized' | 'anonymous';
    authorization_level: 'authorized' | 'visitor' | 'restricted' | 'anonymous';
    consent_status: 'granted' | 'pending' | 'revoked';
    department_or_zone: string;
    notes: string;
  }) => requestJson<PersonProfileRecord>('/api/profiles', { method: 'POST', body: JSON.stringify(payload) }),
  updateProfile: (profileId: string, payload: Partial<PersonProfileRecord>) =>
    requestJson<PersonProfileRecord>(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteProfile: (profileId: string) =>
    requestJson<{ deleted: boolean; id: string }>(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: 'DELETE',
    }),

  listAiEngines: () => requestJson<AiEngineDescriptor[]>('/api/ai/engines'),
  listAiJobs: () => requestJson<ProcessingJobRecord[]>('/api/ai/jobs'),
  runAiJob: (
    videoFileId: string,
    engineId: string,
    options?: { sample_fps?: number; confidence_threshold?: number }
  ) =>
    requestJson<ProcessingJobRecord>('/api/ai/jobs', {
      method: 'POST',
      body: JSON.stringify({ video_file_id: videoFileId, engine_id: engineId, ...options }),
    }),

  listWatchlistReviews: () => requestJson<WatchlistReviewRecord[]>('/api/watchlist-reviews'),
  createWatchlistReview: (payload: {
    title: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
    profile_id?: string | null;
    video_file_id?: string | null;
    event_id?: string | null;
    assigned_to: string;
  }) => requestJson<WatchlistReviewRecord>('/api/watchlist-reviews', { method: 'POST', body: JSON.stringify(payload) }),
  updateWatchlistReview: (reviewId: string, payload: { status?: string; reviewer_notes?: string }) =>
    requestJson<WatchlistReviewRecord>(`/api/watchlist-reviews/${encodeURIComponent(reviewId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  getReportsSummary: () =>
    requestJson<{
      generated_at: string;
      platform: string;
      stage: string;
      counts: Record<string, number>;
      cameras: unknown[];
      videos: unknown[];
      profiles: unknown[];
      reviews: unknown[];
    }>('/api/reports/summary'),

  listAuditLogs: (limit = 150, outcome = '') =>
    requestJson<AuditLogRecord[]>(
      `/api/audit-logs?limit=${limit}${outcome ? `&outcome=${encodeURIComponent(outcome)}` : ''}`
    ),

  getSettings: () => requestJson<AppSettingsMap>('/api/settings'),
  updateSettings: (updates: Partial<AppSettingsMap>) =>
    requestJson<AppSettingsMap>('/api/settings', { method: 'PUT', body: JSON.stringify(updates) }),
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
