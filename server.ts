import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import multer from 'multer';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  AiEngineDescriptor,
  AppSettingsMap,
  AuditLogRecord,
  CameraRecord,
  DashboardSummary,
  NvrChannelRecord,
  NvrRecord,
  PersonProfileRecord,
  ProcessingJobRecord,
  RtspTransport,
  StreamProfileType,
  VideoFileRecord,
  WatchlistReviewRecord,
} from './shared/types.ts';
import {
  buildEffectiveCameraUri,
  discoverLocalArchiveFiles,
  probeCameraConnection,
  redactStreamUri,
  sanitizeLogText,
} from './server/cameraService.ts';
import { CredentialVault, stripUriCredentials } from './server/credentialStore.ts';
import { getNvrAdapter } from './server/nvrService.ts';
import { discoverOnvifDevices } from './server/onvifClient.ts';
import { LiveStreamAndRecordingManager } from './server/streamManager.ts';
import {
  enforceRetentionPolicies,
  exportPrivacyMaskedVideo,
  type PrivacyMaskMode,
} from './server/privacyService.ts';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerOptions {
  dbPath?: string;
  storageDir?: string;
  thumbnailDir?: string;
  logDir?: string;
  apiToken?: string;
  skipVite?: boolean;
}

interface ParsedMediaMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function computeDirectoryBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += computeDirectoryBytes(fullPath);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        // Ignore transient unlinked files
      }
    }
  }
  return total;
}

async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function checkOpenCvStatus(): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', 'import cv2; print(cv2.__version__)'],
      { timeout: 3000, cwd: __dirname }
    );
    const version = stdout.trim();
    return { available: Boolean(version), version: version || null };
  } catch {
    return { available: false, version: null };
  }
}

function parseFfmpegStderr(stderr: string): ParsedMediaMetadata {
  let durationSeconds: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;
  let codec: string | null = null;

  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (durMatch) {
    durationSeconds = Number(
      (Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])).toFixed(3)
    );
  }

  const streamMatch = stderr.match(
    /Video:\s*([a-zA-Z0-9_\-]+).*?,\s*(\d{2,5})x(\d{2,5})(?:[^,\n]*,\s*(\d+(?:\.\d+)?)\s*fps)?/
  );
  if (streamMatch) {
    codec = streamMatch[1];
    width = Number(streamMatch[2]);
    height = Number(streamMatch[3]);
    fps = streamMatch[4] ? Number(streamMatch[4]) : null;
  }

  return { durationSeconds, width, height, fps, codec };
}

async function probeVideoWithFfmpeg(filePath: string): Promise<ParsedMediaMetadata> {
  try {
    await execFileAsync('ffmpeg', ['-hide_banner', '-i', filePath], { timeout: 15000 });
    return { durationSeconds: null, width: null, height: null, fps: null, codec: null };
  } catch (err: unknown) {
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err
        ? String((err as { stderr?: string }).stderr ?? '')
        : '';
    return parseFfmpegStderr(stderr);
  }
}

