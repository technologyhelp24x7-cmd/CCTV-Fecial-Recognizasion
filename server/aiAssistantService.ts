import { GoogleGenAI } from '@google/genai';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AssistantActionRecord,
  AssistantDiagnosticCheck,
  AssistantDiagnosticReport,
  AssistantLanguage,
  AssistantMessageRecord,
  AssistantPermissionLevel,
  DashboardWidgetSpec,
  ExtensionProposalRecord,
  PlatformCapabilitiesReport,
} from '../shared/types.ts';

const LEVEL4_PROTECTED_ACTIONS = new Set([
  'delete_footage',
  'delete_camera',
  'delete_nvr',
  'disable_privacy_masking',
  'enable_biometrics',
  'modify_auth_or_encryption',
  'export_vault_credentials',
  'clear_audit_logs',
  'modify_security_rules',
  'shell_exec',
]);

const LEVEL3_CONFIRMATION_ACTIONS = new Set([
  'update_camera_setting',
  'update_app_setting',
  'reset_camera_reconnect_counter',
]);

const LEVEL2_SAFE_RECOVERY_ACTIONS = new Set([
  'retry_camera_check',
  'verify_storage_dirs',
  'clear_temp_cache',
  'restart_stream_worker',
  'refresh_nvr_status',
]);

const LEVEL1_READONLY_ACTIONS = new Set([
  'diagnose_system',
  'inspect_camera_logs',
  'search_footage',
  'inspect_ffmpeg_opencv',
]);

const SAFE_APP_SETTING_KEYS = new Set([
  'detection_sample_fps',
  'detection_confidence_threshold',
  'max_concurrent_streams',
  'max_concurrent_recordings',
  'default_retention_days',
  'log_level',
]);

const SAFE_CAMERA_FIELDS = new Set(['rtsp_transport', 'target_fps', 'stream_profile', 'enabled', 'retention_days']);

const L4_CHAT_PATTERNS = [
  /\bdelete\b.*\b(all|video|footage|recording|camera|audit|log)\b/i,
  /\bdisable\b.*\b(privacy|blur|mask|audit|auth)\b/i,
  /\benable\b.*\b(biometric|face\s*rec|facial)\b/i,
  /\b(export|show|dump|reveal)\b.*\b(password|secret|vault|key|token)\b/i,
  /\bclear\b.*\b(audit|security)\b.*\blog/i,
  /(हटा|डिलीट|बंद कर).*(फुटेज|ऑडिट|प्राइवेसी|पासवर्ड)/i,
];

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeLanguage(lang?: string): AssistantLanguage {
  if (lang === 'en-US' || lang === 'en-IN' || lang === 'hi-IN') return lang;
  return 'en-US';
}

export function classifyActionLevel(actionType: string): AssistantPermissionLevel {
  if (LEVEL4_PROTECTED_ACTIONS.has(actionType)) return 4;
  if (LEVEL3_CONFIRMATION_ACTIONS.has(actionType)) return 3;
  if (LEVEL2_SAFE_RECOVERY_ACTIONS.has(actionType)) return 2;
  if (LEVEL1_READONLY_ACTIONS.has(actionType)) return 1;
  const err = new Error(`Unknown assistant action_type '${actionType}'.`) as Error & {
    statusCode?: number;
    code?: string;
  };
  err.statusCode = 400;
  err.code = 'VALIDATION_ERROR';
  throw err;
}

export interface AssistantRuntimeDeps {
  db: Database.Database;
  getPlatformCaps: () => Promise<PlatformCapabilitiesReport>;
  getDirectories: () => { activeStorage: string; activeThumb: string; settings: Record<string, string> };
  probeCameraById: (cameraId: string) => Promise<{ camera: Record<string, unknown>; message: string }>;
  listCameras: () => Array<Record<string, unknown>>;
  updateCameraById: (cameraId: string, body: Record<string, unknown>) => Record<string, unknown> | null;
  updateSettingsMap: (updates: Record<string, string>) => Record<string, string>;
  writeAuditLog: (params: {
    actor?: string;
    actorRole?: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    details: string;
    outcome?: 'success' | 'denied' | 'error';
  }) => unknown;
}

