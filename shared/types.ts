export type ThemeMode = 'dark' | 'light';

export type NavModuleId =
  | 'dashboard'
  | 'video-library'
  | 'person-gallery'
  | 'person-profiles'
  | 'camera-management'
  | 'video-timeline'
  | 'ai-detection'
  | 'ai-assistant'
  | 'watchlist-review'
  | 'reports'
  | 'audit-logs'
  | 'settings';

export type CameraSourceType = 'rtsp' | 'onvif' | 'http' | 'local_archive';
export type CameraStatus = 'configured' | 'online' | 'offline' | 'maintenance';
export type RecordingMode = 'manual' | 'scheduled' | 'motion_trigger' | 'continuous';
export type RtspTransport = 'tcp' | 'udp';
export type StreamProfileType = 'main' | 'sub';
export type NvrAdapterType = 'standard_onvif_rtsp' | 'generic_rtsp_channels';

export type CameraDriverId =
  | 'standard_onvif'
  | 'hikvision_isapi'
  | 'dahua_rpc2'
  | 'terabyte_rtsp'
  | 'cp_plus_rtsp'
  | 'axis_vapix'
  | 'reolink_http_rtsp'
  | 'uniview_rtsp'
  | 'tvt_rtsp'
  | 'manual_rtsp'
  | 'http_mjpeg'
  | 'local_archive';

export interface CameraCapabilityMatrix {
  live_stream: boolean;
  recording: boolean;
  snapshot: boolean;
  dual_stream: boolean;
  onvif_discovery: boolean;
  rtsp_tcp: boolean;
  rtsp_udp: boolean;
  http_snapshot_fallback: boolean;
  nvr_multi_channel: boolean;
  audio_stream: boolean;
  ptz_control: boolean;
}

export interface CameraDriverDescriptor {
  id: CameraDriverId;
  vendor_name: string;
  label: string;
  default_source_type: CameraSourceType;
  default_rtsp_port: number;
  default_control_port: number;
  main_uri_template: string;
  sub_uri_template: string | null;
  snapshot_path_template: string | null;
  auth_modes: string[];
  capabilities: CameraCapabilityMatrix;
  compatibility_note: string;
}

export interface VerificationStages {
  device_discovered: boolean;
  onvif_authenticated: boolean;
  device_info_retrieved: boolean;
  profiles_retrieved: boolean;
  rtsp_uri_retrieved: boolean;
  rtsp_stream_opened: boolean;
  checked_at?: string | null;
  error?: string | null;
}

export interface DiscoveredOnvifDevice {
  endpoint_reference: string;
  xaddrs: string[];
  host: string;
  port: number;
  service_path: string;
  name: string;
  hardware: string;
  scopes: string[];
  types: string[];
}