async function extractThumbnailWithFfmpeg(videoPath: string, outputPath: string): Promise<boolean> {
  try {
    ensureDir(path.dirname(outputPath));
    await execFileAsync(
      'ffmpeg',
      ['-y', '-ss', '0.50', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', outputPath],
      { timeout: 20000 }
    );
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function applyStage2Migrations(db: Database.Database): void {
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );
  const migrations: Array<[string, string, string]> = [
    ['cameras', 'last_error', 'TEXT'],
    ['cameras', 'reconnect_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['cameras', 'max_reconnect_attempts', 'INTEGER NOT NULL DEFAULT 5'],
    ['cameras', 'target_fps', 'REAL NOT NULL DEFAULT 5.0'],
    ['cameras', 'target_resolution', "TEXT NOT NULL DEFAULT '1280x720'"],
    ['cameras', 'recording_schedule', 'TEXT'],
    ['cameras', 'ip_address', 'TEXT'],
    ['cameras', 'rtsp_port', 'INTEGER NOT NULL DEFAULT 554'],
    ['cameras', 'onvif_port', 'INTEGER NOT NULL DEFAULT 80'],
    ['cameras', 'username', 'TEXT'],
    ['cameras', 'credential_ref', 'TEXT'],
    ['cameras', 'rtsp_transport', "TEXT NOT NULL DEFAULT 'tcp'"],
    ['cameras', 'stream_profile', "TEXT NOT NULL DEFAULT 'main'"],
    ['cameras', 'main_stream_uri', 'TEXT'],
    ['cameras', 'sub_stream_uri', 'TEXT'],
    ['cameras', 'connection_timeout_sec', 'REAL NOT NULL DEFAULT 6.0'],
    ['cameras', 'nvr_id', 'TEXT'],
    ['cameras', 'channel_number', 'INTEGER'],
    ['cameras', 'device_manufacturer', 'TEXT'],
    ['cameras', 'device_model', 'TEXT'],
    ['cameras', 'firmware_version', 'TEXT'],
    ['cameras', 'verification_stages_json', 'TEXT'],
    ['camera_stream_sessions', 'frames_dropped', 'INTEGER NOT NULL DEFAULT 0'],
    ['camera_stream_sessions', 'bytes_received', 'INTEGER NOT NULL DEFAULT 0'],
    ['camera_stream_sessions', 'avg_frame_ms', 'REAL'],
    ['video_files', 'recording_session_id', 'TEXT'],
    ['video_files', 'source_origin', "TEXT NOT NULL DEFAULT 'imported'"],
    ['video_files', 'expires_at', 'TEXT'],
    ['person_events', 'anonymous_track_id', 'TEXT REFERENCES anonymous_tracks(id) ON DELETE SET NULL'],
    ['person_events', 'end_timestamp_sec', 'REAL'],
    ['person_events', 'frame_count', 'INTEGER NOT NULL DEFAULT 1'],
    ['person_events', 'bbox_json', 'TEXT'],
    ['person_events', 'model_name', 'TEXT'],
    ['person_events', 'reviewed_by', 'TEXT'],
    ['person_events', 'reviewed_at', 'TEXT'],
  ];

  for (const [table, col, def] of migrations) {
    if (!existingTables.has(table)) continue;
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
    );
    if (!cols.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`);
    }
  }
}

function seedDefaultSettings(db: Database.Database, storageDir: string, thumbnailDir: string): void {
  const now = utcNowIso();
  const defaults: Array<[string, string, string, string]> = [
    ['storage_directory', storageDir, 'storage', 'Local root directory for imported and recorded CCTV video assets'],
    ['thumbnail_directory', thumbnailDir, 'storage', 'Local directory for extracted video poster frames and event thumbnails'],
    ['max_storage_quota_gb', '250', 'storage', 'Maximum soft storage allocation quota in gigabytes'],
    ['default_retention_days', '30', 'privacy', 'Default retention period for imported/recorded video footage and anonymous events'],
    ['privacy_blur_default', 'true', 'privacy', 'Mask unidentified subjects by default during video preview, thumbnails, and exports'],
    ['privacy_mask_mode', 'blur', 'privacy', 'Privacy masking filter style (blur or pixelate)'],
    ['detection_confidence_threshold', '0.45', 'ai', 'Minimum confidence score for OpenCV person detection events'],
    ['detection_sample_fps', '2.0', 'ai', 'Target frames per second sampled during video person detection'],
    ['max_concurrent_streams', '8', 'streaming', 'Maximum simultaneous active camera live preview workers'],
    ['max_concurrent_recordings', '8', 'streaming', 'Maximum simultaneous active camera MP4 recording workers'],
    ['require_consent_for_profiles', 'true', 'privacy', 'Require explicit consent verification before marking registered profiles authorized'],
    ['log_level', process.env.LUMAFLUX_LOG_LEVEL || 'INFO', 'system', 'Backend structured logging verbosity level'],
    ['theme', 'dark', 'appearance', 'Default workspace interface theme (dark or light)'],
    ['database_engine', 'SQLite 3 (PostgreSQL migration ready)', 'system', 'Active local metadata database engine'],
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, category, description, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const row of defaults) {
      stmt.run(...row, now);
    }
  });
  tx();
}

export async function createLumaFluxApp(options: ServerOptions = {}) {
  const defaultStorageRoot = path.resolve(__dirname, 'storage');
  const dbPath = path.resolve(options.dbPath || process.env.LUMAFLUX_DB_PATH || path.join(defaultStorageRoot, 'lumaflux.db'));
  const storageDir = path.resolve(options.storageDir || process.env.LUMAFLUX_STORAGE_DIR || path.join(defaultStorageRoot, 'videos'));
  const thumbnailDir = path.resolve(options.thumbnailDir || process.env.LUMAFLUX_THUMBNAIL_DIR || path.join(defaultStorageRoot, 'thumbnails'));
  const logDir = path.resolve(options.logDir || process.env.LUMAFLUX_LOG_DIR || path.join(defaultStorageRoot, 'logs'));

  ensureDir(path.dirname(dbPath));
  ensureDir(storageDir);
  ensureDir(thumbnailDir);
  ensureDir(logDir);

  const logFilePath = path.join(logDir, 'lumaflux-runtime.log');
  const writeRuntimeLog = (level: string, message: string) => {
    const line = `${utcNowIso()} | ${level.padEnd(5)} | ${sanitizeLogText(message)}\n`;
    try {
      fs.appendFileSync(logFilePath, line, 'utf8');
    } catch {
      // Non-fatal file logging fallback
    }
  };

  const schemaPath = path.resolve(__dirname, 'database', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  applyStage2Migrations(db);
  db.exec(schemaSql);
  seedDefaultSettings(db, storageDir, thumbnailDir);
  const vault = new CredentialVault(process.env.LUMAFLUX_VAULT_DIR || path.dirname(dbPath));

  const writeAuditLog = (params: {
    actor?: string;
    actorRole?: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    details: string;
    outcome?: 'success' | 'denied' | 'error';
    sourceIp?: string;
  }): AuditLogRecord => {
    const id = crypto.randomUUID();
    const createdAt = utcNowIso();
    db.prepare(`
      INSERT INTO audit_logs (id, actor, actor_role, action, resource_type, resource_id, details, outcome, source_ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.actor ?? 'Local Administrator',
      params.actorRole ?? 'admin',
      params.action,
      params.resourceType,
      params.resourceId ?? null,
      params.details,
      params.outcome ?? 'success',
      params.sourceIp ?? '127.0.0.1',
      createdAt
    );
    return db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(id) as AuditLogRecord;
  };

  const getSettingsMap = (): AppSettingsMap => {
    const rows = db.prepare('SELECT key, value FROM app_settings ORDER BY key').all() as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return map as AppSettingsMap;
  };

  const getConfiguredDirectories = () => {
    const settings = getSettingsMap();
    const activeStorage = path.resolve(settings.storage_directory || storageDir);
    const activeThumb = path.resolve(settings.thumbnail_directory || thumbnailDir);
    ensureDir(activeStorage);
    ensureDir(activeThumb);
    return { activeStorage, activeThumb, settings };
  };

  writeRuntimeLog('INFO', `LumaFlux Intelligence database initialized at ${dbPath}`);
  writeAuditLog({
    actor: 'System',
    actorRole: 'system',
    action: 'APPLICATION_STARTED',
    resourceType: 'system',
    details: 'LumaFlux Intelligence backend runtime initialized with SQLite WAL persistence.',
  });

  const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.ts']);
  const ALLOWED_SETTING_KEYS = new Set([
    'storage_directory',
    'thumbnail_directory',
    'max_storage_quota_gb',
    'default_retention_days',
    'privacy_blur_default',
    'privacy_mask_mode',
    'detection_confidence_threshold',
    'detection_sample_fps',
    'max_concurrent_streams',
    'max_concurrent_recordings',
    'require_consent_for_profiles',
    'log_level',
    'theme',
  ]);

  const expectedApiToken = (options.apiToken ?? process.env.LUMAFLUX_API_TOKEN ?? '').trim();

  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '4mb' }));

  app.use('/api', (req, res, next) => {
    if (!expectedApiToken || req.method === 'OPTIONS' || req.path === '/health') {
      next();
      return;
    }
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const candidate = bearer || queryToken;

    const a = Buffer.from(expectedApiToken, 'utf8');
    const b = Buffer.from(candidate, 'utf8');
    const authorized = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!authorized) {
      writeAuditLog({
        actor: 'Unknown Local Caller',
        actorRole: 'unauthenticated',
        action: 'UNAUTHORIZED_API_ACCESS',
        resourceType: 'api',
        details: `Rejected unauthorized request to /api${req.path}`,
        outcome: 'denied',
      });
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or invalid desktop IPC token.' });
      return;
    }
    next();
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const { activeStorage } = getConfiguredDirectories();
        cb(null, activeStorage);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const mimeOk = !file.mimetype || file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream';
      if (!ALLOWED_VIDEO_EXTENSIONS.has(ext) || !mimeOk) {
        const err = new Error(
          `Unsupported video format '${ext || file.mimetype}'. Allowed extensions: ${Array.from(ALLOWED_VIDEO_EXTENSIONS).join(', ')}.`
        );
        (err as Error & { statusCode?: number; code?: string }).statusCode = 400;
        (err as Error & { statusCode?: number; code?: string }).code = 'INVALID_FILE_TYPE';
        cb(err);
        return;
      }
      cb(null, true);
    },
    limits: {
      fileSize: 1024 * 1024 * 1024, // 1 GB per video file upload in Stage 1
    },
  });

  const ffmpegAvailable = await checkFfmpegAvailable();
  const opencvStatus = await checkOpenCvStatus();
  const streamManager = new LiveStreamAndRecordingManager({
    db,
    ffmpegAvailable,
    probeVideoFn: probeVideoWithFfmpeg,
    extractThumbFn: extractThumbnailWithFfmpeg,
  });
  const recoveredCount = await streamManager.recoverInterruptedRecordings(getConfiguredDirectories().activeThumb);
  if (recoveredCount > 0) {
    writeAuditLog({
      actor: 'System',
      actorRole: 'system',
      action: 'RECORDINGS_RECOVERED',
      resourceType: 'recording_session',
      details: `Safely recovered ${recoveredCount} interrupted recording(s) on startup.`,
    });
  }

  const getAiEngines = (): AiEngineDescriptor[] => [
    {
      id: 'ffmpeg-media-inspector',
      name: 'FFmpeg Media & Frame Inspector',
      stage: 'Stage 1 (Active)',
      status: ffmpegAvailable ? 'ready' : 'missing_dependency',
      description:
        'Extracts container codec, resolution, frame rate, duration, and poster frames from imported CCTV video files.',
      privacy_guardrail: 'Operates strictly on local storage paths; zero outbound network transfer.',
    },
    {
      id: 'opencv-person-detector',
      name: 'OpenCV HOG Person Detector',
      stage: opencvStatus.available
        ? `Stage 2 (Vision · OpenCV ${opencvStatus.version})`
        : 'Stage 2 (Requires opencv-python)',
      status: opencvStatus.available ? 'ready' : 'missing_dependency',
      description:
        'Detects anonymized upright person bounding boxes, confidence scores, and session-scoped tracks using OpenCV HOG+SVM.',
      privacy_guardrail: 'Generates anonymized spatial events only; facial recognition and cross-camera matching remain disabled.',
    },
    {
      id: 'opencv-motion-detector',
      name: 'OpenCV MOG2 Silhouette Detector',
      stage: opencvStatus.available
        ? `Stage 2 (Vision · OpenCV ${opencvStatus.version})`
        : 'Stage 2 (Requires opencv-python)',
      status: opencvStatus.available ? 'ready' : 'missing_dependency',
      description:
        'Detects moving upright foreground regions using OpenCV MOG2 background subtraction.',
      privacy_guardrail: 'Non-biometric contour envelopes only; strictly camera-local.',
    },
    {
      id: 'privacy-redaction-filter',
      name: 'Privacy Masking & Blur Pipeline',
      stage: ffmpegAvailable || opencvStatus.available ? 'Stage 2 (Active)' : 'Stage 2 (Requires FFmpeg)',
      status: ffmpegAvailable || opencvStatus.available ? 'ready' : 'missing_dependency',
      description:
        'Applies configurable Gaussian blur or pixelation masks to detected bounding boxes or scenes during video export.',
      privacy_guardrail: 'Default-on privacy masking enforced by local privacy settings.',
    },
    {
      id: 'biometric-matching-guard',
      name: 'Biometric Identification Module',
      stage: 'Policy Restricted',
      status: 'disabled_by_policy',
      description: 'Biometric identification and facial recognition are intentionally disabled by LumaFlux privacy policy.',
      privacy_guardrail: 'Hard-disabled to enforce privacy, consent, and access governance.',
    },
  ];

  // Health & system capabilities
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      app_name: 'LumaFlux Intelligence',
      version: '0.2.0',
      database_dialect: 'sqlite',
      ffmpeg_available: ffmpegAvailable,
      opencv_available: opencvStatus.available,
      biometric_identification_enabled: false,
      engines: getAiEngines(),
    });
  });

  // Dashboard real DB aggregation
  app.get('/api/dashboard/summary', (_req, res) => {
    const { activeStorage, activeThumb, settings } = getConfiguredDirectories();
    const quotaGb = Number(settings.max_storage_quota_gb || '250') || 250;
    const videoBytes = computeDirectoryBytes(activeStorage);
    const thumbBytes = computeDirectoryBytes(activeThumb);
    const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    let diskFreeBytes: number | null = null;
    let diskTotalBytes: number | null = null;
    try {
      const stats = fs.statfsSync(activeStorage);
      diskFreeBytes = stats.bavail * stats.bsize;
      diskTotalBytes = stats.blocks * stats.bsize;
    } catch {
      // Fallback if statfsSync unavailable
    }

    const totalVideos = (db.prepare('SELECT COUNT(*) AS c FROM video_files').get() as { c: number }).c;
    const connectedCameras = (
      db.prepare("SELECT COUNT(*) AS c FROM cameras WHERE enabled = 1 AND status = 'online'").get() as { c: number }
    ).c;
    const totalCameras = (db.prepare('SELECT COUNT(*) AS c FROM cameras').get() as { c: number }).c;
    const detectedEvents = (db.prepare('SELECT COUNT(*) AS c FROM person_events').get() as { c: number }).c;
    const anonymousProfiles = (
      db.prepare("SELECT COUNT(*) AS c FROM person_profiles WHERE category = 'anonymous'").get() as { c: number }
    ).c;
    const authorizedProfiles = (
      db.prepare("SELECT COUNT(*) AS c FROM person_profiles WHERE category = 'authorized'").get() as { c: number }
    ).c;
    const pendingReviews = (
      db
        .prepare("SELECT COUNT(*) AS c FROM watchlist_reviews WHERE status IN ('pending', 'in_review', 'escalated')")
        .get() as { c: number }
    ).c;

    const statusRows = db
      .prepare('SELECT processing_status, COUNT(*) AS c FROM video_files GROUP BY processing_status')
      .all() as Array<{ processing_status: string; c: number }>;

    const statusCounts = { imported: 0, queued: 0, inspecting: 0, ready: 0, failed: 0 };
    for (const row of statusRows) {
      if (row.processing_status in statusCounts) {
        statusCounts[row.processing_status as keyof typeof statusCounts] = row.c;
      }
    }

    const recentJobs = db
      .prepare(
        `
        SELECT j.*, v.original_name AS video_name
        FROM processing_jobs j
        LEFT JOIN video_files v ON j.video_file_id = v.id
        ORDER BY j.created_at DESC
        LIMIT 10
      `
      )
      .all() as ProcessingJobRecord[];

    const recentActivity = db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 12')
      .all() as AuditLogRecord[];

    const activeStreams = (
      db.prepare("SELECT COUNT(*) AS c FROM camera_stream_sessions WHERE status IN ('starting','streaming','reconnecting')").get() as {
        c: number;
      }
    ).c;
    const activeRecordings = (
      db.prepare("SELECT COUNT(*) AS c FROM recording_sessions WHERE status = 'recording'").get() as { c: number }
    ).c;
    const anonymousTracksCount = (
      db.prepare("SELECT COUNT(*) AS c FROM anonymous_tracks WHERE status != 'purged'").get() as { c: number }
    ).c;

    const payload: DashboardSummary = {
      total_imported_videos: totalVideos,
      connected_cameras: connectedCameras,
      total_cameras: totalCameras,
      active_streams: activeStreams,
      active_recordings: activeRecordings,
      detected_person_events: detectedEvents,
      anonymous_tracks_count: anonymousTracksCount,
      anonymous_person_profiles: anonymousProfiles,
      authorized_registered_profiles: authorizedProfiles,
      pending_security_reviews: pendingReviews,
      storage_usage: {
        storage_directory: activeStorage,
        video_bytes_used: videoBytes,
        thumbnail_bytes_used: thumbBytes,
        database_bytes_used: dbBytes,
        total_app_bytes_used: videoBytes + thumbBytes + dbBytes,
        quota_bytes: Math.round(quotaGb * 1024 * 1024 * 1024),
        disk_free_bytes: diskFreeBytes,
        disk_total_bytes: diskTotalBytes,
      },
      recent_activity: recentActivity,
      video_processing_status: {
        ...statusCounts,
        recent_jobs: recentJobs,
      },
      system_capabilities: {
        database_engine: settings.database_engine || 'SQLite 3',
        ffmpeg_available: ffmpegAvailable,
        opencv_available: opencvStatus.available,
        ai_stage: 'Stage 3 Vision & Hardware Integration',
        biometric_identification_enabled: false,
        runtime_mode: 'node-sqlite-gateway',
      },
    };

    res.json(payload);
  });

  type RawCameraRow = Omit<CameraRecord, 'enabled' | 'verification_stages' | 'has_credentials'> & {
    enabled: number;
    credential_ref?: string | null;
    verification_stages_json?: string | null;
  };

  const formatCameraRow = (row: RawCameraRow): CameraRecord => {
    const { credential_ref, verification_stages_json, ...rest } = row;
    const masked = redactStreamUri(rest.stream_uri);
    const activeStream = db
      .prepare("SELECT id FROM camera_stream_sessions WHERE camera_id = ? AND status IN ('starting','streaming','reconnecting') ORDER BY started_at DESC LIMIT 1")
      .get(rest.id) as { id: string } | undefined;
    const activeRec = db
      .prepare("SELECT id FROM recording_sessions WHERE camera_id = ? AND status = 'recording' ORDER BY started_at DESC LIMIT 1")
      .get(rest.id) as { id: string } | undefined;
    let verificationStages = null;
    if (verification_stages_json) {
      try {
        verificationStages = JSON.parse(verification_stages_json);
      } catch {
        verificationStages = null;
      }
    }
    return {
      ...rest,
      stream_uri: masked,
      stream_uri_masked: masked,
      main_stream_uri: rest.main_stream_uri ? redactStreamUri(rest.main_stream_uri) : null,
      sub_stream_uri: rest.sub_stream_uri ? redactStreamUri(rest.sub_stream_uri) : null,
      has_credentials: Boolean(credential_ref && vault.hasSecret(credential_ref)),
      verification_stages: verificationStages,
      enabled: Boolean(rest.enabled),
      active_stream_id: activeStream?.id ?? null,
      active_recording_id: activeRec?.id ?? null,
    };
  };

  const resolveCameraRuntime = (cameraId: string) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId) as RawCameraRow | undefined;
    if (!cam) return null;
    const password = vault.getSecret(cam.credential_ref);
    const rtspTransport: RtspTransport = cam.rtsp_transport === 'udp' ? 'udp' : 'tcp';
    const streamProfile: StreamProfileType = cam.stream_profile === 'sub' ? 'sub' : 'main';
    const runtimeUri = buildEffectiveCameraUri({
      sourceType: cam.source_type,
      streamUri: cam.stream_uri,
      mainStreamUri: cam.main_stream_uri,
      subStreamUri: cam.sub_stream_uri,
      streamProfile,
      username: cam.username,
      password,
    });
    return { cam, runtimeUri, rtspTransport, streamProfile, password };
  };

  const runProbeForCamera = async (cam: RawCameraRow) => {
    const password = vault.getSecret(cam.credential_ref);
    const rtspTransport: RtspTransport = cam.rtsp_transport === 'udp' ? 'udp' : 'tcp';
    const streamProfile: StreamProfileType = cam.stream_profile === 'sub' ? 'sub' : 'main';
    const probe = await probeCameraConnection(cam.source_type, cam.stream_uri, {
      rtspTransport,
      username: cam.username,
      password,
      streamProfile,
      mainStreamUri: cam.main_stream_uri,
      subStreamUri: cam.sub_stream_uri,
      timeoutSec: cam.connection_timeout_sec ?? 6,
    });
    const detailMsg = sanitizeLogText(probe.message, cam.stream_uri, password);
    const lastError = probe.reachable ? null : detailMsg;
    const now = utcNowIso();
    const stagesJson = probe.stages ? JSON.stringify(probe.stages) : cam.verification_stages_json ?? null;

    db.prepare(
      `
      UPDATE cameras
      SET status = ?, last_checked_at = ?, last_error = ?,
          device_manufacturer = COALESCE(?, device_manufacturer),
          device_model = COALESCE(?, device_model),
          firmware_version = COALESCE(?, firmware_version),
          main_stream_uri = COALESCE(?, main_stream_uri),
          sub_stream_uri = COALESCE(?, sub_stream_uri),
          verification_stages_json = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(
      probe.status,
      now,
      lastError,
      probe.manufacturer ?? null,
      probe.model ?? null,
      probe.firmwareVersion ?? null,
      probe.mainStreamUri ?? null,
      probe.subStreamUri ?? null,
      stagesJson,
      now,
      cam.id
    );

    const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cam.id) as RawCameraRow;
    return { probe, detailMsg, updated };
  };

  const createCameraRecord = (body: Record<string, unknown>): CameraRecord => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const locationZone = typeof body.location_zone === 'string' ? body.location_zone.trim() : '';
    const validSource = ['rtsp', 'onvif', 'http', 'local_archive'].includes(String(body.source_type || ''))
      ? (String(body.source_type) as RawCameraRow['source_type'])
      : 'rtsp';
    const ipAddressRaw = typeof body.ip_address === 'string' ? body.ip_address.trim() : '';
    const rtspPort = Math.min(Math.max(Number(body.rtsp_port ?? 554) || 554, 1), 65535);
    const onvifPort = Math.min(Math.max(Number(body.onvif_port ?? 80) || 80, 1), 65535);
    const rtspTransport: RtspTransport = String(body.rtsp_transport || '').toLowerCase() === 'udp' ? 'udp' : 'tcp';
    const streamProfile: StreamProfileType = String(body.stream_profile || '').toLowerCase() === 'sub' ? 'sub' : 'main';
    const timeoutSec = Math.min(Math.max(Number(body.connection_timeout_sec ?? 6) || 6, 1.5), 30);

    let rawUri = typeof body.stream_uri === 'string' ? body.stream_uri.trim() : '';
    if (!rawUri && ipAddressRaw) {
      if (validSource === 'onvif') {
        rawUri = `http://${ipAddressRaw}:${onvifPort}/onvif/device_service`;
      } else if (validSource === 'rtsp') {
        rawUri = `rtsp://${ipAddressRaw}:${rtspPort}/stream1`;
      } else if (validSource === 'http') {
        rawUri = `http://${ipAddressRaw}:${onvifPort}/video`;
      }
    }
    if (!name || !locationZone || !rawUri) {
      const err = new Error('Name, location zone, and stream URI (or IP address) are required.');
      (err as Error & { statusCode?: number; code?: string }).statusCode = 400;
      (err as Error & { statusCode?: number; code?: string }).code = 'VALIDATION_ERROR';
      throw err;
    }

    const strippedUri = validSource === 'local_archive' ? { cleanUri: rawUri, username: null, password: null } : stripUriCredentials(rawUri);
    const rawMain = typeof body.main_stream_uri === 'string' && body.main_stream_uri.trim() ? body.main_stream_uri.trim() : null;
    const rawSub = typeof body.sub_stream_uri === 'string' && body.sub_stream_uri.trim() ? body.sub_stream_uri.trim() : null;
    const strippedMain = rawMain ? stripUriCredentials(rawMain) : { cleanUri: null, username: null, password: null };
    const strippedSub = rawSub ? stripUriCredentials(rawSub) : { cleanUri: null, username: null, password: null };

    let ipAddress: string | null = ipAddressRaw || null;
    if (!ipAddress && validSource !== 'local_archive') {
      try {
        const parsed = new URL(strippedUri.cleanUri);
        if (parsed.hostname) ipAddress = parsed.hostname;
      } catch {
        // Ignore non-URL local path
      }
    }

    const username =
      (typeof body.username === 'string' && body.username.trim() ? body.username.trim() : null) ||
      strippedUri.username ||
      strippedMain.username ||
      strippedSub.username ||
      null;
    const rawPassword =
      typeof body.password === 'string' && body.password.length > 0
        ? body.password
        : strippedUri.password || strippedMain.password || strippedSub.password || null;

    const id = crypto.randomUUID();
    let credRef: string | null = null;
    if (rawPassword) {
      credRef = `cam:${id}`;
      vault.setSecret(credRef, rawPassword);
    }

    const now = utcNowIso();
    const validMode = ['manual', 'scheduled', 'motion_trigger', 'continuous'].includes(String(body.recording_mode || ''))
      ? String(body.recording_mode)
      : 'manual';
    const retention = Math.min(Math.max(Number(body.retention_days) || 30, 1), 3650);
    const maxReconnect = Math.min(Math.max(Number(body.max_reconnect_attempts ?? 5), 0), 50);
    const fps = Math.min(Math.max(Number(body.target_fps ?? 5), 0.5), 30);
    const resolution =
      typeof body.target_resolution === 'string' && body.target_resolution.trim()
        ? body.target_resolution.trim()
        : '1280x720';
    const schedule = typeof body.recording_schedule === 'string' && body.recording_schedule.trim() ? body.recording_schedule.trim() : null;
    const nvrId = typeof body.nvr_id === 'string' && body.nvr_id.trim() ? body.nvr_id.trim() : null;
    const channelNumber = typeof body.channel_number === 'number' ? body.channel_number : null;

    db.prepare(
      `
      INSERT INTO cameras
        (id, name, location_zone, source_type, stream_uri, ip_address, rtsp_port, onvif_port,
         username, credential_ref, rtsp_transport, stream_profile, main_stream_uri, sub_stream_uri,
         connection_timeout_sec, nvr_id, channel_number, status, enabled, retention_days, recording_mode,
         max_reconnect_attempts, target_fps, target_resolution, recording_schedule, last_checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `
    ).run(
      id,
      name,
      locationZone,
      validSource,
      strippedUri.cleanUri,
      ipAddress,
      rtspPort,
      onvifPort,
      username,
      credRef,
      rtspTransport,
      streamProfile,
      strippedMain.cleanUri,
      strippedSub.cleanUri,
      timeoutSec,
      nvrId,
      channelNumber,
      body.enabled === false ? 0 : 1,
      retention,
      validMode,
      maxReconnect,
      fps,
      resolution,
      schedule,
      now,
      now
    );

    const created = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id) as RawCameraRow;

    writeAuditLog({
      action: 'CAMERA_CREATED',
      resourceType: 'camera',
      resourceId: id,
      details: `Added camera '${created.name}' (${created.source_type}, ${redactStreamUri(strippedUri.cleanUri)}) in ${created.location_zone}`,
    });

    return formatCameraRow(created);
  };

  // Cameras CRUD + ONVIF Discovery + Real Connectivity Probe + Local Ingest
  app.get('/api/cameras', (_req, res) => {
    const rows = db.prepare('SELECT * FROM cameras ORDER BY created_at DESC').all() as RawCameraRow[];
    res.json(rows.map(formatCameraRow));
  });

  app.post('/api/cameras/discover', async (req, res) => {
    const body = req.body ?? {};
    const timeoutMs = Math.min(Math.max(Number(body.timeout_sec ?? 2.0) * 1000, 400), 6000);
    const targetHost = typeof body.target_host === 'string' && body.target_host.trim() ? body.target_host.trim() : undefined;
    const targetPort = typeof body.target_port === 'number' ? body.target_port : 3702;
    const devices = await discoverOnvifDevices({ timeoutMs, targetHost, targetPort });
    writeAuditLog({
      action: 'ONVIF_DISCOVERY_SCAN',
      resourceType: 'camera',
      details: `ONVIF WS-Discovery scan completed (${devices.length} device(s) responded)`,
    });
    res.json({ discovered_count: devices.length, devices });
  });

  app.post('/api/cameras', (req, res) => {
    try {
      const created = createCameraRecord(req.body ?? {});
      res.status(201).json(created);
    } catch (err) {
      const typed = err as { statusCode?: number; code?: string; message?: string };
      res.status(typed.statusCode || 400).json({
        error: typed.code || 'VALIDATION_ERROR',
        message: typed.message || 'Invalid camera configuration.',
      });
    }
  });

  app.patch('/api/cameras/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id) as RawCameraRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }

    const body = req.body ?? {};
    const now = utcNowIso();
    const nextEnabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : existing.enabled;
    const nextStatus = ['configured', 'online', 'offline', 'maintenance'].includes(body.status)
      ? body.status
      : existing.status;

    const incomingUri = typeof body.stream_uri === 'string' ? body.stream_uri.trim() : '';
    let uriUser: string | null = null;
    let uriPass: string | null = null;
    let nextUri = existing.stream_uri;
    if (incomingUri && incomingUri !== redactStreamUri(existing.stream_uri)) {
      if (existing.source_type === 'local_archive') {
        nextUri = incomingUri;
      } else {
        const s = stripUriCredentials(incomingUri);
        nextUri = s.cleanUri;
        uriUser = s.username;
        uriPass = s.password;
      }
    }

    let nextMain = existing.main_stream_uri ?? null;
    let mUser: string | null = null;
    let mPass: string | null = null;
    if ('main_stream_uri' in body) {
      const val = typeof body.main_stream_uri === 'string' ? body.main_stream_uri.trim() : '';
      if (val && val !== redactStreamUri(existing.main_stream_uri || '')) {
        const s = stripUriCredentials(val);
        nextMain = s.cleanUri;
        mUser = s.username;
        mPass = s.password;
      } else if (!val) {
        nextMain = null;
      }
    }

    let nextSub = existing.sub_stream_uri ?? null;
    let sUser: string | null = null;
    let sPass: string | null = null;
    if ('sub_stream_uri' in body) {
      const val = typeof body.sub_stream_uri === 'string' ? body.sub_stream_uri.trim() : '';
      if (val && val !== redactStreamUri(existing.sub_stream_uri || '')) {
        const s = stripUriCredentials(val);
        nextSub = s.cleanUri;
        sUser = s.username;
        sPass = s.password;
      } else if (!val) {
        nextSub = null;
      }
    }

    const nextUser =
      'username' in body
        ? typeof body.username === 'string' && body.username.trim()
          ? body.username.trim()
          : null
        : uriUser || mUser || sUser || existing.username || null;

    let nextCredRef = existing.credential_ref ?? null;
    if (body.clear_password) {
      vault.deleteSecret(nextCredRef);
      nextCredRef = null;
    } else {
      const incomingPass =
        typeof body.password === 'string' && body.password.length > 0
          ? body.password
          : uriPass || mPass || sPass;
      if (incomingPass) {
        nextCredRef = nextCredRef || `cam:${existing.id}`;
        vault.setSecret(nextCredRef, incomingPass);
      }
    }

    const nextIp =
      typeof body.ip_address === 'string' && body.ip_address.trim() ? body.ip_address.trim() : existing.ip_address ?? null;
    const nextRtspPort =
      body.rtsp_port !== undefined ? Math.min(Math.max(Number(body.rtsp_port) || 554, 1), 65535) : existing.rtsp_port ?? 554;
    const nextOnvifPort =
      body.onvif_port !== undefined ? Math.min(Math.max(Number(body.onvif_port) || 80, 1), 65535) : existing.onvif_port ?? 80;
    const nextTransport: RtspTransport =
      body.rtsp_transport !== undefined
        ? String(body.rtsp_transport).toLowerCase() === 'udp'
          ? 'udp'
          : 'tcp'
        : existing.rtsp_transport === 'udp'
          ? 'udp'
          : 'tcp';
    const nextProfile: StreamProfileType =
      body.stream_profile !== undefined
        ? String(body.stream_profile).toLowerCase() === 'sub'
          ? 'sub'
          : 'main'
        : existing.stream_profile === 'sub'
          ? 'sub'
          : 'main';
    const nextTimeout =
      body.connection_timeout_sec !== undefined
        ? Math.min(Math.max(Number(body.connection_timeout_sec) || 6, 1.5), 30)
        : existing.connection_timeout_sec ?? 6;

    const nextMaxReconnect =
      body.max_reconnect_attempts !== undefined
        ? Math.min(Math.max(Number(body.max_reconnect_attempts), 0), 50)
        : existing.max_reconnect_attempts ?? 5;
    const nextFps =
      body.target_fps !== undefined ? Math.min(Math.max(Number(body.target_fps), 0.5), 30) : existing.target_fps ?? 5;
    const nextRes =
      typeof body.target_resolution === 'string' && body.target_resolution.trim()
        ? body.target_resolution.trim()
        : existing.target_resolution || '1280x720';
    const nextSchedule =
      body.recording_schedule !== undefined ? (body.recording_schedule ? String(body.recording_schedule) : null) : existing.recording_schedule ?? null;

    db.prepare(
      `
      UPDATE cameras
      SET name = ?, location_zone = ?, stream_uri = ?, ip_address = ?, rtsp_port = ?, onvif_port = ?,
          username = ?, credential_ref = ?, rtsp_transport = ?, stream_profile = ?, main_stream_uri = ?,
          sub_stream_uri = ?, connection_timeout_sec = ?, status = ?, enabled = ?, retention_days = ?,
          recording_mode = ?, max_reconnect_attempts = ?, target_fps = ?, target_resolution = ?,
          recording_schedule = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(
      body.name ? String(body.name).trim() : existing.name,
      body.location_zone ? String(body.location_zone).trim() : existing.location_zone,
      nextUri,
      nextIp,
      nextRtspPort,
      nextOnvifPort,
      nextUser,
      nextCredRef,
      nextTransport,
      nextProfile,
      nextMain,
      nextSub,
      nextTimeout,
      nextStatus,
      nextEnabled,
      body.retention_days ? Math.min(Math.max(Number(body.retention_days), 1), 3650) : existing.retention_days,
      body.recording_mode || existing.recording_mode,
      nextMaxReconnect,
      nextFps,
      nextRes,
      nextSchedule,
      now,
      existing.id
    );

    const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(existing.id) as RawCameraRow;

    writeAuditLog({
      action: 'CAMERA_UPDATED',
      resourceType: 'camera',
      resourceId: existing.id,
      details: `Updated camera '${updated.name}' (status=${updated.status}, enabled=${Boolean(updated.enabled)})`,
    });

    res.json(formatCameraRow(updated));
  });

  app.post('/api/cameras/:id/check', async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id) as RawCameraRow | undefined;
    if (!cam) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }

    const { probe, detailMsg, updated } = await runProbeForCamera(cam);

    writeAuditLog({
      action: 'CAMERA_HEALTH_CHECKED',
      resourceType: 'camera',
      resourceId: cam.id,
      details: `${cam.name}: ${detailMsg}`,
      outcome: probe.reachable ? 'success' : 'error',
    });

    res.json({ camera: formatCameraRow(updated), message: detailMsg, probe });
  });

  app.post('/api/cameras/:id/reconnect', async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id) as RawCameraRow | undefined;
    if (!cam) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }

    if (streamManager.getStreamHandle(cam.id)) {
      streamManager.stopStream(cam.id);
    }

    const { probe, detailMsg, updated } = await runProbeForCamera(cam);
    let session = null;
    if (Boolean(updated.enabled) && probe.reachable) {
      const resolved = resolveCameraRuntime(cam.id);
      if (resolved) {
        try {
          session = streamManager.startStream({
            id: resolved.cam.id,
            name: resolved.cam.name,
            source_type: resolved.cam.source_type,
            stream_uri: resolved.runtimeUri,
            rtsp_transport: resolved.rtspTransport,
            target_fps: resolved.cam.target_fps,
            target_resolution: resolved.cam.target_resolution,
            max_reconnect_attempts: resolved.cam.max_reconnect_attempts,
          });
        } catch {
          // Non-fatal if stream capacity reached
        }
      }
    }

    writeAuditLog({
      action: 'CAMERA_MANUAL_RECONNECT',
      resourceType: 'camera',
      resourceId: cam.id,
      details: `Manual reconnect on '${cam.name}': ${detailMsg}`,
      outcome: probe.reachable ? 'success' : 'error',
    });

    res.json({
      camera: formatCameraRow(updated),
      message: detailMsg,
      probe,
      stream_restarted: Boolean(session),
      session,
    });
  });

  app.post('/api/cameras/:id/ingest-local', async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id) as RawCameraRow | undefined;
    if (!cam) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    if (cam.source_type !== 'local_archive') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Local ingestion requires source_type="local_archive".' });
      return;
    }

    const files = discoverLocalArchiveFiles(cam.stream_uri);
    if (files.length === 0) {
      res.status(404).json({ error: 'NO_FILES_FOUND', message: 'No supported local video files found at camera path.' });
      return;
    }

    const { activeStorage, activeThumb } = getConfiguredDirectories();
    const ingested: VideoFileRecord[] = [];

    for (const srcPath of files) {
      const meta = ffmpegAvailable
        ? await probeVideoWithFfmpeg(srcPath)
        : { durationSeconds: null, width: null, height: null, fps: null, codec: null };
      if (ffmpegAvailable && !meta.codec && !meta.width && meta.durationSeconds === null) {
        continue;
      }

      const videoId = crypto.randomUUID();
      const ext = path.extname(srcPath).toLowerCase() || '.mp4';
      const destName = `${videoId}${ext}`;
      const destPath = path.join(activeStorage, destName);
      fs.copyFileSync(srcPath, destPath);
      const stat = fs.statSync(destPath);
      const sha256 = await sha256File(destPath);
      const thumbPath = path.join(activeThumb, `${videoId}.jpg`);
      const thumbOk = ffmpegAvailable ? await extractThumbnailWithFfmpeg(destPath, thumbPath) : false;
      const now = utcNowIso();

      db.prepare(
        `
        INSERT INTO video_files
          (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
           duration_seconds, width, height, fps, codec, processing_status, error_message, source_origin, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, 'imported', ?)
      `
      ).run(
        videoId,
        cam.id,
        destName,
        path.basename(srcPath),
        destPath,
        thumbOk ? thumbPath : null,
        sha256,
        stat.size,
        meta.durationSeconds,
        meta.width,
        meta.height,
        meta.fps,
        meta.codec,
        now
      );

      const created = db
        .prepare(
          'SELECT v.*, c.name AS camera_name FROM video_files v LEFT JOIN cameras c ON v.camera_id = c.id WHERE v.id = ?'
        )
        .get(videoId) as VideoFileRecord;
      ingested.push(created);
    }

    writeAuditLog({
      action: 'CAMERA_LOCAL_INGESTED',
      resourceType: 'camera',
      resourceId: cam.id,
      details: `Ingested ${ingested.length} local video file(s) from '${cam.name}'`,
    });

    res.status(201).json({ ingested_count: ingested.length, videos: ingested });
  });

  // Live Streaming & Recording
  app.get('/api/streams', (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT s.*, c.name AS camera_name
        FROM camera_stream_sessions s
        LEFT JOIN cameras c ON s.camera_id = c.id
        ORDER BY s.started_at DESC
        LIMIT 50
      `
      )
      .all();
    res.json(rows);
  });

  app.post('/api/cameras/:id/stream/start', (req, res) => {
    const resolved = resolveCameraRuntime(req.params.id);
    if (!resolved) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    const { cam, runtimeUri, rtspTransport } = resolved;
    if (!cam.enabled) {
      res.status(409).json({ error: 'CAMERA_DISABLED', message: 'Enable camera before starting live stream.' });
      return;
    }
    try {
      const session = streamManager.startStream({
        id: cam.id,
        name: cam.name,
        source_type: cam.source_type,
        stream_uri: runtimeUri,
        rtsp_transport: rtspTransport,
        target_fps: cam.target_fps,
        target_resolution: cam.target_resolution,
        max_reconnect_attempts: cam.max_reconnect_attempts,
      });
      writeAuditLog({
        action: 'CAMERA_STREAM_STARTED',
        resourceType: 'camera_stream_session',
        resourceId: session.id,
        details: `Started live stream for '${cam.name}' (${redactStreamUri(cam.stream_uri)})`,
      });
      res.status(201).json(session);
    } catch (err) {
      res.status(400).json({
        error: 'STREAM_START_FAILED',
        message: err instanceof Error ? err.message : 'Unable to start live stream.',
      });
    }
  });

  app.post('/api/cameras/:id/stream/stop', (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id) as RawCameraRow | undefined;
    if (!cam) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    const stopped = streamManager.stopStream(cam.id);
    if (stopped) {
      writeAuditLog({
        action: 'CAMERA_STREAM_STOPPED',
        resourceType: 'camera_stream_session',
        resourceId: stopped.id,
        details: `Stopped live stream for '${cam.name}' (${stopped.frames_captured} frames captured)`,
      });
    }
    res.json({ stopped: Boolean(stopped), session: stopped });
  });

  app.get('/api/cameras/:id/snapshot', async (req, res) => {
    const handle = streamManager.getStreamHandle(req.params.id);
    let frame = handle?.latestFrame ?? null;
    if (!frame && (req.query.capture === '1' || req.query.capture === 'true')) {
      const resolved = resolveCameraRuntime(req.params.id);
      if (resolved) {
        frame = await streamManager.captureSingleSnapshot(
          resolved.cam.source_type,
          resolved.runtimeUri,
          resolved.rtspTransport
        );
      }
    }
    if (!frame) {
      res.status(404).json({ error: 'SNAPSHOT_UNAVAILABLE', message: 'No active stream frame captured yet.' });
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(frame);
  });

  app.get('/api/cameras/:id/stream/mjpeg', (req, res) => {
    const handle = streamManager.getStreamHandle(req.params.id);
    if (!handle) {
      res.status(404).json({ error: 'STREAM_NOT_ACTIVE', message: 'Camera live stream is not running.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=lumafluxframe',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'close',
      Pragma: 'no-cache',
    });

    const writeFrame = (frame: Buffer) => {
      if (res.writableEnded) return;
      res.write(`--lumafluxframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    };

    if (handle.latestFrame) {
      writeFrame(handle.latestFrame);
    }

    const onFrame = (frame: Buffer) => writeFrame(frame);
    const onClosed = () => {
      if (!res.writableEnded) res.end();
    };
    handle.emitter.on('frame', onFrame);
    handle.emitter.once('closed', onClosed);

    req.on('close', () => {
      handle.emitter.off('frame', onFrame);
      handle.emitter.off('closed', onClosed);
    });
  });

  app.get('/api/recordings', (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT r.*, c.name AS camera_name
        FROM recording_sessions r
        LEFT JOIN cameras c ON r.camera_id = c.id
        ORDER BY r.started_at DESC
        LIMIT 100
      `
      )
      .all();
    res.json(rows);
  });

  app.post('/api/cameras/:id/recording/start', (req, res) => {
    const resolved = resolveCameraRuntime(req.params.id);
    if (!resolved) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    const { cam, runtimeUri, rtspTransport } = resolved;
    if (!cam.enabled) {
      res.status(409).json({ error: 'CAMERA_DISABLED', message: 'Enable camera before starting recording.' });
      return;
    }
    const triggerMode = ['manual', 'scheduled', 'continuous'].includes(req.body?.trigger_mode)
      ? req.body.trigger_mode
      : 'manual';
    try {
      const { activeStorage } = getConfiguredDirectories();
      const recSession = streamManager.startRecording(
        {
          id: cam.id,
          name: cam.name,
          source_type: cam.source_type,
          stream_uri: runtimeUri,
          rtsp_transport: rtspTransport,
        },
        activeStorage,
        triggerMode
      );
      writeAuditLog({
        action: 'CAMERA_RECORDING_STARTED',
        resourceType: 'recording_session',
        resourceId: (recSession as { id: string }).id,
        details: `Started ${triggerMode} recording for '${cam.name}'`,
      });
      res.status(201).json(recSession);
    } catch (err) {
      res.status(400).json({
        error: 'RECORDING_START_FAILED',
        message: err instanceof Error ? err.message : 'Failed to start recording.',
      });
    }
  });

  app.post('/api/cameras/:id/recording/stop', async (req, res) => {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id) as RawCameraRow | undefined;
    if (!cam) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    const { activeThumb } = getConfiguredDirectories();
    const rec = await streamManager.stopRecording(cam.id, activeThumb, cam.retention_days);
    if (!rec) {
      res.status(404).json({ error: 'RECORDING_NOT_ACTIVE', message: 'No active recording session for this camera.' });
      return;
    }
    const recTyped = rec as { id: string; status: string; file_size_bytes: number; video_file_id: string | null };
    writeAuditLog({
      action: 'CAMERA_RECORDING_STOPPED',
      resourceType: 'recording_session',
      resourceId: recTyped.id,
      details: `Stopped recording for '${cam.name}' (status=${recTyped.status}, bytes=${recTyped.file_size_bytes})`,
      outcome: recTyped.status === 'failed' ? 'error' : 'success',
    });
    res.json(rec);
  });

  app.post('/api/cameras/:id/schedule/evaluate', async (req, res) => {
    const resolved = resolveCameraRuntime(req.params.id);
    if (!resolved) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    const { cam, runtimeUri, rtspTransport } = resolved;
    const active = Boolean(cam.enabled) && cam.recording_mode === 'scheduled' && streamManager.isScheduleActive(cam.recording_schedule);
    const { activeStorage, activeThumb } = getConfiguredDirectories();
    const currentlyRecording = Boolean(
      db.prepare("SELECT id FROM recording_sessions WHERE camera_id = ? AND status = 'recording'").get(cam.id)
    );
    let actionTaken = 'none';
    if (active && !currentlyRecording) {
      streamManager.startRecording(
        {
          id: cam.id,
          name: cam.name,
          source_type: cam.source_type,
          stream_uri: runtimeUri,
          rtsp_transport: rtspTransport,
        },
        activeStorage,
        'scheduled'
      );
      actionTaken = 'started_scheduled_recording';
    } else if (!active && currentlyRecording) {
      await streamManager.stopRecording(cam.id, activeThumb, cam.retention_days);
      actionTaken = 'stopped_scheduled_recording';
    }
    res.json({ camera_id: cam.id, schedule_active: active, action_taken: actionTaken });
  });

  app.delete('/api/cameras/:id', async (req, res) => {
    const cam = db.prepare('SELECT name, credential_ref FROM cameras WHERE id = ?').get(req.params.id) as
      | { name: string; credential_ref: string | null }
      | undefined;
    if (!cam) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Camera not found.' });
      return;
    }
    const { activeThumb } = getConfiguredDirectories();
    await streamManager.stopRecording(req.params.id, activeThumb);
    streamManager.stopStream(req.params.id);
    db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);
    vault.deleteSecret(cam.credential_ref);
    writeAuditLog({
      action: 'CAMERA_DELETED',
      resourceType: 'camera',
      resourceId: req.params.id,
      details: `Removed camera '${cam.name}'`,
    });
    res.json({ deleted: true, id: req.params.id });
  });

  // Vendor-neutral NVR & Multi-Channel Management
  type RawNvrRow = Omit<NvrRecord, 'has_credentials'> & { credential_ref: string | null };
  type RawNvrChannelRow = Omit<NvrChannelRecord, 'enabled'> & { enabled: number };

  const formatNvrRow = (row: RawNvrRow): NvrRecord => {
    const { credential_ref, ...rest } = row;
    return {
      ...rest,
      rtsp_url_template: rest.rtsp_url_template ? redactStreamUri(rest.rtsp_url_template) : null,
      has_credentials: Boolean(credential_ref && vault.hasSecret(credential_ref)),
    };
  };

  const formatNvrChannelRow = (row: RawNvrChannelRow): NvrChannelRecord => ({
    ...row,
    enabled: Boolean(row.enabled),
    main_stream_uri: redactStreamUri(row.main_stream_uri),
    sub_stream_uri: row.sub_stream_uri ? redactStreamUri(row.sub_stream_uri) : null,
  });

  app.get('/api/nvrs', (_req, res) => {
    const rows = db.prepare('SELECT * FROM nvrs ORDER BY created_at DESC').all() as RawNvrRow[];
    res.json(rows.map(formatNvrRow));
  });

  app.post('/api/nvrs', (req, res) => {
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    if (!name || !host) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'NVR name and host IP/hostname are required.' });
      return;
    }
    const adapterType = body.adapter_type === 'generic_rtsp_channels' ? 'generic_rtsp_channels' : 'standard_onvif_rtsp';
    const port = Math.min(Math.max(Number(body.port ?? 80) || 80, 1), 65535);
    const rtspPort = Math.min(Math.max(Number(body.rtsp_port ?? 554) || 554, 1), 65535);
    const rtspTransport: RtspTransport = String(body.rtsp_transport || '').toLowerCase() === 'udp' ? 'udp' : 'tcp';
    const channelCount = Math.min(Math.max(Number(body.channel_count ?? 0) || 0, 0), 64);

    const rawTmpl = typeof body.rtsp_url_template === 'string' && body.rtsp_url_template.trim() ? body.rtsp_url_template.trim() : null;
    const strippedTmpl = rawTmpl ? stripUriCredentials(rawTmpl) : { cleanUri: null, username: null, password: null };
    const username =
      (typeof body.username === 'string' && body.username.trim() ? body.username.trim() : null) ||
      strippedTmpl.username ||
      null;
    const rawPassword =
      typeof body.password === 'string' && body.password.length > 0 ? body.password : strippedTmpl.password || null;

    const id = crypto.randomUUID();
    let credRef: string | null = null;
    if (rawPassword) {
      credRef = `nvr:${id}`;
      vault.setSecret(credRef, rawPassword);
    }

    const now = utcNowIso();
    db.prepare(
      `
      INSERT INTO nvrs
        (id, name, adapter_type, host, port, rtsp_port, username, credential_ref, rtsp_transport,
         rtsp_url_template, channel_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?)
    `
    ).run(
      id,
      name,
      adapterType,
      host,
      port,
      rtspPort,
      username,
      credRef,
      rtspTransport,
      strippedTmpl.cleanUri,
      channelCount,
      now,
      now
    );

    const created = db.prepare('SELECT * FROM nvrs WHERE id = ?').get(id) as RawNvrRow;
    writeAuditLog({
      action: 'NVR_CREATED',
      resourceType: 'nvr',
      resourceId: id,
      details: `Configured NVR '${name}' (${adapterType}, ${host}:${port})`,
    });
    res.status(201).json(formatNvrRow(created));
  });

  app.delete('/api/nvrs/:id', (req, res) => {
    const existing = db.prepare('SELECT name, credential_ref FROM nvrs WHERE id = ?').get(req.params.id) as
      | { name: string; credential_ref: string | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'NVR not found.' });
      return;
    }
    db.prepare('DELETE FROM nvrs WHERE id = ?').run(req.params.id);
    vault.deleteSecret(existing.credential_ref);
    writeAuditLog({
      action: 'NVR_DELETED',
      resourceType: 'nvr',
      resourceId: req.params.id,
      details: `Deleted NVR '${existing.name}'`,
    });
    res.json({ deleted: true, id: req.params.id });
  });

  app.post('/api/nvrs/:id/test', async (req, res) => {
    const nvr = db.prepare('SELECT * FROM nvrs WHERE id = ?').get(req.params.id) as RawNvrRow | undefined;
    if (!nvr) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'NVR not found.' });
      return;
    }
    const password = vault.getSecret(nvr.credential_ref);
    const adapter = getNvrAdapter(nvr.adapter_type);
    const outcome = await adapter.testConnection({
      host: nvr.host,
      port: nvr.port,
      rtspPort: nvr.rtsp_port,
      username: nvr.username,
      password,
      rtspTransport: nvr.rtsp_transport,
      rtspUrlTemplate: nvr.rtsp_url_template,
      channelCount: nvr.channel_count,
    });
    const cleanMsg = sanitizeLogText(outcome.message, nvr.rtsp_url_template ?? undefined, password);
    const now = utcNowIso();
    db.prepare(
      `
      UPDATE nvrs
      SET status = ?, last_checked_at = ?, last_error = ?,
          device_manufacturer = COALESCE(?, device_manufacturer),
          device_model = COALESCE(?, device_model),
          firmware_version = COALESCE(?, firmware_version),
          updated_at = ?
      WHERE id = ?
    `
    ).run(
      outcome.status,
      now,
      outcome.reachable ? null : cleanMsg,
      outcome.manufacturer,
      outcome.model,
      outcome.firmware_version,
      now,
      nvr.id
    );
    const updated = db.prepare('SELECT * FROM nvrs WHERE id = ?').get(nvr.id) as RawNvrRow;
    writeAuditLog({
      action: 'NVR_TESTED',
      resourceType: 'nvr',
      resourceId: nvr.id,
      details: `NVR '${nvr.name}': ${cleanMsg}`,
      outcome: outcome.reachable ? 'success' : 'error',
    });
    res.json({ nvr: formatNvrRow(updated), probe: outcome, message: cleanMsg });
  });

  app.post('/api/nvrs/:id/discover-channels', async (req, res) => {
    const nvr = db.prepare('SELECT * FROM nvrs WHERE id = ?').get(req.params.id) as RawNvrRow | undefined;
    if (!nvr) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'NVR not found.' });
      return;
    }
    const password = vault.getSecret(nvr.credential_ref);
    const adapter = getNvrAdapter(nvr.adapter_type);
    const outcome = await adapter.discoverChannels({
      host: nvr.host,
      port: nvr.port,
      rtspPort: nvr.rtsp_port,
      username: nvr.username,
      password,
      rtspTransport: nvr.rtsp_transport,
      rtspUrlTemplate: nvr.rtsp_url_template,
      channelCount: nvr.channel_count,
    });
    const cleanMsg = sanitizeLogText(outcome.message, nvr.rtsp_url_template ?? undefined, password);
    const now = utcNowIso();

    const tx = db.transaction(() => {
      for (const ch of outcome.channels) {
        const cleanMain = stripUriCredentials(ch.main_stream_uri).cleanUri;
        const cleanSub = ch.sub_stream_uri ? stripUriCredentials(ch.sub_stream_uri).cleanUri : null;
        const chErr = ch.error ? sanitizeLogText(ch.error, ch.main_stream_uri, password) : null;
        const existing = db
          .prepare('SELECT id FROM nvr_channels WHERE nvr_id = ? AND channel_number = ?')
          .get(nvr.id, ch.channel_number) as { id: string } | undefined;
        if (existing) {
          db.prepare(
            `
            UPDATE nvr_channels
            SET name = ?, profile_token = ?, main_stream_uri = ?, sub_stream_uri = ?,
                width = ?, height = ?, fps = ?, codec = ?, status = ?, last_checked_at = ?, last_error = ?, updated_at = ?
            WHERE id = ?
          `
          ).run(
            ch.name,
            ch.profile_token,
            cleanMain,
            cleanSub,
            ch.width,
            ch.height,
            ch.fps,
            ch.codec,
            ch.status,
            now,
            chErr,
            now,
            existing.id
          );
        } else {
          db.prepare(
            `
            INSERT INTO nvr_channels
              (id, nvr_id, channel_number, name, profile_token, main_stream_uri, sub_stream_uri,
               width, height, fps, codec, enabled, status, last_checked_at, last_error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          `
          ).run(
            crypto.randomUUID(),
            nvr.id,
            ch.channel_number,
            ch.name,
            ch.profile_token,
            cleanMain,
            cleanSub,
            ch.width,
            ch.height,
            ch.fps,
            ch.codec,
            ch.status,
            now,
            chErr,
            now,
            now
          );
        }
      }
      const totalCh = (db.prepare('SELECT COUNT(*) AS c FROM nvr_channels WHERE nvr_id = ?').get(nvr.id) as { c: number }).c;
      db.prepare(
        `
        UPDATE nvrs
        SET status = ?, channel_count = ?, last_checked_at = ?, last_error = ?,
            device_manufacturer = COALESCE(?, device_manufacturer),
            device_model = COALESCE(?, device_model),
            firmware_version = COALESCE(?, firmware_version),
            updated_at = ?
        WHERE id = ?
      `
      ).run(
        outcome.nvr_status,
        totalCh,
        now,
        outcome.nvr_status === 'online' ? null : cleanMsg,
        outcome.manufacturer,
        outcome.model,
        outcome.firmware_version,
        now,
        nvr.id
      );
    });
    tx();

    const updatedNvr = db.prepare('SELECT * FROM nvrs WHERE id = ?').get(nvr.id) as RawNvrRow;
    const chRows = db
      .prepare('SELECT * FROM nvr_channels WHERE nvr_id = ? ORDER BY channel_number ASC')
      .all(nvr.id) as RawNvrChannelRow[];

    writeAuditLog({
      action: 'NVR_CHANNELS_DISCOVERED',
      resourceType: 'nvr',
      resourceId: nvr.id,
      details: `NVR '${nvr.name}': ${cleanMsg}`,
      outcome: outcome.nvr_status === 'online' ? 'success' : 'error',
    });

    res.json({
      nvr: formatNvrRow(updatedNvr),
      channels: chRows.map(formatNvrChannelRow),
      message: cleanMsg,
    });
  });

  app.get('/api/nvrs/:id/channels', (req, res) => {
    const nvr = db.prepare('SELECT id FROM nvrs WHERE id = ?').get(req.params.id);
    if (!nvr) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'NVR not found.' });
      return;
    }
    const rows = db
      .prepare('SELECT * FROM nvr_channels WHERE nvr_id = ? ORDER BY channel_number ASC')
      .all(req.params.id) as RawNvrChannelRow[];
    res.json(rows.map(formatNvrChannelRow));
  });

  app.patch('/api/nvrs/:id/channels/:channelId', (req, res) => {
    const ch = db
      .prepare('SELECT * FROM nvr_channels WHERE id = ? AND nvr_id = ?')
      .get(req.params.channelId, req.params.id) as RawNvrChannelRow | undefined;
    if (!ch) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'NVR channel not found.' });
      return;
    }
    const enabled = req.body?.enabled !== false ? 1 : 0;
    db.prepare('UPDATE nvr_channels SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled, utcNowIso(), ch.id);
    const updated = db.prepare('SELECT * FROM nvr_channels WHERE id = ?').get(ch.id) as RawNvrChannelRow;
    res.json(formatNvrChannelRow(updated));
  });

  app.post('/api/nvrs/:id/channels/:channelId/register', (req, res) => {
    const nvr = db.prepare('SELECT * FROM nvrs WHERE id = ?').get(req.params.id) as RawNvrRow | undefined;
    const ch = db
      .prepare('SELECT * FROM nvr_channels WHERE id = ? AND nvr_id = ?')
      .get(req.params.channelId, req.params.id) as RawNvrChannelRow | undefined;
    if (!nvr || !ch) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'NVR or channel not found.' });
      return;
    }
    if (ch.registered_camera_id) {
      const existingCam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(ch.registered_camera_id) as RawCameraRow | undefined;
      if (existingCam) {
        res.status(201).json(formatCameraRow(existingCam));
        return;
      }
    }

    const nvrSecret = vault.getSecret(nvr.credential_ref);
    const locZone =
      typeof req.body?.location_zone === 'string' && req.body.location_zone.trim()
        ? req.body.location_zone.trim()
        : nvr.name;
    const createdCam = createCameraRecord({
      name: `${nvr.name} · ${ch.name}`,
      location_zone: locZone,
      source_type: 'rtsp',
      stream_uri: ch.main_stream_uri,
      ip_address: nvr.host,
      rtsp_port: nvr.rtsp_port,
      onvif_port: nvr.port,
      username: nvr.username,
      password: nvrSecret,
      rtsp_transport: nvr.rtsp_transport,
      main_stream_uri: ch.main_stream_uri,
      sub_stream_uri: ch.sub_stream_uri,
      nvr_id: nvr.id,
      channel_number: ch.channel_number,
      target_resolution: ch.width && ch.height ? `${ch.width}x${ch.height}` : '1280x720',
    });

    db.prepare('UPDATE nvr_channels SET registered_camera_id = ?, updated_at = ? WHERE id = ?').run(
      createdCam.id,
      utcNowIso(),
      ch.id
    );
    db.prepare('UPDATE cameras SET status = ?, device_manufacturer = ?, device_model = ? WHERE id = ?').run(
      ch.status,
      nvr.device_manufacturer,
      nvr.device_model,
      createdCam.id
    );
    const updatedCam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(createdCam.id) as RawCameraRow;
    res.status(201).json(formatCameraRow(updatedCam));
  });

  // CCTV Video Library
  app.get('/api/videos', (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT v.*, c.name AS camera_name
        FROM video_files v
        LEFT JOIN cameras c ON v.camera_id = c.id
        ORDER BY v.imported_at DESC
      `
      )
      .all() as VideoFileRecord[];
    res.json(rows);
  });

  app.post('/api/videos/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'No video file was provided.' });
      return;
    }

    const videoId = path.parse(req.file.filename).name;
    const cameraId = typeof req.body?.camera_id === 'string' && req.body.camera_id.trim() ? req.body.camera_id.trim() : null;
    const recordedAt = typeof req.body?.recorded_at === 'string' && req.body.recorded_at.trim() ? req.body.recorded_at.trim() : null;
    const { activeThumb } = getConfiguredDirectories();

    try {
      if (req.file.size <= 0) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        writeAuditLog({
          action: 'VIDEO_IMPORT_REJECTED',
          resourceType: 'video_file',
          details: `Rejected empty video file '${req.file.originalname}'.`,
          outcome: 'error',
        });
        res.status(400).json({ error: 'EMPTY_FILE', message: 'Uploaded video file is empty (0 bytes).' });
        return;
      }

      if (cameraId) {
        const camExists = db.prepare('SELECT id FROM cameras WHERE id = ?').get(cameraId);
        if (!camExists) {
          if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Referenced camera_id does not exist.' });
          return;
        }
      }

      const sha256 = await sha256File(req.file.path);
      const meta = ffmpegAvailable
        ? await probeVideoWithFfmpeg(req.file.path)
        : { durationSeconds: null, width: null, height: null, fps: null, codec: null };

      if (ffmpegAvailable && !meta.codec && !meta.width && meta.durationSeconds === null) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        writeAuditLog({
          action: 'VIDEO_IMPORT_REJECTED',
          resourceType: 'video_file',
          details: `Rejected unreadable/corrupt video file '${req.file.originalname}'.`,
          outcome: 'error',
        });
        res.status(422).json({
          error: 'INVALID_VIDEO_FILE',
          message: 'FFmpeg could not detect a valid video stream in the uploaded file.',
        });
        return;
      }

      const thumbPath = path.join(activeThumb, `${videoId}.jpg`);
      const thumbOk = ffmpegAvailable ? await extractThumbnailWithFfmpeg(req.file.path, thumbPath) : false;
      const now = utcNowIso();

      db.prepare(
        `
        INSERT INTO video_files
          (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes, duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?)
      `
      ).run(
        videoId,
        cameraId,
        req.file.filename,
        req.file.originalname,
        req.file.path,
        thumbOk ? thumbPath : null,
        sha256,
        req.file.size,
        meta.durationSeconds,
        meta.width,
        meta.height,
        meta.fps,
        meta.codec,
        recordedAt,
        now
      );

      db.prepare(
        `
        INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
        VALUES (?, ?, 'metadata_probe', 'ffmpeg-media-inspector', ?, 100, ?, ?, ?, ?)
      `
      ).run(
        crypto.randomUUID(),
        videoId,
        ffmpegAvailable ? 'completed' : 'skipped',
        ffmpegAvailable
          ? `Probed stream: codec=${meta.codec ?? 'unknown'}, ${meta.width ?? '?'}x${meta.height ?? '?'}, duration=${meta.durationSeconds ?? '?'}s`
          : 'FFmpeg not available; stored file hash and byte size only.',
        now,
        now,
        now
      );

      writeAuditLog({
        action: 'VIDEO_IMPORTED',
        resourceType: 'video_file',
        resourceId: videoId,
        details: `Imported '${req.file.originalname}' (${req.file.size} bytes, SHA-256 ${sha256.slice(0, 12)}...)`,
      });

      const created = db
        .prepare(
          `
          SELECT v.*, c.name AS camera_name
          FROM video_files v
          LEFT JOIN cameras c ON v.camera_id = c.id
          WHERE v.id = ?
        `
        )
        .get(videoId) as VideoFileRecord;

      res.status(201).json(created);
    } catch (err) {
      writeRuntimeLog('ERROR', `Video import failed: ${err instanceof Error ? err.message : String(err)}`);
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ error: 'IMPORT_FAILED', message: 'Failed to import and inspect video file.' });
    }
  });

  app.get('/api/videos/:id/thumbnail', (req, res) => {
    const row = db.prepare('SELECT thumbnail_path FROM video_files WHERE id = ?').get(req.params.id) as
      | { thumbnail_path: string | null }
      | undefined;
    if (!row || !row.thumbnail_path || !fs.existsSync(row.thumbnail_path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.resolve(row.thumbnail_path));
  });

  app.get('/api/videos/:id/stream', (req, res) => {
    const row = db.prepare('SELECT storage_path, original_name FROM video_files WHERE id = ?').get(req.params.id) as
      | { storage_path: string; original_name: string }
      | undefined;
    if (!row || !fs.existsSync(row.storage_path)) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Video file not found on disk.' });
      return;
    }

    const stat = fs.statSync(row.storage_path);
    const ext = path.extname(row.original_name).toLowerCase();
    const mimeType =
      ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';

    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = startStr ? parseInt(startStr, 10) : 0;
      const rawEnd = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const end = Number.isNaN(rawEnd) ? stat.size - 1 : Math.min(rawEnd, stat.size - 1);
      if (Number.isNaN(start) || start < 0 || start >= stat.size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mimeType,
      });
      fs.createReadStream(row.storage_path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
      });
      fs.createReadStream(row.storage_path).pipe(res);
    }
  });

  app.post('/api/videos/:id/inspect', async (req, res) => {
    const row = db.prepare('SELECT * FROM video_files WHERE id = ?').get(req.params.id) as VideoFileRecord | undefined;
    if (!row) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Video record not found.' });
      return;
    }
    if (!fs.existsSync(row.storage_path)) {
      res.status(404).json({ error: 'FILE_MISSING', message: 'Video file missing from local storage directory.' });
      return;
    }

    const { activeThumb } = getConfiguredDirectories();
    const meta = ffmpegAvailable
      ? await probeVideoWithFfmpeg(row.storage_path)
      : { durationSeconds: row.duration_seconds, width: row.width, height: row.height, fps: row.fps, codec: row.codec };
    const thumbPath = path.join(activeThumb, `${row.id}.jpg`);
    const thumbOk = ffmpegAvailable ? await extractThumbnailWithFfmpeg(row.storage_path, thumbPath) : false;
    const now = utcNowIso();

    db.prepare(
      `
      UPDATE video_files
      SET duration_seconds = ?, width = ?, height = ?, fps = ?, codec = ?, thumbnail_path = COALESCE(?, thumbnail_path), processing_status = 'ready'
      WHERE id = ?
    `
    ).run(meta.durationSeconds, meta.width, meta.height, meta.fps, meta.codec, thumbOk ? thumbPath : null, row.id);

    db.prepare(
      `
      INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
      VALUES (?, ?, 'metadata_probe', 'ffmpeg-media-inspector', ?, 100, ?, ?, ?, ?)
    `
    ).run(
      crypto.randomUUID(),
      row.id,
      ffmpegAvailable ? 'completed' : 'skipped',
      `Re-inspected '${row.original_name}': codec=${meta.codec ?? 'unknown'} ${meta.width ?? '?'}x${meta.height ?? '?'}`,
      now,
      now,
      now
    );

    writeAuditLog({
      action: 'VIDEO_REINSPECTED',
      resourceType: 'video_file',
      resourceId: row.id,
      details: `Executed FFmpeg inspection on '${row.original_name}'`,
    });

    const updated = db.prepare('SELECT * FROM video_files WHERE id = ?').get(row.id) as VideoFileRecord;
    res.json(updated);
  });

  app.delete('/api/videos/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM video_files WHERE id = ?').get(req.params.id) as VideoFileRecord | undefined;
    if (!row) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Video not found.' });
      return;
    }

    const cropRows = db
      .prepare('SELECT crop_path FROM person_events WHERE video_file_id = ? AND crop_path IS NOT NULL')
      .all(req.params.id) as Array<{ crop_path: string }>;

    db.prepare('DELETE FROM video_files WHERE id = ?').run(req.params.id);
    for (const filePath of [row.storage_path, row.thumbnail_path, ...cropRows.map((c) => c.crop_path)]) {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Best-effort cleanup
        }
      }
    }

    writeAuditLog({
      action: 'VIDEO_DELETED',
      resourceType: 'video_file',
      resourceId: req.params.id,
      details: `Removed imported video '${row.original_name}' from local vault`,
    });
    res.json({ deleted: true, id: req.params.id });
  });

  app.get('/api/videos/:id/events', (req, res) => {
    const rows = db
      .prepare(
        `
        SELECT e.*, v.original_name AS video_name, c.name AS camera_name, t.track_code AS track_code
        FROM person_events e
        LEFT JOIN video_files v ON e.video_file_id = v.id
        LEFT JOIN cameras c ON e.camera_id = c.id
        LEFT JOIN anonymous_tracks t ON e.anonymous_track_id = t.id
        WHERE e.video_file_id = ?
        ORDER BY e.event_timestamp_sec ASC
      `
      )
      .all(req.params.id);
    res.json(rows);
  });

  app.post('/api/videos/:id/redact', async (req, res) => {
    if (!ffmpegAvailable) {
      res.status(503).json({ error: 'FFMPEG_UNAVAILABLE', message: 'FFmpeg is required to export privacy-masked videos.' });
      return;
    }
    const video = db.prepare('SELECT * FROM video_files WHERE id = ?').get(req.params.id) as VideoFileRecord | undefined;
    if (!video || !fs.existsSync(video.storage_path)) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Source video file not found.' });
      return;
    }

    const { activeStorage, activeThumb, settings } = getConfiguredDirectories();
    const requestedMode = req.body?.mode || settings.privacy_mask_mode || 'blur';
    const mode: PrivacyMaskMode = requestedMode === 'pixelate' ? 'pixelate' : 'blur';

    let regions: Array<{ x: number; y: number; w: number; h: number }> = [];
    if (Array.isArray(req.body?.regions)) {
      regions = req.body.regions;
    } else {
      const evtRows = db
        .prepare('SELECT bbox_json FROM person_events WHERE video_file_id = ? AND bbox_json IS NOT NULL')
        .all(video.id) as Array<{ bbox_json: string }>;
      for (const er of evtRows) {
        try {
          const parsed = JSON.parse(er.bbox_json);
          if (parsed && typeof parsed.x === 'number') regions.push(parsed);
        } catch {
          // Ignore malformed bbox
        }
      }
    }

    const exportId = crypto.randomUUID();
    const stem = path.parse(video.original_name).name;
    const exportName = `${stem}_redacted_${mode}_${exportId.slice(0, 6)}.mp4`;
    const outPath = path.join(activeStorage, 'redacted', exportName);

    try {
      const exported = await exportPrivacyMaskedVideo({
        inputPath: video.storage_path,
        outputPath: outPath,
        regions,
        mode,
        frameWidth: video.width,
        frameHeight: video.height,
      });
      const meta = await probeVideoWithFfmpeg(outPath);
      const thumbPath = path.join(activeThumb, `${exportId}.jpg`);
      const thumbOk = await extractThumbnailWithFfmpeg(outPath, thumbPath);
      const now = utcNowIso();

      db.prepare(
        `
        INSERT INTO video_files
          (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
           duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at,
           source_origin, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, 'redacted_export', ?)
      `
      ).run(
        exportId,
        video.camera_id,
        exportName,
        exportName,
        outPath,
        thumbOk ? thumbPath : null,
        exported.sha256,
        exported.sizeBytes,
        meta.durationSeconds,
        meta.width,
        meta.height,
        meta.fps,
        meta.codec,
        video.recorded_at,
        now
      );

      writeAuditLog({
        action: 'VIDEO_PRIVACY_EXPORTED',
        resourceType: 'video_file',
        resourceId: exportId,
        details: `Exported ${mode}-masked video '${exportName}' (${regions.length} region(s))`,
      });

      const created = db
        .prepare(
          'SELECT v.*, c.name AS camera_name FROM video_files v LEFT JOIN cameras c ON v.camera_id = c.id WHERE v.id = ?'
        )
        .get(exportId) as VideoFileRecord;
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({
        error: 'PRIVACY_EXPORT_FAILED',
        message: err instanceof Error ? err.message : 'Failed to export privacy-masked video.',
      });
    }
  });

  app.post('/api/retention/enforce', (_req, res) => {
    const result = enforceRetentionPolicies(db);
    writeAuditLog({
      action: 'RETENTION_ENFORCED',
      resourceType: 'system',
      details: `Retention sweep removed ${result.expired_videos_deleted} expired video(s) and ${result.orphaned_events_purged} old dismissed event(s).`,
    });
    res.json(result);
  });

  // Person Events (Gallery) & Anonymous Tracks (Stage 2 Phase D + E)
  app.get('/api/person-events', (req, res) => {
    const clauses: string[] = [];
    const params: string[] = [];
    if (typeof req.query.camera_id === 'string' && req.query.camera_id.trim()) {
      clauses.push('e.camera_id = ?');
      params.push(req.query.camera_id.trim());
    }
    if (typeof req.query.video_file_id === 'string' && req.query.video_file_id.trim()) {
      clauses.push('e.video_file_id = ?');
      params.push(req.query.video_file_id.trim());
    }
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      clauses.push('e.status = ?');
      params.push(req.query.status.trim());
    }
    if (typeof req.query.track_id === 'string' && req.query.track_id.trim()) {
      clauses.push('e.anonymous_track_id = ?');
      params.push(req.query.track_id.trim());
    }
    if (typeof req.query.from === 'string' && req.query.from.trim()) {
      clauses.push('e.created_at >= ?');
      params.push(req.query.from.trim());
    }
    if (typeof req.query.to === 'string' && req.query.to.trim()) {
      clauses.push('e.created_at <= ?');
      params.push(req.query.to.trim());
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `
        SELECT e.*, v.original_name AS video_name, c.name AS camera_name, t.track_code AS track_code
        FROM person_events e
        LEFT JOIN video_files v ON e.video_file_id = v.id
        LEFT JOIN cameras c ON e.camera_id = c.id
        LEFT JOIN anonymous_tracks t ON e.anonymous_track_id = t.id
        ${whereSql}
        ORDER BY e.created_at DESC
      `
      )
      .all(...params);
    res.json(rows);
  });

  app.get('/api/person-events/:id/thumbnail', (req, res) => {
    const row = db.prepare('SELECT crop_path FROM person_events WHERE id = ?').get(req.params.id) as
      | { crop_path: string | null }
      | undefined;
    if (!row || !row.crop_path || !fs.existsSync(row.crop_path)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.resolve(row.crop_path));
  });

  app.patch('/api/person-events/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM person_events WHERE id = ?').get(req.params.id) as
      | { id: string; status: string; profile_id: string | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Person event not found.' });
      return;
    }

    const body = req.body ?? {};
    let nextStatus = ['unreviewed', 'clustered', 'linked', 'dismissed'].includes(body.status)
      ? body.status
      : existing.status;
    let nextProfileId = existing.profile_id;

    if (body.profile_id !== undefined) {
      if (!body.profile_id) {
        nextProfileId = null;
      } else {
        const prof = db
          .prepare('SELECT id, consent_status FROM person_profiles WHERE id = ?')
          .get(String(body.profile_id)) as { id: string; consent_status: string } | undefined;
        if (!prof) {
          res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Target person profile not found.' });
          return;
        }
        const settings = getSettingsMap();
        if (settings.require_consent_for_profiles === 'true' && prof.consent_status !== 'granted') {
          res.status(403).json({
            error: 'PRIVACY_POLICY_VIOLATION',
            message: 'Consent must be granted before linking an event to a registered profile.',
          });
          return;
        }
        nextProfileId = prof.id;
        if (nextStatus === 'unreviewed') nextStatus = 'linked';
      }
    }

    const now = utcNowIso();
    const reviewer = typeof body.reviewed_by === 'string' && body.reviewed_by.trim() ? body.reviewed_by.trim() : 'Local Administrator';
    db.prepare(
      'UPDATE person_events SET status = ?, profile_id = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?'
    ).run(nextStatus, nextProfileId, reviewer, now, existing.id);

    const updated = db
      .prepare(
        `
        SELECT e.*, v.original_name AS video_name, c.name AS camera_name, t.track_code AS track_code
        FROM person_events e
        LEFT JOIN video_files v ON e.video_file_id = v.id
        LEFT JOIN cameras c ON e.camera_id = c.id
        LEFT JOIN anonymous_tracks t ON e.anonymous_track_id = t.id
        WHERE e.id = ?
      `
      )
      .get(existing.id);

    writeAuditLog({
      actor: reviewer,
      action: 'PERSON_EVENT_REVIEWED',
      resourceType: 'person_event',
      resourceId: existing.id,
      details: `Updated person event status='${nextStatus}'`,
    });
    res.json(updated);
  });

  app.delete('/api/person-events/:id', (req, res) => {
    const existing = db.prepare('SELECT crop_path FROM person_events WHERE id = ?').get(req.params.id) as
      | { crop_path: string | null }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Person event not found.' });
      return;
    }
    db.prepare('DELETE FROM person_events WHERE id = ?').run(req.params.id);
    if (existing.crop_path && fs.existsSync(existing.crop_path)) {
      try {
        fs.unlinkSync(existing.crop_path);
      } catch {
        // Best-effort cleanup
      }
    }
    writeAuditLog({
      action: 'PERSON_EVENT_DELETED',
      resourceType: 'person_event',
      resourceId: req.params.id,
      details: 'Deleted person event and thumbnail crop.',
    });
    res.json({ deleted: true, id: req.params.id });
  });

  app.get('/api/anonymous-tracks', (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT t.*, c.name AS camera_name
        FROM anonymous_tracks t
        LEFT JOIN cameras c ON t.camera_id = c.id
        ORDER BY t.created_at DESC
        LIMIT 200
      `
      )
      .all();
    res.json(rows);
  });

  // Person Profiles (Consent & Privacy Governance)
  app.get('/api/profiles', (_req, res) => {
    const rows = db.prepare('SELECT * FROM person_profiles ORDER BY updated_at DESC').all() as PersonProfileRecord[];
    res.json(rows);
  });

  app.post('/api/profiles', (req, res) => {
    const body = req.body ?? {};
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (!displayName) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Profile display name is required.' });
      return;
    }

    const category = body.category === 'authorized' ? 'authorized' : 'anonymous';
    const authLevel = ['authorized', 'visitor', 'restricted', 'anonymous'].includes(body.authorization_level)
      ? body.authorization_level
      : category === 'authorized'
        ? 'visitor'
        : 'anonymous';
    const consentStatus = ['granted', 'pending', 'revoked'].includes(body.consent_status) ? body.consent_status : 'pending';

    const settings = getSettingsMap();
    if (
      settings.require_consent_for_profiles === 'true' &&
      authLevel === 'authorized' &&
      consentStatus !== 'granted'
    ) {
      writeAuditLog({
        action: 'PROFILE_POLICY_BLOCKED',
        resourceType: 'person_profile',
        details: `Blocked creating authorized profile '${displayName}' without granted consent.`,
        outcome: 'denied',
      });
      res.status(403).json({
        error: 'PRIVACY_POLICY_VIOLATION',
        message: 'Policy requires consent_status="granted" before assigning authorized status.',
      });
      return;
    }

    const id = crypto.randomUUID();
    const profileCode = `LFX-${id.slice(0, 8).toUpperCase()}`;
    const now = utcNowIso();
    const consentRecordedAt = consentStatus === 'granted' ? now : null;

    db.prepare(
      `
      INSERT INTO person_profiles
        (id, profile_code, display_name, category, authorization_level, consent_status, consent_recorded_at, retention_expires_at, department_or_zone, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      profileCode,
      displayName,
      category,
      authLevel,
      consentStatus,
      consentRecordedAt,
      body.retention_expires_at || null,
      String(body.department_or_zone || 'General').trim(),
      String(body.notes || '').trim(),
      now,
      now
    );

    const created = db.prepare('SELECT * FROM person_profiles WHERE id = ?').get(id) as PersonProfileRecord;
    writeAuditLog({
      action: 'PROFILE_CREATED',
      resourceType: 'person_profile',
      resourceId: id,
      details: `Created ${category} profile ${profileCode} (level=${authLevel}, consent=${consentStatus})`,
    });
    res.status(201).json(created);
  });

  app.patch('/api/profiles/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM person_profiles WHERE id = ?').get(req.params.id) as
      | PersonProfileRecord
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Person profile not found.' });
      return;
    }

    const body = req.body ?? {};
    const nextConsent = ['granted', 'pending', 'revoked'].includes(body.consent_status)
      ? body.consent_status
      : existing.consent_status;
    const nextAuthLevel = ['authorized', 'visitor', 'restricted', 'anonymous'].includes(body.authorization_level)
      ? body.authorization_level
      : existing.authorization_level;

    const settings = getSettingsMap();
    if (settings.require_consent_for_profiles === 'true' && nextAuthLevel === 'authorized' && nextConsent !== 'granted') {
      res.status(403).json({
        error: 'PRIVACY_POLICY_VIOLATION',
        message: 'Consent must be granted before setting authorization level to authorized.',
      });
      return;
    }

    const now = utcNowIso();
    const consentRecordedAt =
      nextConsent === 'granted' ? existing.consent_recorded_at || now : existing.consent_recorded_at;

    db.prepare(
      `
      UPDATE person_profiles
      SET display_name = ?, category = ?, authorization_level = ?, consent_status = ?, consent_recorded_at = ?, department_or_zone = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(
      body.display_name ? String(body.display_name).trim() : existing.display_name,
      body.category === 'authorized' || body.category === 'anonymous' ? body.category : existing.category,
      nextAuthLevel,
      nextConsent,
      consentRecordedAt,
      body.department_or_zone !== undefined ? String(body.department_or_zone).trim() : existing.department_or_zone,
      body.notes !== undefined ? String(body.notes).trim() : existing.notes,
      now,
      existing.id
    );

    const updated = db.prepare('SELECT * FROM person_profiles WHERE id = ?').get(existing.id) as PersonProfileRecord;
    writeAuditLog({
      action: 'PROFILE_UPDATED',
      resourceType: 'person_profile',
      resourceId: existing.id,
      details: `Updated profile ${updated.profile_code} (consent=${updated.consent_status}, level=${updated.authorization_level})`,
    });
    res.json(updated);
  });

  app.delete('/api/profiles/:id', (req, res) => {
    const existing = db.prepare('SELECT profile_code FROM person_profiles WHERE id = ?').get(req.params.id) as
      | { profile_code: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Person profile not found.' });
      return;
    }
    db.prepare('DELETE FROM person_profiles WHERE id = ?').run(req.params.id);
    writeAuditLog({
      action: 'PROFILE_DELETED',
      resourceType: 'person_profile',
      resourceId: req.params.id,
      details: `Deleted person profile ${existing.profile_code}`,
    });
    res.json({ deleted: true, id: req.params.id });
  });

  // AI Engines & Processing Jobs
  app.get('/api/ai/engines', (_req, res) => {
    res.json(getAiEngines());
  });

  app.get('/api/ai/jobs', (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT j.*, v.original_name AS video_name
        FROM processing_jobs j
        LEFT JOIN video_files v ON j.video_file_id = v.id
        ORDER BY j.created_at DESC
        LIMIT 50
      `
      )
      .all() as ProcessingJobRecord[];
    res.json(rows);
  });

  app.post('/api/ai/jobs', async (req, res) => {
    const { video_file_id, engine_id, sample_fps, confidence_threshold } = req.body ?? {};
    if (!video_file_id || !engine_id) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'video_file_id and engine_id are required.' });
      return;
    }

    const video = db.prepare('SELECT * FROM video_files WHERE id = ?').get(video_file_id) as VideoFileRecord | undefined;
    if (!video) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Target video file not found.' });
      return;
    }

    const now = utcNowIso();
    const jobId = crypto.randomUUID();

    if (engine_id === 'biometric-matching-guard') {
      writeAuditLog({
        action: 'BIOMETRIC_PIPELINE_DENIED',
        resourceType: 'processing_job',
        resourceId: video.id,
        details: `Denied biometric execution on '${video.original_name}' per LumaFlux privacy policy.`,
        outcome: 'denied',
      });
      res.status(403).json({
        error: 'PRIVACY_POLICY_VIOLATION',
        message: 'Biometric identification is disabled by policy.',
      });
      return;
    }

    if (engine_id === 'ffmpeg-media-inspector') {
      const meta = ffmpegAvailable
        ? await probeVideoWithFfmpeg(video.storage_path)
        : { durationSeconds: video.duration_seconds, width: video.width, height: video.height, fps: video.fps, codec: video.codec };

      db.prepare(
        `
        INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
        VALUES (?, ?, 'metadata_probe', ?, ?, 100, ?, ?, ?, ?)
      `
      ).run(
        jobId,
        video.id,
        engine_id,
        ffmpegAvailable ? 'completed' : 'skipped',
        `Inspected '${video.original_name}': codec=${meta.codec ?? 'unknown'}, resolution=${meta.width ?? '?'}x${meta.height ?? '?'}`,
        now,
        now,
        now
      );
    } else if (engine_id === 'opencv-person-detector' || engine_id === 'opencv-motion-detector') {
      const { activeThumb, settings } = getConfiguredDirectories();
      const fpsVal = Number(sample_fps ?? settings.detection_sample_fps ?? '2.0') || 2.0;
      const thrVal = Number(confidence_threshold ?? settings.detection_confidence_threshold ?? '0.45') || 0.45;
      const cropDir = path.join(activeThumb, 'events');

      let detResult: {
        executed: boolean;
        status: string;
        reason: string;
        tracks: Array<{
          track_id: string;
          track_code: string;
          camera_id: string | null;
          video_file_id: string;
          first_seen_sec: number;
          last_seen_sec: number;
          event_count: number;
          best_confidence: number;
        }>;
        events: Array<{
          event_id: string;
          track_id: string;
          camera_id: string | null;
          video_file_id: string;
          best_timestamp_sec: number;
          end_timestamp_sec: number;
          peak_confidence: number;
          best_frame_number: number;
          frame_count: number;
          best_bbox: { x: number; y: number; w: number; h: number };
          model_name: string;
          crop_path: string | null;
        }>;
      };

      try {
        const { stdout } = await execFileAsync(
          'python3',
          [
            '-m',
            'ai_engine.person_detector',
            '--video',
            video.storage_path,
            '--video-id',
            video.id,
            '--camera-id',
            video.camera_id || '',
            '--engine',
            engine_id,
            '--fps',
            String(fpsVal),
            '--threshold',
            String(thrVal),
            '--crop-dir',
            cropDir,
            '--privacy-blur',
            settings.privacy_blur_default || 'true',
          ],
          { cwd: __dirname, timeout: 120000 }
        );
        detResult = JSON.parse(stdout);
      } catch (err) {
        detResult = {
          executed: false,
          status: 'failed',
          reason: err instanceof Error ? err.message : 'OpenCV runner failed to execute.',
          tracks: [],
          events: [],
        };
      }

      const jobStatus = detResult.executed ? 'completed' : detResult.status === 'failed' ? 'failed' : 'skipped';
      const progress = detResult.executed ? 100 : 0;

      const tx = db.transaction(() => {
        if (detResult.executed) {
          for (const trk of detResult.tracks) {
            db.prepare(
              `
              INSERT INTO anonymous_tracks
                (id, track_code, camera_id, video_file_id, stream_session_id, first_seen_sec, last_seen_sec,
                 event_count, best_confidence, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'closed', ?, ?)
            `
            ).run(
              trk.track_id,
              trk.track_code,
              trk.camera_id,
              trk.video_file_id,
              trk.first_seen_sec,
              trk.last_seen_sec,
              trk.event_count,
              trk.best_confidence,
              now,
              now
            );
          }
          for (const evt of detResult.events) {
            db.prepare(
              `
              INSERT INTO person_events
                (id, video_file_id, camera_id, profile_id, anonymous_track_id, event_timestamp_sec,
                 end_timestamp_sec, confidence, frame_number, frame_count, bbox_json, crop_path, model_name, status, created_at)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?)
            `
            ).run(
              evt.event_id,
              evt.video_file_id,
              evt.camera_id,
              evt.track_id,
              evt.best_timestamp_sec,
              evt.end_timestamp_sec,
              evt.peak_confidence,
              evt.best_frame_number,
              evt.frame_count,
              JSON.stringify(evt.best_bbox),
              evt.crop_path,
              evt.model_name,
              now
            );
            if (evt.crop_path) {
              const maskedOn = settings.privacy_blur_default === 'true';
              db.prepare(
                `
                INSERT INTO event_thumbnails (id, event_id, file_path, width, height, privacy_masked, mask_mode, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `
              ).run(
                crypto.randomUUID(),
                evt.event_id,
                evt.crop_path,
                evt.best_bbox.w,
                evt.best_bbox.h,
                maskedOn ? 1 : 0,
                maskedOn ? 'blur' : 'none',
                now
              );
            }
          }
        }

        db.prepare(
          `
          INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
          VALUES (?, ?, 'ai_person_detect', ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(jobId, video.id, engine_id, jobStatus, progress, detResult.reason, now, now, now);
      });
      tx();
    } else if (engine_id === 'privacy-redaction-filter') {
      if (!ffmpegAvailable) {
        db.prepare(
          `INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
           VALUES (?, ?, 'ai_person_detect', ?, 'skipped', 0, 'FFmpeg is unavailable for privacy redaction export.', ?, ?, ?)`
        ).run(jobId, video.id, engine_id, now, now, now);
      } else {
        const { activeStorage, activeThumb, settings } = getConfiguredDirectories();
        const mode: PrivacyMaskMode = settings.privacy_mask_mode === 'pixelate' ? 'pixelate' : 'blur';
        const exportId = crypto.randomUUID();
        const stem = path.parse(video.original_name).name;
        const exportName = `${stem}_redacted_${mode}_${exportId.slice(0, 6)}.mp4`;
        const outPath = path.join(activeStorage, 'redacted', exportName);
        const evtRows = db
          .prepare('SELECT bbox_json FROM person_events WHERE video_file_id = ? AND bbox_json IS NOT NULL')
          .all(video.id) as Array<{ bbox_json: string }>;
        const regions: Array<{ x: number; y: number; w: number; h: number }> = [];
        for (const er of evtRows) {
          try {
            const p = JSON.parse(er.bbox_json);
            if (p && typeof p.x === 'number') regions.push(p);
          } catch {
            // Ignore malformed bbox
          }
        }
        const exported = await exportPrivacyMaskedVideo({
          inputPath: video.storage_path,
          outputPath: outPath,
          regions,
          mode,
          frameWidth: video.width,
          frameHeight: video.height,
        });
        const meta = await probeVideoWithFfmpeg(outPath);
        const thumbPath = path.join(activeThumb, `${exportId}.jpg`);
        const thumbOk = await extractThumbnailWithFfmpeg(outPath, thumbPath);
        db.prepare(
          `
          INSERT INTO video_files
            (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
             duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at,
             source_origin, imported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, 'redacted_export', ?)
        `
        ).run(
          exportId,
          video.camera_id,
          exportName,
          exportName,
          outPath,
          thumbOk ? thumbPath : null,
          exported.sha256,
          exported.sizeBytes,
          meta.durationSeconds,
          meta.width,
          meta.height,
          meta.fps,
          meta.codec,
          video.recorded_at,
          now
        );
        db.prepare(
          `INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
           VALUES (?, ?, 'ai_person_detect', ?, 'completed', 100, ?, ?, ?, ?)`
        ).run(
          jobId,
          video.id,
          engine_id,
          `Exported privacy-masked video '${exportName}' (${mode}, ${regions.length} region(s)).`,
          now,
          now,
          now
        );
      }
    } else {
      db.prepare(
        `
        INSERT INTO processing_jobs (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
        VALUES (?, ?, 'ai_person_detect', ?, 'skipped', 0, ?, ?, ?, ?)
      `
      ).run(
        jobId,
        video.id,
        engine_id,
        `Unknown or inactive engine '${engine_id}'. No synthetic detections generated.`,
        now,
        now,
        now
      );
    }

    const job = db
      .prepare(
        `
        SELECT j.*, v.original_name AS video_name
        FROM processing_jobs j
        LEFT JOIN video_files v ON j.video_file_id = v.id
        WHERE j.id = ?
      `
      )
      .get(jobId) as ProcessingJobRecord;

    writeAuditLog({
      action: 'PROCESSING_JOB_LOGGED',
      resourceType: 'processing_job',
      resourceId: jobId,
      details: `Engine '${engine_id}' processed for '${video.original_name}' -> ${job.status}`,
    });

    res.status(201).json(job);
  });

  // Watchlist Reviews
  app.get('/api/watchlist-reviews', (_req, res) => {
    const rows = db
      .prepare(
        `
        SELECT w.*, p.display_name AS profile_name, v.original_name AS video_name
        FROM watchlist_reviews w
        LEFT JOIN person_profiles p ON w.profile_id = p.id
        LEFT JOIN video_files v ON w.video_file_id = v.id
        ORDER BY w.updated_at DESC
      `
      )
      .all() as WatchlistReviewRecord[];
    res.json(rows);
  });

  app.post('/api/watchlist-reviews', (req, res) => {
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!title || !reason) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Review title and reason are required.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = utcNowIso();
    const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';

    db.prepare(
      `
      INSERT INTO watchlist_reviews
        (id, title, profile_id, video_file_id, event_id, priority, status, reason, reviewer_notes, assigned_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      title,
      body.profile_id || null,
      body.video_file_id || null,
      body.event_id || null,
      priority,
      reason,
      String(body.reviewer_notes || '').trim(),
      String(body.assigned_to || 'Security Operator').trim(),
      now,
      now
    );

    const created = db
      .prepare(
        `
        SELECT w.*, p.display_name AS profile_name, v.original_name AS video_name
        FROM watchlist_reviews w
        LEFT JOIN person_profiles p ON w.profile_id = p.id
        LEFT JOIN video_files v ON w.video_file_id = v.id
        WHERE w.id = ?
      `
      )
      .get(id) as WatchlistReviewRecord;

    writeAuditLog({
      action: 'WATCHLIST_REVIEW_CREATED',
      resourceType: 'watchlist_review',
      resourceId: id,
      details: `Opened ${priority} security review '${title}'`,
    });
    res.status(201).json(created);
  });

  app.patch('/api/watchlist-reviews/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM watchlist_reviews WHERE id = ?').get(req.params.id) as
      | WatchlistReviewRecord
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'RESOURCE_NOT_FOUND', message: 'Review item not found.' });
      return;
    }

    const body = req.body ?? {};
    const status = ['pending', 'in_review', 'approved', 'dismissed', 'escalated'].includes(body.status)
      ? body.status
      : existing.status;
    const now = utcNowIso();

    db.prepare(
      `
      UPDATE watchlist_reviews
      SET status = ?, reviewer_notes = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(
      status,
      body.reviewer_notes !== undefined ? String(body.reviewer_notes).trim() : existing.reviewer_notes,
      now,
      existing.id
    );

    const updated = db
      .prepare(
        `
        SELECT w.*, p.display_name AS profile_name, v.original_name AS video_name
        FROM watchlist_reviews w
        LEFT JOIN person_profiles p ON w.profile_id = p.id
        LEFT JOIN video_files v ON w.video_file_id = v.id
        WHERE w.id = ?
      `
      )
      .get(existing.id) as WatchlistReviewRecord;

    writeAuditLog({
      action: 'WATCHLIST_REVIEW_UPDATED',
      resourceType: 'watchlist_review',
      resourceId: existing.id,
      details: `Review '${updated.title}' transitioned to '${updated.status}'`,
    });
    res.json(updated);
  });

  // Reports summary
  app.get('/api/reports/summary', (_req, res) => {
    const cameras = db.prepare('SELECT id, name, location_zone, source_type, status, enabled, retention_days FROM cameras').all();
    const videos = db
      .prepare('SELECT id, original_name, file_size_bytes, duration_seconds, codec, processing_status, imported_at FROM video_files')
      .all();
    const profiles = db
      .prepare('SELECT id, profile_code, display_name, category, authorization_level, consent_status, updated_at FROM person_profiles')
      .all();
    const reviews = db.prepare('SELECT id, title, priority, status, assigned_to, updated_at FROM watchlist_reviews').all();
    const auditCount = (db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get() as { c: number }).c;

    writeAuditLog({
      action: 'COMPLIANCE_REPORT_GENERATED',
      resourceType: 'report',
      details: 'Generated live SQLite operational & compliance summary report.',
    });

    res.json({
      generated_at: utcNowIso(),
      platform: 'LumaFlux Intelligence',
      stage: 'Stage 1 Foundation',
      counts: {
        cameras: cameras.length,
        videos: videos.length,
        profiles: profiles.length,
        watchlist_reviews: reviews.length,
        audit_logs: auditCount,
      },
      cameras,
      videos,
      profiles,
      reviews,
    });
  });

  // Security & Audit Logs
  app.get('/api/audit-logs', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 500);
    const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : '';
    const rows = outcome
      ? (db
          .prepare('SELECT * FROM audit_logs WHERE outcome = ? ORDER BY created_at DESC LIMIT ?')
          .all(outcome, limit) as AuditLogRecord[])
      : (db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit) as AuditLogRecord[]);
    res.json(rows);
  });

  // Settings
  app.get('/api/settings', (_req, res) => {
    res.json(getSettingsMap());
  });

  app.put('/api/settings', (req, res) => {
    const updates = req.body ?? {};
    if (typeof updates !== 'object' || Array.isArray(updates)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Settings payload must be a JSON object.' });
      return;
    }

    const now = utcNowIso();
    const stmt = db.prepare(
      `
      INSERT INTO app_settings (key, value, category, description, updated_at)
      VALUES (?, ?, 'custom', 'User configured preference', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
    );

    const updatedKeys: string[] = [];
    try {
      const tx = db.transaction(() => {
        for (const [key, val] of Object.entries(updates)) {
          const cleanKey = typeof key === 'string' ? key.trim() : '';
          if (!ALLOWED_SETTING_KEYS.has(cleanKey) || val === undefined || val === null) {
            continue;
          }
          const strVal = String(val).trim();
          if (strVal.includes('\0')) {
            throw new Error(`Invalid null byte in setting '${cleanKey}'.`);
          }
          if (cleanKey === 'storage_directory' || cleanKey === 'thumbnail_directory') {
            const resolved = path.resolve(strVal);
            ensureDir(resolved);
            fs.accessSync(resolved, fs.constants.W_OK);
            stmt.run(cleanKey, resolved, now);
          } else {
            stmt.run(cleanKey, strVal, now);
          }
          updatedKeys.push(cleanKey);
        }
      });
      tx();
    } catch (err) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: err instanceof Error ? err.message : 'Invalid settings configuration.',
      });
      return;
    }

    if (updatedKeys.length > 0) {
      writeAuditLog({
        action: 'SETTINGS_UPDATED',
        resourceType: 'app_settings',
        details: `Updated settings: ${updatedKeys.join(', ')}`,
      });
    }

    res.json(getSettingsMap());
  });

  // Global Express error handler (handles Multer large-file & invalid-file errors cleanly)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR';
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Video file exceeds the maximum Stage 1 upload size limit (1 GB).'
          : err.message;
      writeAuditLog({
        action: 'VIDEO_UPLOAD_FAILED',
        resourceType: 'video_file',
        details: msg,
        outcome: 'error',
      });
      res.status(status).json({ error: code, message: msg });
      return;
    }

    const typedErr = err as { statusCode?: number; code?: string; message?: string };
    const status = typeof typedErr?.statusCode === 'number' ? typedErr.statusCode : 500;
    const code = typeof typedErr?.code === 'string' ? typedErr.code : 'INTERNAL_ERROR';
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    writeRuntimeLog('ERROR', `${code}: ${message}`);
    res.status(status).json({ error: code, message });
  });

  // Mount Vite middleware (development) or static dist/ (production)
  if (!options.skipVite) {
    if (process.env.NODE_ENV === 'production') {
      const distDir = path.resolve(__dirname, 'dist');
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    }
  }

  return { app, db, writeRuntimeLog, streamManager, getConfiguredDirectories };
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectExecution) {
  const port = Number(process.env.PORT || 3000);
  const { app, db, writeRuntimeLog, streamManager, getConfiguredDirectories } = await createLumaFluxApp();

  const server = app.listen(port, '0.0.0.0', () => {
    writeRuntimeLog('INFO', `LumaFlux Intelligence server listening on http://0.0.0.0:${port}`);
    console.log(`LumaFlux Intelligence listening on http://0.0.0.0:${port}`);
  });

  const shutdown = async (signal: string) => {
    writeRuntimeLog('INFO', `Received ${signal}; shutting down LumaFlux Intelligence server`);
    await streamManager.shutdownAll(getConfiguredDirectories().activeThumb);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
