import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  discoverLocalArchiveFiles,
  sanitizeLogText,
  verifyMp4DecodeIntegrity,
} from './cameraService.ts';
import type { CameraSourceType, RtspTransport } from '../shared/types.ts';

const execFileAsync = promisify(execFile);
const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MB cap per active worker

interface StreamWorkerHandle {
  sessionId: string;
  cameraId: string;
  sourceType: CameraSourceType;
  streamUri: string;
  rtspTransport: RtspTransport;
  sampleFps: number;
  targetWidth: number;
  maxReconnectAttempts: number;
  status: 'starting' | 'streaming' | 'reconnecting' | 'stopped' | 'error';
  framesCaptured: number;
  framesDropped: number;
  bytesReceived: number;
  avgFrameMs: number | null;
  lastFrameMonotonicMs: number | null;
  reconnectCount: number;
  lastFrameAt: string | null;
  errorMessage: string | null;
  latestFrame: Buffer | null;
  proc: ChildProcess | null;
  stopping: boolean;
  emitter: EventEmitter;
  reconnectTimer: NodeJS.Timeout | null;
}

interface RecordingWorkerHandle {
  sessionId: string;
  cameraId: string;
  cameraName: string;
  outputPath: string;
  proc: ChildProcess;
  startedAt: string;
  triggerMode: 'manual' | 'scheduled' | 'continuous';
  stderrTail: string;
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseWidth(resolution: string | null | undefined): number {
  if (!resolution) return 1280;
  const parsed = parseInt(String(resolution).toLowerCase().split('x')[0], 10);
  if (!Number.isFinite(parsed) || parsed < 320) return 1280;
  return Math.min(parsed, 1920);
}

function buildInputArgs(sourceType: CameraSourceType, rawUri: string, rtspTransport: RtspTransport = 'tcp'): string[] | null {
  if (sourceType === 'local_archive') {
    const files = discoverLocalArchiveFiles(rawUri);
    if (files.length === 0) return null;
    return ['-re', '-stream_loop', '-1', '-i', files[0]];
  }
  if (sourceType === 'rtsp' || (sourceType === 'onvif' && /^rtsps?:\/\//i.test(rawUri))) {
    return ['-rtsp_transport', rtspTransport === 'udp' ? 'udp' : 'tcp', '-i', rawUri];
  }
  return ['-i', rawUri];
}

export class LiveStreamAndRecordingManager {
  private streams = new Map<string, StreamWorkerHandle>();
  private recordings = new Map<string, RecordingWorkerHandle>();
  private db: Database.Database;
  private ffmpegAvailable: boolean;
  private probeVideoFn: (p: string) => Promise<{
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    codec: string | null;
  }>;
  private extractThumbFn: (v: string, out: string) => Promise<boolean>;

  constructor(params: {
    db: Database.Database;
    ffmpegAvailable: boolean;
    probeVideoFn: (p: string) => Promise<{
      durationSeconds: number | null;
      width: number | null;
      height: number | null;
      fps: number | null;
      codec: string | null;
    }>;
    extractThumbFn: (v: string, out: string) => Promise<boolean>;
  }) {
    this.db = params.db;
    this.ffmpegAvailable = params.ffmpegAvailable;
    this.probeVideoFn = params.probeVideoFn;
    this.extractThumbFn = params.extractThumbFn;
  }

  private getLimitSetting(key: 'max_concurrent_streams' | 'max_concurrent_recordings', fallback = 8): number {
    try {
      const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      const parsed = Number(row?.value ?? fallback);
      if (Number.isFinite(parsed)) {
        return Math.min(Math.max(Math.round(parsed), 1), 32);
      }
    } catch {
      // Fallback
    }
    return fallback;
  }

  public async recoverInterruptedRecordings(activeThumbDir: string): Promise<number> {
    const stale = this.db
      .prepare("SELECT * FROM recording_sessions WHERE status = 'recording'")
      .all() as Array<{
      id: string;
      camera_id: string;
      output_path: string;
      started_at: string;
    }>;

    let recoveredCount = 0;
    const now = utcNowIso();
    for (const row of stale) {
      const exists = fs.existsSync(row.output_path);
      const size = exists ? fs.statSync(row.output_path).size : 0;
      if (exists && size > 0 && this.ffmpegAvailable) {
        const meta = await this.probeVideoFn(row.output_path);
        const integrity = await verifyMp4DecodeIntegrity(row.output_path);
        if (integrity.ok && (meta.codec || meta.width || meta.durationSeconds !== null)) {
          const videoId = crypto.randomUUID();
          const thumbPath = path.join(activeThumbDir, `${videoId}.jpg`);
          const thumbOk = await this.extractThumbFn(row.output_path, thumbPath);
          const hash = crypto.createHash('sha256').update(fs.readFileSync(row.output_path)).digest('hex');
          this.db
            .prepare(
              `
            INSERT INTO video_files
              (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
               duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at,
               recording_session_id, source_origin, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'Recovered interrupted recording', ?, ?, 'recorded', ?)
          `
            )
            .run(
              videoId,
              row.camera_id,
              path.basename(row.output_path),
              path.basename(row.output_path),
              row.output_path,
              thumbOk ? thumbPath : null,
              hash,
              size,
              meta.durationSeconds,
              meta.width,
              meta.height,
              meta.fps,
              meta.codec,
              row.started_at,
              row.id,
              now
            );
          this.db
            .prepare(
              `UPDATE recording_sessions
               SET status = 'interrupted', video_file_id = ?, file_size_bytes = ?, duration_seconds = ?,
                   error_message = 'Recovered partial fragmented MP4 after unexpected stop', ended_at = ?
               WHERE id = ?`
            )
            .run(videoId, size, meta.durationSeconds, now, row.id);
          recoveredCount++;
          continue;
        }
      }

      this.db
        .prepare(
          `UPDATE recording_sessions
           SET status = 'failed', file_size_bytes = ?, error_message = 'Recording interrupted with unusable or corrupt file', ended_at = ?
           WHERE id = ?`
        )
        .run(size, now, row.id);
    }

    this.db
      .prepare(
        `UPDATE camera_stream_sessions
         SET status = 'stopped', stopped_at = COALESCE(stopped_at, ?)
         WHERE status IN ('starting', 'streaming', 'reconnecting')`
      )
      .run(now);

    return recoveredCount;
  }

  public startStream(camera: {
    id: string;
    name: string;
    source_type: CameraSourceType;
    stream_uri: string;
    rtsp_transport?: RtspTransport;
    target_fps?: number;
    target_resolution?: string;
    max_reconnect_attempts?: number;
  }) {
    if (!this.ffmpegAvailable) {
      throw new Error('FFmpeg binary is required for live camera streaming.');
    }

    const existing = this.streams.get(camera.id);
    if (existing && (existing.status === 'starting' || existing.status === 'streaming' || existing.status === 'reconnecting')) {
      return this.serializeStreamState(existing);
    }

    const maxConcurrent = this.getLimitSetting('max_concurrent_streams', 8);
    const activeCount = Array.from(this.streams.values()).filter((h) =>
      ['starting', 'streaming', 'reconnecting'].includes(h.status)
    ).length;
    if (activeCount >= maxConcurrent) {
      throw new Error(
        `Maximum concurrent live streams limit reached (${maxConcurrent}). Stop an existing stream or adjust max_concurrent_streams.`
      );
    }

    const sessionId = crypto.randomUUID();
    const sampleFps = Math.min(Math.max(Number(camera.target_fps ?? 5), 0.5), 30);
    const targetWidth = parseWidth(camera.target_resolution);
    const resolutionLabel = camera.target_resolution || '1280x720';
    const maxReconnectAttempts = Math.min(Math.max(Number(camera.max_reconnect_attempts ?? 5), 0), 50);
    const rtspTransport: RtspTransport = camera.rtsp_transport === 'udp' ? 'udp' : 'tcp';
    const transportLabel =
      camera.source_type === 'rtsp' || camera.source_type === 'onvif' ? `ffmpeg-${rtspTransport}` : 'ffmpeg';
    const now = utcNowIso();

    this.db
      .prepare(
        `
      INSERT INTO camera_stream_sessions
        (id, camera_id, status, transport, sample_fps, resolution, frames_captured, frames_dropped, bytes_received, reconnect_count, started_at)
      VALUES (?, ?, 'starting', ?, ?, ?, 0, 0, 0, 0, ?)
    `
      )
      .run(sessionId, camera.id, transportLabel, sampleFps, resolutionLabel, now);

    const handle: StreamWorkerHandle = {
      sessionId,
      cameraId: camera.id,
      sourceType: camera.source_type,
      streamUri: camera.stream_uri,
      rtspTransport,
      sampleFps,
      targetWidth,
      maxReconnectAttempts,
      status: 'starting',
      framesCaptured: 0,
      framesDropped: 0,
      bytesReceived: 0,
      avgFrameMs: null,
      lastFrameMonotonicMs: null,
      reconnectCount: 0,
      lastFrameAt: null,
      errorMessage: null,
      latestFrame: null,
      proc: null,
      stopping: false,
      emitter: new EventEmitter(),
      reconnectTimer: null,
    };
    this.streams.set(camera.id, handle);
    this.spawnStreamProcess(handle);
    return this.serializeStreamState(handle);
  }

  private persistStreamState(handle: StreamWorkerHandle, stoppedAt: string | null = null): void {
    try {
      this.db
        .prepare(
          `
        UPDATE camera_stream_sessions
        SET status = ?, frames_captured = ?, frames_dropped = ?, bytes_received = ?, avg_frame_ms = ?,
            reconnect_count = ?, last_frame_at = ?, error_message = ?, stopped_at = COALESCE(?, stopped_at)
        WHERE id = ?
      `
        )
        .run(
          handle.status,
          handle.framesCaptured,
          handle.framesDropped,
          handle.bytesReceived,
          handle.avgFrameMs,
          handle.reconnectCount,
          handle.lastFrameAt,
          handle.errorMessage,
          stoppedAt,
          handle.sessionId
        );
    } catch {
      // Avoid crashing worker if DB is shutting down
    }
  }

  private spawnStreamProcess(handle: StreamWorkerHandle): void {
    if (handle.stopping) return;

    const inputArgs = buildInputArgs(handle.sourceType, handle.streamUri, handle.rtspTransport);
    if (!inputArgs) {
      handle.status = 'error';
      handle.errorMessage = 'No readable video file found for stream source.';
      this.persistStreamState(handle, utcNowIso());
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-vf',
      `fps=${handle.sampleFps.toFixed(2)},scale=${handle.targetWidth}:-2`,
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-q:v',
      '5',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    handle.proc = proc;

    let buffer = Buffer.alloc(0);
    let stderrText = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
      if (stderrText.length > 2048) {
        stderrText = stderrText.slice(-2048);
      }
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      if (handle.stopping) return;
      handle.bytesReceived += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
        buffer = Buffer.from(buffer.subarray(buffer.length - Math.floor(MAX_STREAM_BUFFER_BYTES / 2)));
        handle.framesDropped += 1;
      }

      while (buffer.length >= 4) {
        const soi = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (soi === -1) {
          buffer = Buffer.alloc(0);
          break;
        }
        if (soi > 0) {
          buffer = buffer.subarray(soi);
        }
        const eoi = buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
        if (eoi === -1) break;

        const frame = Buffer.from(buffer.subarray(0, eoi + 2));
        buffer = buffer.subarray(eoi + 2);

        const nowMs = performance.now();
        if (handle.lastFrameMonotonicMs !== null) {
          const delta = nowMs - handle.lastFrameMonotonicMs;
          handle.avgFrameMs =
            handle.avgFrameMs === null ? Number(delta.toFixed(2)) : Number((0.8 * handle.avgFrameMs + 0.2 * delta).toFixed(2));
        }
        handle.lastFrameMonotonicMs = nowMs;

        handle.latestFrame = frame;
        handle.framesCaptured += 1;
        handle.lastFrameAt = utcNowIso();
        handle.errorMessage = null;
        if (handle.status !== 'streaming') {
          handle.status = 'streaming';
          if (this.db.open) {
            try {
              this.db.prepare("UPDATE cameras SET status = 'online', last_error = NULL, updated_at = ? WHERE id = ?").run(
                handle.lastFrameAt,
                handle.cameraId
              );
            } catch {
              // Ignore during shutdown
            }
          }
          this.persistStreamState(handle);
        } else if (handle.framesCaptured % 15 === 0) {
          this.persistStreamState(handle);
        }
        handle.emitter.emit('frame', frame);
      }
    });

    proc.on('close', (code) => {
      handle.proc = null;
      if (handle.stopping) {
        handle.status = 'stopped';
        if (this.db.open) {
          this.persistStreamState(handle, utcNowIso());
        }
        handle.emitter.emit('closed');
        return;
      }

      handle.reconnectCount += 1;
      if (handle.reconnectCount > handle.maxReconnectAttempts) {
        handle.status = 'error';
        handle.errorMessage = sanitizeLogText(
          stderrText.trim() || `Stream terminated (code ${code ?? 'unknown'}); exceeded max reconnect attempts (${handle.maxReconnectAttempts}).`,
          handle.streamUri
        );
        const now = utcNowIso();
        if (this.db.open) {
          try {
            this.db
              .prepare("UPDATE cameras SET status = 'offline', last_error = ?, reconnect_attempts = ?, updated_at = ? WHERE id = ?")
              .run(handle.errorMessage, handle.reconnectCount, now, handle.cameraId);
          } catch {
            // Ignore during shutdown
          }
        }
        this.persistStreamState(handle, now);
        handle.emitter.emit('closed');
        return;
      }

      handle.status = 'reconnecting';
      handle.errorMessage = sanitizeLogText(
        stderrText.trim() || `Stream interrupted (code ${code ?? 'unknown'}); reconnect attempt ${handle.reconnectCount}/${handle.maxReconnectAttempts}.`,
        handle.streamUri
      );
      if (this.db.open) {
        try {
          this.db
            .prepare('UPDATE cameras SET reconnect_attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
            .run(handle.reconnectCount, handle.errorMessage, utcNowIso(), handle.cameraId);
        } catch {
          // Ignore during shutdown
        }
      }
      this.persistStreamState(handle);

      const delayMs = Math.min(5000, 500 * handle.reconnectCount);
      handle.reconnectTimer = setTimeout(() => {
        handle.reconnectTimer = null;
        this.spawnStreamProcess(handle);
      }, delayMs);
    });
  }

  public stopStream(cameraId: string) {
    const handle = this.streams.get(cameraId);
    if (!handle) return null;
    handle.stopping = true;
    if (handle.reconnectTimer) {
      clearTimeout(handle.reconnectTimer);
      handle.reconnectTimer = null;
    }
    if (handle.proc) {
      try {
        handle.proc.kill('SIGTERM');
      } catch {
        // Ignore already exited
      }
    }
    handle.status = 'stopped';
    this.persistStreamState(handle, utcNowIso());
    this.streams.delete(cameraId);
    handle.emitter.emit('closed');
    return this.serializeStreamState(handle);
  }

  public getStreamHandle(cameraId: string): StreamWorkerHandle | undefined {
    return this.streams.get(cameraId);
  }

  public async captureSingleSnapshot(
    sourceType: CameraSourceType,
    streamUri: string,
    rtspTransport: RtspTransport = 'tcp'
  ): Promise<Buffer | null> {
    if (!this.ffmpegAvailable) return null;
    let inputArgs: string[];
    if (sourceType === 'local_archive') {
      const files = discoverLocalArchiveFiles(streamUri);
      if (files.length === 0) return null;
      inputArgs = ['-ss', '0.2', '-i', files[0]];
    } else if (sourceType === 'rtsp' || (sourceType === 'onvif' && /^rtsps?:\/\//i.test(streamUri))) {
      inputArgs = ['-rtsp_transport', rtspTransport === 'udp' ? 'udp' : 'tcp', '-i', streamUri];
    } else {
      inputArgs = ['-i', streamUri];
    }

    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 8000 }
      );
      if (stdout.length >= 4 && stdout[0] === 0xff && stdout[1] === 0xd8) {
        return stdout;
      }
      return null;
    } catch {
      return null;
    }
  }

  public startRecording(
    camera: { id: string; name: string; source_type: CameraSourceType; stream_uri: string; rtsp_transport?: RtspTransport },
    storageDir: string,
    triggerMode: 'manual' | 'scheduled' | 'continuous' = 'manual'
  ) {
    if (!this.ffmpegAvailable) {
      throw new Error('FFmpeg binary is required to record camera feeds.');
    }
    if (this.recordings.has(camera.id)) {
      throw new Error(`Camera '${camera.name}' is already recording.`);
    }
    const maxRecs = this.getLimitSetting('max_concurrent_recordings', 8);
    if (this.recordings.size >= maxRecs) {
      throw new Error(`Maximum concurrent recordings limit reached (${maxRecs}).`);
    }

    const inputArgs = buildInputArgs(camera.source_type, camera.stream_uri, camera.rtsp_transport || 'tcp');
    if (!inputArgs) {
      throw new Error('Camera source has no readable media stream to record.');
    }

    const camDir = path.join(storageDir, 'cameras', camera.id);
    fs.mkdirSync(camDir, { recursive: true });
    const stamp = utcNowIso().replace(/[:.]/g, '-');
    const sessionId = crypto.randomUUID();
    const filename = `rec_${stamp}_${sessionId.slice(0, 6)}.mp4`;
    const outputPath = path.join(camDir, filename);

    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const startedAt = utcNowIso();
    const recHandle: RecordingWorkerHandle = {
      sessionId,
      cameraId: camera.id,
      cameraName: camera.name,
      outputPath,
      proc,
      startedAt,
      triggerMode,
      stderrTail: '',
    };

    proc.stderr.on('data', (chunk: Buffer) => {
      recHandle.stderrTail += chunk.toString('utf8');
      if (recHandle.stderrTail.length > 2048) {
        recHandle.stderrTail = recHandle.stderrTail.slice(-2048);
      }
    });

    this.db
      .prepare(
        `
      INSERT INTO recording_sessions (id, camera_id, trigger_mode, status, output_path, file_size_bytes, started_at)
      VALUES (?, ?, ?, 'recording', ?, 0, ?)
    `
      )
      .run(sessionId, camera.id, triggerMode, outputPath, startedAt);

    this.recordings.set(camera.id, recHandle);
    return this.db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(sessionId);
  }

  public async stopRecording(cameraId: string, activeThumbDir: string, retentionDays = 30) {
    const rec = this.recordings.get(cameraId);
    if (!rec) return null;
    this.recordings.delete(cameraId);

    await new Promise<void>((resolve) => {
      if (rec.proc.exitCode !== null) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          rec.proc.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }, 2500);
      rec.proc.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        rec.proc.stdin?.write('q\n');
        rec.proc.stdin?.end();
      } catch {
        rec.proc.kill('SIGINT');
      }
    });

    const endedAt = utcNowIso();
    const exists = fs.existsSync(rec.outputPath);
    const sizeBytes = exists ? fs.statSync(rec.outputPath).size : 0;

    if (!exists || sizeBytes === 0) {
      const errMsg = sanitizeLogText(rec.stderrTail.trim() || 'Recording produced no valid video data.');
      this.db
        .prepare("UPDATE recording_sessions SET status = 'failed', file_size_bytes = 0, error_message = ?, ended_at = ? WHERE id = ?")
        .run(errMsg, endedAt, rec.sessionId);
      return this.db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(rec.sessionId);
    }

    // Verify stream container & frame decode integrity before registering as playable
    const integrity = await verifyMp4DecodeIntegrity(rec.outputPath);
    if (!integrity.ok) {
      const errMsg = sanitizeLogText(integrity.error || 'Recorded MP4 failed decode integrity verification.');
      this.db
        .prepare("UPDATE recording_sessions SET status = 'failed', file_size_bytes = ?, error_message = ?, ended_at = ? WHERE id = ?")
        .run(sizeBytes, errMsg, endedAt, rec.sessionId);
      return this.db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(rec.sessionId);
    }

    const meta = await this.probeVideoFn(rec.outputPath);
    const videoId = crypto.randomUUID();
    const thumbPath = path.join(activeThumbDir, `${videoId}.jpg`);
    const thumbOk = await this.extractThumbFn(rec.outputPath, thumbPath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(rec.outputPath)).digest('hex');
    const expiresAt = new Date(Date.now() + retentionDays * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    this.db
      .prepare(
        `
      INSERT INTO video_files
        (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
         duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at,
         recording_session_id, source_origin, expires_at, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, 'recorded', ?, ?)
    `
      )
      .run(
        videoId,
        rec.cameraId,
        path.basename(rec.outputPath),
        path.basename(rec.outputPath),
        rec.outputPath,
        thumbOk ? thumbPath : null,
        sha256,
        sizeBytes,
        meta.durationSeconds,
        meta.width,
        meta.height,
        meta.fps,
        meta.codec,
        rec.startedAt,
        rec.sessionId,
        expiresAt,
        endedAt
      );

    this.db
      .prepare(
        `UPDATE recording_sessions
         SET status = 'completed', video_file_id = ?, file_size_bytes = ?, duration_seconds = ?, ended_at = ?
         WHERE id = ?`
      )
      .run(videoId, sizeBytes, meta.durationSeconds, endedAt, rec.sessionId);

    return this.db.prepare('SELECT * FROM recording_sessions WHERE id = ?').get(rec.sessionId);
  }

  public isScheduleActive(scheduleStr: string | null | undefined, nowDate = new Date()): boolean {
    if (!scheduleStr) return false;
    const raw = scheduleStr.trim();
    if (!raw) return false;

    let startStr = '';
    let endStr = '';
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { enabled?: boolean; start?: string; end?: string };
        if (parsed.enabled === false) return false;
        startStr = parsed.start || '';
        endStr = parsed.end || '';
      } catch {
        return false;
      }
    } else if (raw.includes('-')) {
      [startStr, endStr] = raw.split('-', 2).map((s) => s.trim());
    }

    const toMinutes = (hhmm: string): number | null => {
      const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    const startMin = toMinutes(startStr);
    const endMin = toMinutes(endStr);
    if (startMin === null || endMin === null) return false;

    const currentMin = nowDate.getHours() * 60 + nowDate.getMinutes();
    if (startMin <= endMin) {
      return currentMin >= startMin && currentMin <= endMin;
    }
    return currentMin >= startMin || currentMin <= endMin;
  }

  public async shutdownAll(activeThumbDir: string): Promise<void> {
    for (const camId of Array.from(this.recordings.keys())) {
      await this.stopRecording(camId, activeThumbDir);
    }
    const procs: ChildProcess[] = [];
    for (const camId of Array.from(this.streams.keys())) {
      const h = this.streams.get(camId);
      if (h?.proc && h.proc.exitCode === null) {
        procs.push(h.proc);
      }
      this.stopStream(camId);
    }
    await Promise.all(
      procs.map(
        (p) =>
          new Promise<void>((resolve) => {
            if (p.exitCode !== null) {
              resolve();
              return;
            }
            const t = setTimeout(resolve, 1500);
            p.once('close', () => {
              clearTimeout(t);
              resolve();
            });
          })
      )
    );
  }

  private serializeStreamState(handle: StreamWorkerHandle) {
    return {
      id: handle.sessionId,
      camera_id: handle.cameraId,
      status: handle.status,
      transport: handle.sourceType === 'rtsp' || handle.sourceType === 'onvif' ? `ffmpeg-${handle.rtspTransport}` : 'ffmpeg',
      sample_fps: handle.sampleFps,
      resolution: `${handle.targetWidth}w`,
      frames_captured: handle.framesCaptured,
      frames_dropped: handle.framesDropped,
      bytes_received: handle.bytesReceived,
      avg_frame_ms: handle.avgFrameMs,
      reconnect_count: handle.reconnectCount,
      last_frame_at: handle.lastFrameAt,
      error_message: handle.errorMessage,
    };
  }
}
