-- LumaFlux Intelligence Canonical Schema (SQLite 3.40+ / PostgreSQL-portable)
-- Stage 1 Foundation + Stage 2 Live Streaming, Recording, Detection & Anonymous Tracking

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nvrs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL DEFAULT 'standard_onvif_rtsp' CHECK (adapter_type IN ('standard_onvif_rtsp', 'generic_rtsp_channels')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 80,
  rtsp_port INTEGER NOT NULL DEFAULT 554,
  username TEXT,
  credential_ref TEXT,
  rtsp_transport TEXT NOT NULL DEFAULT 'tcp' CHECK (rtsp_transport IN ('tcp', 'udp')),
  rtsp_url_template TEXT,
  channel_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'online', 'offline')),
  device_manufacturer TEXT,
  device_model TEXT,
  firmware_version TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_zone TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('rtsp', 'onvif', 'http', 'local_archive')),
  stream_uri TEXT NOT NULL,
  ip_address TEXT,
  rtsp_port INTEGER NOT NULL DEFAULT 554,
  onvif_port INTEGER NOT NULL DEFAULT 80,
  username TEXT,
  credential_ref TEXT,
  rtsp_transport TEXT NOT NULL DEFAULT 'tcp' CHECK (rtsp_transport IN ('tcp', 'udp')),
  stream_profile TEXT NOT NULL DEFAULT 'main' CHECK (stream_profile IN ('main', 'sub')),
  main_stream_uri TEXT,
  sub_stream_uri TEXT,
  connection_timeout_sec REAL NOT NULL DEFAULT 6.0,
  nvr_id TEXT REFERENCES nvrs(id) ON DELETE SET NULL,
  channel_number INTEGER,
  device_manufacturer TEXT,
  device_model TEXT,
  firmware_version TEXT,
  vendor_driver TEXT NOT NULL DEFAULT 'standard_onvif',
  capabilities_json TEXT,
  verification_stages_json TEXT,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'online', 'offline', 'maintenance')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days >= 1 AND retention_days <= 3650),
  recording_mode TEXT NOT NULL DEFAULT 'manual' CHECK (recording_mode IN ('manual', 'scheduled', 'motion_trigger', 'continuous')),
  last_checked_at TEXT,
  last_error TEXT,
  reconnect_attempts INTEGER NOT NULL DEFAULT 0,
  max_reconnect_attempts INTEGER NOT NULL DEFAULT 5,
  target_fps REAL NOT NULL DEFAULT 5.0,
  target_resolution TEXT NOT NULL DEFAULT '1280x720',
  recording_schedule TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nvr_channels (
  id TEXT PRIMARY KEY,
  nvr_id TEXT NOT NULL REFERENCES nvrs(id) ON DELETE CASCADE,
  channel_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  profile_token TEXT,
  main_stream_uri TEXT NOT NULL,
  sub_stream_uri TEXT,
  width INTEGER,
  height INTEGER,
  fps REAL,
  codec TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'online', 'offline')),
  registered_camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(nvr_id, channel_number)
);