export interface CameraRecord {
  id: string;
  name: string;
  location_zone: string;
  source_type: CameraSourceType;
  vendor_driver?: CameraDriverId;
  capabilities?: CameraCapabilityMatrix | null;
  stream_uri: string;
  stream_uri_masked?: string;
  ip_address?: string | null;
  rtsp_port?: number;
  onvif_port?: number;
  username?: string | null;
  has_credentials?: boolean;
  rtsp_transport?: RtspTransport;
  stream_profile?: StreamProfileType;
  main_stream_uri?: string | null;
  sub_stream_uri?: string | null;
  connection_timeout_sec?: number;
  nvr_id?: string | null;
  channel_number?: number | null;
  device_manufacturer?: string | null;
  device_model?: string | null;
  firmware_version?: string | null;
  verification_stages?: VerificationStages | null;
  status: CameraStatus;
  enabled: boolean;
  retention_days: number;
  recording_mode: RecordingMode;
  last_checked_at: string | null;
  last_error?: string | null;
  reconnect_attempts?: number;
  max_reconnect_attempts?: number;
  target_fps?: number;
  target_resolution?: string;
  recording_schedule?: string | null;
  active_stream_id?: string | null;
  active_recording_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CameraStreamSessionRecord {
  id: string;
  camera_id: string;
  camera_name?: string | null;
  status: 'starting' | 'streaming' | 'reconnecting' | 'stopped' | 'error';
  transport: string;
  sample_fps: number;
  resolution: string | null;
  frames_captured: number;
  frames_dropped?: number;
  bytes_received?: number;
  avg_frame_ms?: number | null;
  reconnect_count: number;
  last_frame_at: string | null;
  error_message: string | null;
  started_at: string;
  stopped_at: string | null;
}

export interface NvrRecord {
  id: string;
  name: string;
  adapter_type: NvrAdapterType;
  host: string;
  port: number;
  rtsp_port: number;
  username: string | null;
  has_credentials: boolean;
  rtsp_transport: RtspTransport;
  rtsp_url_template: string | null;
  channel_count: number;
  status: 'configured' | 'online' | 'offline';
  device_manufacturer: string | null;
  device_model: string | null;
  firmware_version: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NvrChannelRecord {
  id: string;
  nvr_id: string;
  channel_number: number;
  name: string;
  profile_token: string | null;
  main_stream_uri: string;
  sub_stream_uri: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  enabled: boolean;
  status: 'configured' | 'online' | 'offline';
  registered_camera_id: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordingSessionRecord {
  id: string;
  camera_id: string;
  camera_name?: string | null;
  video_file_id: string | null;
  trigger_mode: 'manual' | 'scheduled' | 'continuous';
  status: 'recording' | 'completed' | 'interrupted' | 'failed';
  output_path: string;
  file_size_bytes: number;
  duration_seconds: number | null;
  error_message: string | null;
  started_at: string;
  ended_at: string | null;
}

export type VideoProcessingStatus = 'imported' | 'queued' | 'inspecting' | 'ready' | 'failed';

export interface VideoFileRecord {
  id: string;
  camera_id: string | null;
  camera_name?: string | null;
  filename: string;
  original_name: string;
  storage_path: string;
  thumbnail_path: string | null;
  sha256_hash: string;
  file_size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  processing_status: VideoProcessingStatus;
  error_message: string | null;
  recorded_at: string | null;
  recording_session_id?: string | null;
  source_origin?: 'imported' | 'recorded' | 'redacted_export';
  expires_at?: string | null;
  imported_at: string;
}

export type ProfileCategory = 'authorized' | 'anonymous';
export type AuthorizationLevel = 'authorized' | 'visitor' | 'restricted' | 'anonymous';
export type ConsentStatus = 'granted' | 'pending' | 'revoked';

export interface PersonProfileRecord {
  id: string;
  profile_code: string;
  display_name: string;
  category: ProfileCategory;
  authorization_level: AuthorizationLevel;
  consent_status: ConsentStatus;
  consent_recorded_at: string | null;
  retention_expires_at: string | null;
  department_or_zone: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnonymousTrackRecord {
  id: string;
  track_code: string;
  camera_id: string | null;
  camera_name?: string | null;
  video_file_id: string | null;
  stream_session_id: string | null;
  first_seen_sec: number;
  last_seen_sec: number;
  event_count: number;
  best_confidence: number | null;
  status: 'active' | 'closed' | 'reviewed' | 'purged';
  created_at: string;
  updated_at: string;
}

export interface PersonEventRecord {
  id: string;
  video_file_id: string;
  video_name?: string | null;
  camera_id: string | null;
  camera_name?: string | null;
  profile_id: string | null;
  anonymous_track_id?: string | null;
  track_code?: string | null;
  event_timestamp_sec: number;
  end_timestamp_sec?: number | null;
  confidence: number | null;
  frame_number: number | null;
  frame_count?: number;
  bbox_json?: string | null;
  crop_path: string | null;
  model_name?: string | null;
  notes?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  status: 'unreviewed' | 'clustered' | 'linked' | 'dismissed';
  created_at: string;
}

export interface GalleryCollectionRecord {
  id: string;
  name: string;
  description: string;
  item_count: number;
  event_ids: string[];
  created_at: string;
  updated_at: string;
}

export type ReviewPriority = 'low' | 'medium' | 'high' | 'critical';
export type ReviewStatus = 'pending' | 'in_review' | 'approved' | 'dismissed' | 'escalated';

export interface WatchlistReviewRecord {
  id: string;
  title: string;
  profile_id: string | null;
  profile_name?: string | null;
  video_file_id: string | null;
  video_name?: string | null;
  event_id: string | null;
  priority: ReviewPriority;
  status: ReviewStatus;
  reason: string;
  reviewer_notes: string;
  assigned_to: string;
  created_at: string;
  updated_at: string;
}

export interface ProcessingJobRecord {
  id: string;
  video_file_id: string;
  video_name?: string | null;
  job_type: 'metadata_probe' | 'thumbnail_extract' | 'ai_person_detect';
  engine_name: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  progress_pct: number;
  log_output: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  actor: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string;
  outcome: 'success' | 'denied' | 'error';
  source_ip: string;
  created_at: string;
}

export interface AppSettingsMap {
  storage_directory: string;
  thumbnail_directory: string;
  max_storage_quota_gb: string;
  default_retention_days: string;
  privacy_blur_default: string;
  privacy_mask_mode: string;
  detection_confidence_threshold: string;
  detection_sample_fps: string;
  require_consent_for_profiles: string;
  log_level: string;
  theme: ThemeMode;
  database_engine: string;
  [key: string]: string;
}

export interface StorageUsageSummary {
  storage_directory: string;
  video_bytes_used: number;
  thumbnail_bytes_used: number;
  database_bytes_used: number;
  total_app_bytes_used: number;
  quota_bytes: number;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
}

export interface VideoProcessingStatusSummary {
  imported: number;
  queued: number;
  inspecting: number;
  ready: number;
  failed: number;
  recent_jobs: ProcessingJobRecord[];
}

export interface DashboardSummary {
  total_imported_videos: number;
  connected_cameras: number;
  total_cameras: number;
  active_streams?: number;
  active_recordings?: number;
  detected_person_events: number;
  anonymous_tracks_count?: number;
  anonymous_person_profiles: number;
  authorized_registered_profiles: number;
  pending_security_reviews: number;
  storage_usage: StorageUsageSummary;
  recent_activity: AuditLogRecord[];
  video_processing_status: VideoProcessingStatusSummary;
  system_capabilities: {
    database_engine: string;
    ffmpeg_available: boolean;
    opencv_available?: boolean;
    ai_stage: string;
    biometric_identification_enabled: boolean;
    runtime_mode: string;
  };
}

export interface AiEngineDescriptor {
  id: string;
  name: string;
  stage: string;
  status: 'ready' | 'pending_stage_2' | 'disabled_by_policy' | 'missing_dependency';
  description: string;
  privacy_guardrail: string;
}

export interface PlatformCapabilitiesReport {
  os_family: 'windows' | 'macos' | 'linux' | 'other';
  os_release: string;
  arch: string;
  hostname: string;
  cpu_count: number;
  cpu_load_1m: number | null;
  memory_total_bytes: number | null;
  memory_free_bytes: number | null;
  disk_total_bytes: number | null;
  disk_free_bytes: number | null;
  ffmpeg_available: boolean;
  ffmpeg_version: string | null;
  opencv_available: boolean;
  opencv_version: string | null;
  supported_video_extensions: string[];
  ffmpeg_demuxers: string[];
  ffmpeg_decoders: string[];
  desktop_targets: Array<{
    platform: string;
    arch: string;
    bundle_formats: string[];
    runtime_stack: string;
    verification_status: string;
    notes: string;
  }>;
  windows7_legacy_evaluation: {
    supported_in_main_tauri2_build: boolean;
    reason: string;
    recommended_legacy_path: string;
    verification_status: string;
  };
}

export type AssistantLanguage = 'en-US' | 'en-IN' | 'hi-IN';
export type AssistantPermissionLevel = 1 | 2 | 3 | 4;
export type AssistantActionStatus =
  | 'executed'
  | 'pending_confirmation'
  | 'approved'
  | 'rejected'
  | 'denied'
  | 'failed'
  | 'rolled_back';

export interface AssistantDiagnosticCheck {
  component: string;
  status: 'healthy' | 'warning' | 'error';
  summary: string;
  details?: string | null;
}

export interface AssistantDiagnosticReport {
  checked_at: string;
  overall_status: 'healthy' | 'degraded' | 'error';
  checks: AssistantDiagnosticCheck[];
  metrics: {
    cpu_count: number;
    cpu_load_1m: number | null;
    memory_used_pct: number | null;
    disk_free_bytes: number | null;
    cameras_total: number;
    cameras_online: number;
    cameras_offline: number;
    nvrs_total: number;
    nvrs_offline: number;
    active_streams: number;
    active_recordings: number;
    failed_recordings: number;
    failed_videos: number;
    failed_jobs: number;
  };
}

export interface AssistantActionRecord {
  id: string;
  level: AssistantPermissionLevel;
  action_type: string;
  target_resource: string;
  payload: Record<string, unknown>;
  status: AssistantActionStatus;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  rollback_data: Record<string, unknown> | null;
  verified: boolean;
  requested_by: string;
  reviewed_by: string | null;
  result_message: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantMessageRecord {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  language: AssistantLanguage;
  diagnostics: AssistantDiagnosticReport | null;
  action_id: string | null;
  created_at: string;
}

export interface DashboardWidgetSpec {
  widget_id: string;
  widget_type: 'offline_cameras' | 'storage_health' | 'recent_failed_jobs' | 'nvr_channel_health';
  title: string;
  subtitle: string;
  target_module: NavModuleId;
}

export interface ExtensionProposalRecord {
  id: string;
  title: string;
  prompt: string;
  explanation: string;
  affected_modules: string[];
  proposed_code: string;
  widget_spec: DashboardWidgetSpec | Record<string, unknown>;
  test_status: 'pending' | 'passed' | 'failed';
  test_output: string;
  status: 'proposed' | 'approved' | 'rejected' | 'rolled_back';
  created_at: string;
  updated_at: string;
}