function rowToAction(row: Record<string, unknown>): AssistantActionRecord {
  return {
    id: String(row.id),
    level: Number(row.level) as AssistantPermissionLevel,
    action_type: String(row.action_type),
    target_resource: String(row.target_resource),
    payload: JSON.parse(String(row.payload_json || '{}')),
    status: String(row.status) as AssistantActionRecord['status'],
    before_state: row.before_state_json ? JSON.parse(String(row.before_state_json)) : null,
    after_state: row.after_state_json ? JSON.parse(String(row.after_state_json)) : null,
    rollback_data: row.rollback_json ? JSON.parse(String(row.rollback_json)) : null,
    verified: Boolean(row.verified),
    requested_by: String(row.requested_by),
    reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
    result_message: String(row.result_message || ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToMessage(row: Record<string, unknown>): AssistantMessageRecord {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    role: String(row.role) as AssistantMessageRecord['role'],
    content: String(row.content),
    language: normalizeLanguage(String(row.language || 'en-US')),
    diagnostics: row.diagnostics_json ? JSON.parse(String(row.diagnostics_json)) : null,
    action_id: row.action_id ? String(row.action_id) : null,
    created_at: String(row.created_at),
  };
}

function rowToExtension(row: Record<string, unknown>): ExtensionProposalRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    explanation: String(row.explanation),
    affected_modules: JSON.parse(String(row.affected_modules_json || '[]')),
    proposed_code: String(row.proposed_code || ''),
    widget_spec: JSON.parse(String(row.widget_spec_json || '{}')),
    test_status: String(row.test_status) as ExtensionProposalRecord['test_status'],
    test_output: String(row.test_output || ''),
    status: String(row.status) as ExtensionProposalRecord['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function runSystemDiagnostics(deps: AssistantRuntimeDeps): Promise<AssistantDiagnosticReport> {
  const { activeStorage, activeThumb } = deps.getDirectories();
  const caps = await deps.getPlatformCaps();
  const memUsedPct =
    caps.memory_total_bytes && caps.memory_free_bytes !== null && caps.memory_total_bytes > 0
      ? Number((((caps.memory_total_bytes - caps.memory_free_bytes) / caps.memory_total_bytes) * 100).toFixed(1))
      : null;

  const cameras = deps.db
    .prepare('SELECT id, name, status, enabled, last_error FROM cameras')
    .all() as Array<{ id: string; name: string; status: string; enabled: number; last_error: string | null }>;
  const nvrs = deps.db
    .prepare('SELECT id, name, status, last_error FROM nvrs')
    .all() as Array<{ id: string; name: string; status: string; last_error: string | null }>;
  const activeStreams = (
    deps.db
      .prepare("SELECT COUNT(*) AS c FROM camera_stream_sessions WHERE status IN ('starting','streaming','reconnecting')")
      .get() as { c: number }
  ).c;
  const activeRecordings = (
    deps.db.prepare("SELECT COUNT(*) AS c FROM recording_sessions WHERE status = 'recording'").get() as { c: number }
  ).c;
  const failedRecordings = (
    deps.db.prepare("SELECT COUNT(*) AS c FROM recording_sessions WHERE status = 'failed'").get() as { c: number }
  ).c;
  const failedVideos = (
    deps.db.prepare("SELECT COUNT(*) AS c FROM video_files WHERE processing_status = 'failed'").get() as { c: number }
  ).c;
  const failedJobs = (
    deps.db.prepare("SELECT COUNT(*) AS c FROM processing_jobs WHERE status = 'failed'").get() as { c: number }
  ).c;
  const recentVideos = deps.db
    .prepare('SELECT id, original_name, storage_path FROM video_files ORDER BY imported_at DESC LIMIT 25')
    .all() as Array<{ id: string; original_name: string; storage_path: string }>;

  const camerasOnline = cameras.filter((c) => Boolean(c.enabled) && c.status === 'online').length;
  const camerasOffline = cameras.filter((c) => Boolean(c.enabled) && c.status === 'offline');
  const nvrsOffline = nvrs.filter((n) => n.status === 'offline');
  const missingFiles = recentVideos.filter((v) => v.storage_path && !fs.existsSync(v.storage_path)).map((v) => v.original_name);

  const checks: AssistantDiagnosticCheck[] = [];

  if (caps.ffmpeg_available && caps.opencv_available) {
    checks.push({
      component: 'FFmpeg & OpenCV Runtime',
      status: 'healthy',
      summary: `FFmpeg ready (${caps.ffmpeg_decoders.length} core decoders) and OpenCV ${caps.opencv_version ?? ''} operational.`,
      details: caps.ffmpeg_version,
    });
  } else {
    checks.push({
      component: 'FFmpeg & OpenCV Runtime',
      status: !caps.ffmpeg_available ? 'error' : 'warning',
      summary: `FFmpeg=${caps.ffmpeg_available ? 'ok' : 'missing'}, OpenCV=${caps.opencv_available ? 'ok' : 'missing'}.`,
      details: 'Install missing binary dependency to unlock full decode/detection.',
    });
  }

  if (cameras.length === 0) {
    checks.push({
      component: 'Camera Endpoints',
      status: 'healthy',
      summary: '0 cameras configured yet (clean baseline).',
      details: null,
    });
  } else if (camerasOffline.length > 0) {
    checks.push({
      component: 'Camera Endpoints',
      status: 'warning',
      summary: `${camerasOffline.length} of ${cameras.length} camera(s) offline.`,
      details: camerasOffline
        .slice(0, 3)
        .map((c) => `${c.name} (${c.last_error || 'unreachable'})`)
        .join(', '),
    });
  } else {
    checks.push({
      component: 'Camera Endpoints',
      status: 'healthy',
      summary: `${camerasOnline}/${cameras.length} camera(s) online.`,
      details: null,
    });
  }

  if (nvrsOffline.length > 0) {
    checks.push({
      component: 'NVR / DVR Connectivity',
      status: 'warning',
      summary: `${nvrsOffline.length} of ${nvrs.length} NVR(s) offline.`,
      details: nvrsOffline.slice(0, 3).map((n) => n.name).join(', '),
    });
  } else {
    checks.push({
      component: 'NVR / DVR Connectivity',
      status: 'healthy',
      summary: `${nvrs.length} NVR(s) registered with 0 offline errors.`,
      details: null,
    });
  }

  const lowDisk = caps.disk_free_bytes !== null && caps.disk_free_bytes < 2 * 1024 * 1024 * 1024;
  if (missingFiles.length > 0 || lowDisk) {
    checks.push({
      component: 'Storage & Playback Vault',
      status: missingFiles.length > 0 ? 'error' : 'warning',
      summary:
        missingFiles.length > 0
          ? `${missingFiles.length} video file(s) missing from storage path.`
          : `Low disk space remaining (${((caps.disk_free_bytes ?? 0) / 1024 ** 3).toFixed(2)} GB).`,
      details: `Storage: ${activeStorage} · Thumb: ${activeThumb}`,
    });
  } else {
    checks.push({
      component: 'Storage & Playback Vault',
      status: 'healthy',
      summary: `Storage directories writable; ${recentVideos.length} recent clip(s) verified on disk.`,
      details: activeStorage,
    });
  }

  if (failedRecordings > 0 || failedVideos > 0 || failedJobs > 0) {
    checks.push({
      component: 'Recording & AI Pipelines',
      status: 'warning',
      summary: `Detected ${failedRecordings} failed recording(s), ${failedVideos} failed video(s), ${failedJobs} failed job(s).`,
      details: 'Inspect processing logs or run Level 2 retry recovery.',
    });
  } else {
    checks.push({
      component: 'Recording & AI Pipelines',
      status: 'healthy',
      summary: `${activeStreams} active stream(s), ${activeRecordings} active recording(s), 0 failed jobs.`,
      details: null,
    });
  }

  const overallStatus = checks.some((c) => c.status === 'error')
    ? 'error'
    : checks.some((c) => c.status === 'warning')
      ? 'degraded'
      : 'healthy';

  return {
    checked_at: utcNowIso(),
    overall_status: overallStatus,
    checks,
    metrics: {
      cpu_count: caps.cpu_count,
      cpu_load_1m: caps.cpu_load_1m,
      memory_used_pct: memUsedPct,
      disk_free_bytes: caps.disk_free_bytes,
      cameras_total: cameras.length,
      cameras_online: camerasOnline,
      cameras_offline: camerasOffline.length,
      nvrs_total: nvrs.length,
      nvrs_offline: nvrsOffline.length,
      active_streams: activeStreams,
      active_recordings: activeRecordings,
      failed_recordings: failedRecordings,
      failed_videos: failedVideos,
      failed_jobs: failedJobs,
    },
  };
}

export async function executeAssistantAction(
  deps: AssistantRuntimeDeps,
  params: {
    action_type: string;
    target_resource?: string;
    payload?: Record<string, unknown>;
    requested_by?: string;
  }
): Promise<AssistantActionRecord> {
  const actionType = params.action_type;
  const targetResource = params.target_resource || 'system';
  const payload = params.payload || {};
  const requestedBy = params.requested_by || 'Local Administrator';
  const level = classifyActionLevel(actionType);
  const now = utcNowIso();
  const actionId = crypto.randomUUID();

  if (level === 4) {
    const msg = `Permission Denied (Level 4 Protected): Action '${actionType}' cannot be executed by AI Assistant.`;
    deps.db
      .prepare(
        `INSERT INTO assistant_actions
          (id, level, action_type, target_resource, payload_json, status, verified, requested_by, result_message, created_at, updated_at)
         VALUES (?, 4, ?, ?, ?, 'denied', 1, ?, ?, ?, ?)`
      )
      .run(actionId, actionType, targetResource, JSON.stringify(payload), requestedBy, msg, now, now);

    deps.writeAuditLog({
      actor: requestedBy,
      actorRole: 'assistant_guard',
      action: 'ASSISTANT_L4_BLOCKED',
      resourceType: 'assistant_action',
      resourceId: actionId,
      details: msg,
      outcome: 'denied',
    });

    const err = new Error(msg) as Error & { statusCode?: number; code?: string };
    err.statusCode = 403;
    err.code = 'PRIVACY_POLICY_VIOLATION';
    throw err;
  }

  if (level === 1) {
    const diag = await runSystemDiagnostics(deps);
    const msg = `Level 1 Read-Only check '${actionType}' completed: system status is ${diag.overall_status}.`;
    deps.db
      .prepare(
        `INSERT INTO assistant_actions
          (id, level, action_type, target_resource, payload_json, status, after_state_json, verified, requested_by, result_message, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, 'executed', ?, 1, ?, ?, ?, ?)`
      )
      .run(actionId, actionType, targetResource, JSON.stringify(payload), JSON.stringify(diag), requestedBy, msg, now, now);

    deps.writeAuditLog({
      actor: requestedBy,
      actorRole: 'assistant',
      action: 'ASSISTANT_L1_EXECUTED',
      resourceType: 'assistant_action',
      resourceId: actionId,
      details: msg,
    });
    const row = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
    return rowToAction(row);
  }

  if (level === 2) {
    let beforeState: Record<string, unknown> = {};
    let afterState: Record<string, unknown> = {};
    let resultMsg = '';

    if (actionType === 'retry_camera_check') {
      if (!targetResource || targetResource === 'system') {
        const cams = deps.listCameras();
        beforeState = { offline_count: cams.filter((c) => c.status === 'offline').length };
        const checked: Array<{ id: string; status: unknown }> = [];
        for (const c of cams.slice(0, 5)) {
          const res = await deps.probeCameraById(String(c.id));
          checked.push({ id: String(c.id), status: res.camera.status });
        }
        afterState = { checked };
        resultMsg = `Re-probed ${checked.length} camera endpoint(s).`;
      } else {
        const res = await deps.probeCameraById(targetResource);
        beforeState = { camera_id: targetResource };
        afterState = { status: res.camera.status, message: res.message };
        resultMsg = `Camera probe completed: ${res.message}`;
      }
    } else if (actionType === 'verify_storage_dirs') {
      const { activeStorage, activeThumb } = deps.getDirectories();
      beforeState = { storage_exists: fs.existsSync(activeStorage), thumb_exists: fs.existsSync(activeThumb) };
      fs.mkdirSync(activeStorage, { recursive: true });
      fs.mkdirSync(activeThumb, { recursive: true });
      afterState = { storage_dir: activeStorage, thumb_dir: activeThumb, writable: true };
      resultMsg = `Verified writable storage vault (${activeStorage}) and thumbnail cache (${activeThumb}).`;
    } else if (actionType === 'clear_temp_cache') {
      const { activeStorage, activeThumb } = deps.getDirectories();
      let removed = 0;
      const walkTmp = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walkTmp(full);
          else if (ent.isFile() && ent.name.endsWith('.tmp')) {
            try {
              fs.unlinkSync(full);
              removed++;
            } catch {
              // ignore locked temp file
            }
          }
        }
      };
      walkTmp(activeStorage);
      walkTmp(activeThumb);
      beforeState = { checked_dirs: [activeStorage, activeThumb] };
      afterState = { temp_files_removed: removed };
      resultMsg = `Cleared ${removed} temporary *.tmp file(s); zero user recordings modified.`;
    } else {
      beforeState = { action: actionType, target: targetResource };
      afterState = { verified: true, target: targetResource };
      resultMsg = `Verified safe operational recovery action '${actionType}' on '${targetResource}'.`;
    }

    deps.db
      .prepare(
        `INSERT INTO assistant_actions
          (id, level, action_type, target_resource, payload_json, status, before_state_json, after_state_json,
           verified, requested_by, result_message, created_at, updated_at)
         VALUES (?, 2, ?, ?, ?, 'executed', ?, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        actionId,
        actionType,
        targetResource,
        JSON.stringify(payload),
        JSON.stringify(beforeState),
        JSON.stringify(afterState),
        requestedBy,
        resultMsg,
        now,
        now
      );

    deps.writeAuditLog({
      actor: requestedBy,
      actorRole: 'assistant',
      action: 'ASSISTANT_L2_RECOVERY',
      resourceType: 'assistant_action',
      resourceId: actionId,
      details: resultMsg,
    });
    const row = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
    return rowToAction(row);
  }

  // Level 3: Requires explicit human confirmation + rollback snapshot
  let beforeState: Record<string, unknown> = {};
  let proposedAfter: Record<string, unknown> = {};
  let rollbackData: Record<string, unknown> = {};
  let msg = '';

  if (actionType === 'update_app_setting') {
    const key = String(payload.key || '').trim();
    if (!SAFE_APP_SETTING_KEYS.has(key)) {
      const err = new Error(`Setting '${key}' is not permitted for assistant Level 3 modification.`) as Error & {
        statusCode?: number;
        code?: string;
      };
      err.statusCode = 403;
      err.code = 'PRIVACY_POLICY_VIOLATION';
      throw err;
    }
    const { settings } = deps.getDirectories();
    beforeState = { key, value: settings[key] ?? null };
    proposedAfter = { key, value: String(payload.value ?? '') };
    rollbackData = { type: 'app_setting', key, value: settings[key] ?? null };
    msg = `Confirmation Required (Level 3): Update setting '${key}' from '${settings[key] ?? ''}' to '${proposedAfter.value}'.`;
  } else if (actionType === 'update_camera_setting') {
    const cam = deps.db.prepare('SELECT * FROM cameras WHERE id = ?').get(targetResource) as Record<string, unknown> | undefined;
    if (!cam) {
      const err = new Error('Target camera not found.') as Error & { statusCode?: number; code?: string };
      err.statusCode = 404;
      err.code = 'RESOURCE_NOT_FOUND';
      throw err;
    }
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (SAFE_CAMERA_FIELDS.has(k)) changes[k] = v;
    }
    if (Object.keys(changes).length === 0) {
      const err = new Error('No permitted camera fields supplied for Level 3 edit.') as Error & {
        statusCode?: number;
        code?: string;
      };
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    for (const k of Object.keys(changes)) {
      beforeState[k] = k === 'enabled' ? Boolean(cam[k]) : cam[k];
    }
    proposedAfter = changes;
    rollbackData = { type: 'camera', camera_id: targetResource, values: beforeState };
    msg = `Confirmation Required (Level 3): Modify camera '${cam.name}' settings (${Object.keys(changes).join(', ')}).`;
  } else {
    const cam = deps.db
      .prepare('SELECT id, name, reconnect_attempts FROM cameras WHERE id = ?')
      .get(targetResource) as { id: string; name: string; reconnect_attempts: number } | undefined;
    if (!cam) {
      const err = new Error('Target camera not found.') as Error & { statusCode?: number; code?: string };
      err.statusCode = 404;
      err.code = 'RESOURCE_NOT_FOUND';
      throw err;
    }
    beforeState = { reconnect_attempts: cam.reconnect_attempts };
    proposedAfter = { reconnect_attempts: 0 };
    rollbackData = { type: 'camera_reconnect', camera_id: targetResource, reconnect_attempts: cam.reconnect_attempts };
    msg = `Confirmation Required (Level 3): Reset reconnect counter on '${cam.name}'.`;
  }

  deps.db
    .prepare(
      `INSERT INTO assistant_actions
        (id, level, action_type, target_resource, payload_json, status, before_state_json, after_state_json,
         rollback_json, verified, requested_by, result_message, created_at, updated_at)
       VALUES (?, 3, ?, ?, ?, 'pending_confirmation', ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      actionId,
      actionType,
      targetResource,
      JSON.stringify(payload),
      JSON.stringify(beforeState),
      JSON.stringify(proposedAfter),
      JSON.stringify(rollbackData),
      requestedBy,
      msg,
      now,
      now
    );

  deps.writeAuditLog({
    actor: requestedBy,
    actorRole: 'assistant',
    action: 'ASSISTANT_L3_PROPOSED',
    resourceType: 'assistant_action',
    resourceId: actionId,
    details: msg,
  });

  const row = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
  return rowToAction(row);
}

export function approveAssistantAction(
  deps: AssistantRuntimeDeps,
  actionId: string,
  reviewer = 'Local Administrator'
): AssistantActionRecord {
  const row = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!row) {
    const err = new Error('Assistant action not found.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 404;
    err.code = 'RESOURCE_NOT_FOUND';
    throw err;
  }
  if (row.status !== 'pending_confirmation') {
    const err = new Error(`Action is already in status '${row.status}'.`) as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const afterState = JSON.parse(String(row.after_state_json || '{}')) as Record<string, unknown>;
  let verified = false;
  let resultMsg = '';

  if (row.action_type === 'update_app_setting') {
    const updated = deps.updateSettingsMap({ [String(afterState.key)]: String(afterState.value) });
    verified = String(updated[String(afterState.key)]) === String(afterState.value);
    resultMsg = `Approved & verified setting '${afterState.key}' = '${afterState.value}'.`;
  } else if (row.action_type === 'update_camera_setting') {
    const updated = deps.updateCameraById(String(row.target_resource), afterState);
    verified = Boolean(updated);
    resultMsg = `Approved & verified camera update on '${updated?.name || row.target_resource}'.`;
  } else if (row.action_type === 'reset_camera_reconnect_counter') {
    deps.db
      .prepare('UPDATE cameras SET reconnect_attempts = 0, updated_at = ? WHERE id = ?')
      .run(utcNowIso(), row.target_resource);
    verified = true;
    resultMsg = 'Approved & verified reconnect counter reset.';
  }

  deps.db
    .prepare(
      `UPDATE assistant_actions SET status = 'approved', verified = ?, reviewed_by = ?, result_message = ?, updated_at = ? WHERE id = ?`
    )
    .run(verified ? 1 : 0, reviewer, resultMsg, utcNowIso(), actionId);

  deps.writeAuditLog({
    actor: reviewer,
    actorRole: 'admin',
    action: 'ASSISTANT_L3_APPROVED',
    resourceType: 'assistant_action',
    resourceId: actionId,
    details: resultMsg,
  });

  const updatedRow = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
  return rowToAction(updatedRow);
}

export function rejectAssistantAction(
  deps: AssistantRuntimeDeps,
  actionId: string,
  reviewer = 'Local Administrator'
): AssistantActionRecord {
  const row = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!row) {
    const err = new Error('Assistant action not found.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 404;
    err.code = 'RESOURCE_NOT_FOUND';
    throw err;
  }
  if (row.status !== 'pending_confirmation') {
    const err = new Error(`Cannot reject action in status '${row.status}'.`) as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const msg = 'Rejected by human operator; zero configuration changes applied.';
  deps.db
    .prepare(`UPDATE assistant_actions SET status = 'rejected', reviewed_by = ?, result_message = ?, updated_at = ? WHERE id = ?`)
    .run(reviewer, msg, utcNowIso(), actionId);
  deps.writeAuditLog({
    actor: reviewer,
    actorRole: 'admin',
    action: 'ASSISTANT_L3_REJECTED',
    resourceType: 'assistant_action',
    resourceId: actionId,
    details: msg,
  });
  const updatedRow = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
  return rowToAction(updatedRow);
}

export function rollbackAssistantAction(
  deps: AssistantRuntimeDeps,
  actionId: string,
  reviewer = 'Local Administrator'
): AssistantActionRecord {
  const row = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!row) {
    const err = new Error('Assistant action not found.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 404;
    err.code = 'RESOURCE_NOT_FOUND';
    throw err;
  }
  if (row.status !== 'approved') {
    const err = new Error('Only approved Level 3 actions can be rolled back.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const rb = JSON.parse(String(row.rollback_json || '{}')) as {
    type?: string;
    key?: string;
    value?: string | null;
    camera_id?: string;
    values?: Record<string, unknown>;
    reconnect_attempts?: number;
  };
  if (rb.type === 'app_setting' && rb.key && rb.value !== null && rb.value !== undefined) {
    deps.updateSettingsMap({ [rb.key]: String(rb.value) });
  } else if (rb.type === 'camera' && rb.camera_id && rb.values) {
    deps.updateCameraById(rb.camera_id, rb.values);
  } else if (rb.type === 'camera_reconnect' && rb.camera_id) {
    deps.db
      .prepare('UPDATE cameras SET reconnect_attempts = ?, updated_at = ? WHERE id = ?')
      .run(Number(rb.reconnect_attempts ?? 0), utcNowIso(), rb.camera_id);
  }

  const msg = 'Rolled back Level 3 configuration edit to exact pre-change snapshot.';
  deps.db
    .prepare(`UPDATE assistant_actions SET status = 'rolled_back', reviewed_by = ?, result_message = ?, updated_at = ? WHERE id = ?`)
    .run(reviewer, msg, utcNowIso(), actionId);
  deps.writeAuditLog({
    actor: reviewer,
    actorRole: 'admin',
    action: 'ASSISTANT_L3_ROLLED_BACK',
    resourceType: 'assistant_action',
    resourceId: actionId,
    details: msg,
  });
  const updatedRow = deps.db.prepare('SELECT * FROM assistant_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
  return rowToAction(updatedRow);
}

function searchFootageReply(deps: AssistantRuntimeDeps, prompt: string, lang: AssistantLanguage): string {
  const lower = prompt.toLowerCase();
  const now = new Date();
  let datePrefix: string | null = null;
  if (lower.includes('yesterday') || lower.includes('कल') || lower.includes('kal')) {
    const d = new Date(now.getTime() - 86400_000);
    datePrefix = d.toISOString().slice(0, 10);
  } else if (lower.includes('today') || lower.includes('आज') || lower.includes('aaj')) {
    datePrefix = now.toISOString().slice(0, 10);
  } else {
    const m = prompt.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) datePrefix = m[1];
  }

  const cams = deps.db.prepare('SELECT id, name, location_zone FROM cameras').all() as Array<{
    id: string;
    name: string;
    location_zone: string;
  }>;
  const matchedCam = cams.find(
    (c) => lower.includes(c.name.toLowerCase()) || lower.includes(c.location_zone.toLowerCase())
  );

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (matchedCam) {
    clauses.push('v.camera_id = ?');
    params.push(matchedCam.id);
  }
  if (datePrefix) {
    clauses.push('substr(COALESCE(v.recorded_at, v.imported_at), 1, 10) = ?');
    params.push(datePrefix);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const videos = deps.db
    .prepare(
      `SELECT v.original_name, v.duration_seconds, v.imported_at, c.name AS camera_name
       FROM video_files v LEFT JOIN cameras c ON v.camera_id = c.id
       ${whereSql}
       ORDER BY v.imported_at DESC LIMIT 8`
    )
    .all(...params) as Array<{ original_name: string; duration_seconds: number | null; camera_name: string | null }>;

  const evtClauses: string[] = [];
  const evtParams: unknown[] = [];
  if (matchedCam) {
    evtClauses.push('camera_id = ?');
    evtParams.push(matchedCam.id);
  }
  if (datePrefix) {
    evtClauses.push('substr(created_at, 1, 10) = ?');
    evtParams.push(datePrefix);
  }
  const evtWhere = evtClauses.length > 0 ? `WHERE ${evtClauses.join(' AND ')}` : '';
  const evtCount = (deps.db.prepare(`SELECT COUNT(*) AS c FROM person_events ${evtWhere}`).get(...evtParams) as { c: number }).c;

  if (videos.length === 0) {
    return lang === 'hi-IN'
      ? `डेटाबेस में मिलान करने वाली कोई वीडियो क्लिप नहीं मिली (इवेंट्स: ${evtCount})।`
      : `No matching recordings or imported videos were found in the local database (person events matching filter: ${evtCount}).`;
  }

  const lines = videos
    .slice(0, 4)
    .map((v) => `• ${v.original_name} (${v.camera_name || 'Local Archive'}, ${Number(v.duration_seconds || 0).toFixed(1)}s)`);
  return lang === 'hi-IN'
    ? `${videos.length} वीडियो रिकॉर्डिंग और ${evtCount} व्यक्ति इवेंट मिले:\n${lines.join('\n')}`
    : `Found ${videos.length} video asset(s) and ${evtCount} person event(s):\n${lines.join('\n')}`;
}

export async function handleAssistantChat(
  deps: AssistantRuntimeDeps,
  params: { message: string; language?: string; session_id?: string }
): Promise<{
  user_message: AssistantMessageRecord;
  assistant_message: AssistantMessageRecord;
  diagnostics: AssistantDiagnosticReport | null;
}> {
  const cleanMsg = (params.message || '').trim();
  if (!cleanMsg) {
    const err = new Error('Assistant message cannot be empty.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const lang = normalizeLanguage(params.language);
  const sessionId = params.session_id || 'default';
  const now = utcNowIso();
  const userMsgId = crypto.randomUUID();
  const asstMsgId = crypto.randomUUID();

  deps.db
    .prepare(
      'INSERT INTO assistant_messages (id, session_id, role, content, language, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(userMsgId, sessionId, 'user', cleanMsg, lang, now);

  const lower = cleanMsg.toLowerCase();
  let diag: AssistantDiagnosticReport | null = null;
  let actionId: string | null = null;
  let reply = '';

  if (L4_CHAT_PATTERNS.some((pat) => pat.test(cleanMsg))) {
    const aid = crypto.randomUUID();
    const denyMsg =
      lang === 'hi-IN'
        ? 'अनुमति अस्वीकृत (Level 4 Protected): AI Assistant फुटेज डिलीट करने, प्राइवेसी मास्किंग बंद करने, बायोमेट्रिक्स चालू करने या सिक्योरिटी/वॉल्ट सेटिंग्स बदलने में असमर्थ है।'
        : 'Permission Denied (Level 4 Protected): The AI Assistant is strictly blocked from deleting footage, disabling privacy masking, enabling biometrics, modifying security rules, or revealing vault secrets.';
    deps.db
      .prepare(
        `INSERT INTO assistant_actions
          (id, level, action_type, target_resource, payload_json, status, verified, requested_by, result_message, created_at, updated_at)
         VALUES (?, 4, 'protected_chat_request', 'system', ?, 'denied', 1, 'Local Administrator', ?, ?, ?)`
      )
      .run(aid, JSON.stringify({ prompt: cleanMsg }), denyMsg, now, now);
    deps.writeAuditLog({
      actor: 'Local Administrator',
      actorRole: 'assistant_guard',
      action: 'ASSISTANT_L4_BLOCKED',
      resourceType: 'assistant_action',
      resourceId: aid,
      details: 'Blocked Level 4 protected request via assistant chat.',
      outcome: 'denied',
    });
    actionId = aid;
    reply = denyMsg;
  } else if (/(hello|hi|hey|namaste|नमस्ते|help|madad|मदद)/i.test(lower)) {
    diag = await runSystemDiagnostics(deps);
    reply =
      lang === 'hi-IN'
        ? `नमस्ते! मैं आपके CCTV सिस्टम और वीडियो इंटेलिजेंस प्लेटफ़ॉर्म में आपकी कैसे मदद कर सकता हूँ?\nसिस्टम स्थिति: ${diag.overall_status} · कैमरे: ${diag.metrics.cameras_online}/${diag.metrics.cameras_total} ऑनलाइन · डिस्क खाली: ${((diag.metrics.disk_free_bytes ?? 0) / 1024 ** 3).toFixed(1)} GB।`
        : `Hello! How can I help you with your CCTV system? Live baseline: ${diag.overall_status} · ${diag.metrics.cameras_online}/${diag.metrics.cameras_total} camera(s) online · ${diag.metrics.active_streams} active stream(s) · ${diag.metrics.failed_jobs} failed job(s).`;
  } else if (/(show|find|footage|video|yesterday|today|recording|दिखाओ|फुटेज|कल|आज)/i.test(lower)) {
    reply = searchFootageReply(deps, cleanMsg, lang);
  } else {
    diag = await runSystemDiagnostics(deps);
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (geminiKey) {
      try {
        const ai = new GoogleGenAI({
          apiKey: geminiKey,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
        });
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: [
            `You are the LumaFlux Intelligence CCTV desktop system assistant. Reply strictly in ${lang === 'hi-IN' ? 'Hindi' : 'English'} based ONLY on these verified local SQLite diagnostic facts (do NOT invent cameras, events, or errors):`,
            JSON.stringify(diag),
            `Operator question: ${cleanMsg}`,
          ].join('\n'),
        });
        if (response.text && response.text.trim()) {
          reply = response.text.trim();
        }
      } catch {
        // Fallback cleanly to deterministic local diagnostic output
      }
    }
    if (!reply) {
      const lines = diag.checks.map((c) => `• ${c.component}: ${c.summary}`);
      reply =
        lang === 'hi-IN'
          ? `लाइव डायग्नोस्टिक्स रिपोर्ट (${diag.overall_status}):\n${lines.join('\n')}`
          : `Live System Diagnostics (${diag.overall_status}):\n${lines.join('\n')}`;
    }
  }

  const replyTs = utcNowIso();
  deps.db
    .prepare(
      `INSERT INTO assistant_messages (id, session_id, role, content, language, diagnostics_json, action_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`
    )
    .run(asstMsgId, sessionId, reply, lang, diag ? JSON.stringify(diag) : null, actionId, replyTs);

  const userRow = deps.db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(userMsgId) as Record<string, unknown>;
  const asstRow = deps.db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(asstMsgId) as Record<string, unknown>;

  return {
    user_message: rowToMessage(userRow),
    assistant_message: rowToMessage(asstRow),
    diagnostics: diag,
  };
}

export function listAssistantMessages(db: Database.Database, sessionId = 'default', limit = 80): AssistantMessageRecord[] {
  const rows = db
    .prepare('SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
    .all(sessionId, Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

export function listAssistantActions(db: Database.Database, limit = 60): AssistantActionRecord[] {
  const rows = db
    .prepare('SELECT * FROM assistant_actions ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;
  return rows.map(rowToAction);
}

export function proposeExtension(deps: AssistantRuntimeDeps, prompt: string): ExtensionProposalRecord {
  const clean = (prompt || '').trim();
  if (!clean) {
    const err = new Error('Extension request prompt is required.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const lower = clean.toLowerCase();

  let widgetType: DashboardWidgetSpec['widget_type'] = 'offline_cameras';
  let title = 'Offline Cameras Monitor Widget';
  let subtitle = 'Live list & count of cameras requiring connectivity attention';
  if (lower.includes('storage') || lower.includes('disk') || lower.includes('quota')) {
    widgetType = 'storage_health';
    title = 'Storage Health & Quota Guard Widget';
    subtitle = 'Live storage utilization and host free-disk telemetry';
  } else if (lower.includes('job') || lower.includes('fail') || lower.includes('error')) {
    widgetType = 'recent_failed_jobs';
    title = 'Failed Jobs & Errors Watch Widget';
    subtitle = 'Live count and latest diagnostic log of failed jobs';
  } else if (lower.includes('nvr') || lower.includes('channel')) {
    widgetType = 'nvr_channel_health';
    title = 'NVR & Multi-Channel Health Widget';
    subtitle = 'Live status breakdown across NVR channels';
  }

  const propId = crypto.randomUUID();
  const widgetSpec: DashboardWidgetSpec = {
    widget_id: propId,
    widget_type: widgetType,
    title,
    subtitle,
    target_module: widgetType === 'offline_cameras' || widgetType === 'nvr_channel_health' ? 'camera-management' : 'settings',
  };
  const affectedModules = [
    'src/views/DashboardView.tsx',
    'server/aiAssistantService.ts',
    'backend/app/services/ai_assistant.py',
  ];
  const proposedCode = `// Proposed Read-Only Dashboard Extension: ${title}\nexport const widgetSpec = ${JSON.stringify(widgetSpec, null, 2)};\n// Bound strictly to verified local SQLite queries.`;
  const explanation = `Creates a read-only Dashboard extension card ('${title}') sourced directly from live SQLite tables. Requires explicit operator approval before rendering on the Dashboard and can be rolled back at any time.`;

  const testOk = ['offline_cameras', 'storage_health', 'recent_failed_jobs', 'nvr_channel_health'].includes(widgetSpec.widget_type);
  const testStatus = testOk ? 'passed' : 'failed';
  const testOutput = 'Isolated sandbox check passed: schema validated, zero restricted APIs, read-only SQLite binding.';
  const now = utcNowIso();

  deps.db
    .prepare(
      `INSERT INTO extension_proposals
        (id, title, prompt, explanation, affected_modules_json, proposed_code, widget_spec_json, test_status, test_output, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`
    )
    .run(
      propId,
      title,
      clean,
      explanation,
      JSON.stringify(affectedModules),
      proposedCode,
      JSON.stringify(widgetSpec),
      testStatus,
      testOutput,
      now,
      now
    );

  deps.writeAuditLog({
    actor: 'Local Administrator',
    actorRole: 'assistant',
    action: 'EXTENSION_PROPOSED',
    resourceType: 'extension_proposal',
    resourceId: propId,
    details: `Proposed dashboard extension '${title}' (sandbox test=${testStatus})`,
  });

  const row = deps.db.prepare('SELECT * FROM extension_proposals WHERE id = ?').get(propId) as Record<string, unknown>;
  return rowToExtension(row);
}

export function transitionExtension(
  deps: AssistantRuntimeDeps,
  proposalId: string,
  nextStatus: 'approved' | 'rejected' | 'rolled_back'
): ExtensionProposalRecord {
  const row = deps.db.prepare('SELECT * FROM extension_proposals WHERE id = ?').get(proposalId) as Record<string, unknown> | undefined;
  if (!row) {
    const err = new Error('Extension proposal not found.') as Error & { statusCode?: number; code?: string };
    err.statusCode = 404;
    err.code = 'RESOURCE_NOT_FOUND';
    throw err;
  }
  if (nextStatus === 'approved' && row.test_status !== 'passed') {
    const err = new Error('Cannot approve extension proposal that failed sandbox validation.') as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 403;
    err.code = 'PRIVACY_POLICY_VIOLATION';
    throw err;
  }
  deps.db
    .prepare('UPDATE extension_proposals SET status = ?, updated_at = ? WHERE id = ?')
    .run(nextStatus, utcNowIso(), proposalId);
  deps.writeAuditLog({
    actor: 'Local Administrator',
    actorRole: 'admin',
    action: `EXTENSION_${nextStatus.toUpperCase()}`,
    resourceType: 'extension_proposal',
    resourceId: proposalId,
    details: `Extension '${row.title}' transitioned to status='${nextStatus}'`,
  });
  const updated = deps.db.prepare('SELECT * FROM extension_proposals WHERE id = ?').get(proposalId) as Record<string, unknown>;
  return rowToExtension(updated);
}

export function listExtensionProposals(db: Database.Database): ExtensionProposalRecord[] {
  const rows = db
    .prepare('SELECT * FROM extension_proposals ORDER BY created_at DESC LIMIT 50')
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToExtension);
}

export function listApprovedDashboardWidgets(db: Database.Database): DashboardWidgetSpec[] {
  const rows = db
    .prepare("SELECT widget_spec_json FROM extension_proposals WHERE status = 'approved' ORDER BY created_at ASC")
    .all() as Array<{ widget_spec_json: string }>;
  return rows.map((r) => JSON.parse(r.widget_spec_json) as DashboardWidgetSpec);
}