CREATE TABLE IF NOT EXISTS video_files (
  id TEXT PRIMARY KEY,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  sha256_hash TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  codec TEXT,
  processing_status TEXT NOT NULL DEFAULT 'imported' CHECK (processing_status IN ('imported', 'queued', 'inspecting', 'ready', 'failed')),
  error_message TEXT,
  recorded_at TEXT,
  recording_session_id TEXT,
  source_origin TEXT NOT NULL DEFAULT 'imported',
  expires_at TEXT,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_profiles (
  id TEXT PRIMARY KEY,
  profile_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('authorized', 'anonymous')),
  authorization_level TEXT NOT NULL CHECK (authorization_level IN ('authorized', 'visitor', 'restricted', 'anonymous')),
  consent_status TEXT NOT NULL DEFAULT 'pending' CHECK (consent_status IN ('granted', 'pending', 'revoked')),
  consent_recorded_at TEXT,
  retention_expires_at TEXT,
  department_or_zone TEXT NOT NULL DEFAULT 'General',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS camera_stream_sessions (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('starting', 'streaming', 'reconnecting', 'stopped', 'error')),
  transport TEXT NOT NULL DEFAULT 'ffmpeg',
  sample_fps REAL NOT NULL DEFAULT 5.0,
  resolution TEXT,
  frames_captured INTEGER NOT NULL DEFAULT 0,
  frames_dropped INTEGER NOT NULL DEFAULT 0,
  bytes_received INTEGER NOT NULL DEFAULT 0,
  avg_frame_ms REAL,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  last_frame_at TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  video_file_id TEXT REFERENCES video_files(id) ON DELETE SET NULL,
  trigger_mode TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_mode IN ('manual', 'scheduled', 'continuous')),
  status TEXT NOT NULL CHECK (status IN ('recording', 'completed', 'interrupted', 'failed')),
  output_path TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL,
  error_message TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS anonymous_tracks (
  id TEXT PRIMARY KEY,
  track_code TEXT NOT NULL,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  video_file_id TEXT REFERENCES video_files(id) ON DELETE CASCADE,
  stream_session_id TEXT REFERENCES camera_stream_sessions(id) ON DELETE SET NULL,
  first_seen_sec REAL NOT NULL DEFAULT 0,
  last_seen_sec REAL NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 1,
  best_confidence REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'reviewed', 'purged')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_events (
  id TEXT PRIMARY KEY,
  video_file_id TEXT NOT NULL REFERENCES video_files(id) ON DELETE CASCADE,
  camera_id TEXT REFERENCES cameras(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES person_profiles(id) ON DELETE SET NULL,
  anonymous_track_id TEXT REFERENCES anonymous_tracks(id) ON DELETE SET NULL,
  event_timestamp_sec REAL NOT NULL DEFAULT 0,
  end_timestamp_sec REAL,
  confidence REAL,
  frame_number INTEGER,
  frame_count INTEGER NOT NULL DEFAULT 1,
  bbox_json TEXT,
  crop_path TEXT,
  model_name TEXT,
  notes TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT,
  reviewed_at TEXT,
  status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'clustered', 'linked', 'dismissed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_thumbnails (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES person_events(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  privacy_masked INTEGER NOT NULL DEFAULT 1 CHECK (privacy_masked IN (0, 1)),
  mask_mode TEXT NOT NULL DEFAULT 'blur' CHECK (mask_mode IN ('none', 'blur', 'pixelate')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_collection_items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES gallery_collections(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES person_events(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  UNIQUE(collection_id, event_id)
);

CREATE TABLE IF NOT EXISTS watchlist_reviews (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  profile_id TEXT REFERENCES person_profiles(id) ON DELETE SET NULL,
  video_file_id TEXT REFERENCES video_files(id) ON DELETE SET NULL,
  event_id TEXT REFERENCES person_events(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'dismissed', 'escalated')),
  reason TEXT NOT NULL,
  reviewer_notes TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT 'Security Operator',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  video_file_id TEXT NOT NULL REFERENCES video_files(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('metadata_probe', 'thumbnail_extract', 'ai_person_detect')),
  engine_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  progress_pct INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct >= 0 AND progress_pct <= 100),
  log_output TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  source_ip TEXT NOT NULL DEFAULT '127.0.0.1',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT 'default',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en-US',
  diagnostics_json TEXT,
  action_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_actions (
  id TEXT PRIMARY KEY,
  level INTEGER NOT NULL CHECK (level IN (1, 2, 3, 4)),
  action_type TEXT NOT NULL,
  target_resource TEXT NOT NULL DEFAULT 'system',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('executed', 'pending_confirmation', 'approved', 'rejected', 'denied', 'failed', 'rolled_back')),
  before_state_json TEXT,
  after_state_json TEXT,
  rollback_json TEXT,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  requested_by TEXT NOT NULL DEFAULT 'Local Administrator',
  reviewed_by TEXT,
  result_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extension_proposals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  explanation TEXT NOT NULL,
  affected_modules_json TEXT NOT NULL DEFAULT '[]',
  proposed_code TEXT NOT NULL DEFAULT '',
  widget_spec_json TEXT NOT NULL DEFAULT '{}',
  test_status TEXT NOT NULL DEFAULT 'pending' CHECK (test_status IN ('pending', 'passed', 'failed')),
  test_output TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'rolled_back')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cameras_nvr_id ON cameras(nvr_id);
CREATE INDEX IF NOT EXISTS idx_nvr_channels_nvr_id ON nvr_channels(nvr_id, channel_number);
CREATE INDEX IF NOT EXISTS idx_video_files_imported_at ON video_files(imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_files_camera_id ON video_files(camera_id);
CREATE INDEX IF NOT EXISTS idx_stream_sessions_camera_id ON camera_stream_sessions(camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_camera_id ON recording_sessions(camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_anonymous_tracks_video_id ON anonymous_tracks(video_file_id);
CREATE INDEX IF NOT EXISTS idx_person_events_video_id ON person_events(video_file_id);
CREATE INDEX IF NOT EXISTS idx_person_events_profile_id ON person_events(profile_id);
CREATE INDEX IF NOT EXISTS idx_person_events_track_id ON person_events(anonymous_track_id);
CREATE INDEX IF NOT EXISTS idx_event_thumbnails_event_id ON event_thumbnails(event_id);
CREATE INDEX IF NOT EXISTS idx_gallery_collection_items_col ON gallery_collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_reviews_status ON watchlist_reviews(status);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_video_id ON processing_jobs(video_file_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_created_at ON assistant_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_status ON assistant_actions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extension_proposals_status ON extension_proposals(status, created_at DESC);
