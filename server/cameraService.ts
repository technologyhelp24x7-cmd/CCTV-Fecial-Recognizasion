import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CameraSourceType,
  RtspTransport,
  StreamProfileType,
  VerificationStages,
} from '../shared/types.ts';
import { injectUriCredentials, stripUriCredentials } from './credentialStore.ts';
import { verifyOnvifAndRtsp } from './onvifClient.ts';

const execFileAsync = promisify(execFile);

export const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.ts']);

export interface CameraProbeOutcome {
  reachable: boolean;
  status: 'online' | 'offline';
  message: string;
  error: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  discoveredFiles: number;
  manufacturer?: string | null;
  model?: string | null;
  firmwareVersion?: string | null;
  mainStreamUri?: string | null;
  subStreamUri?: string | null;
  stages?: VerificationStages | null;
}

export function redactStreamUri(uri: string): string {
  const raw = (uri || '').trim();
  if (!raw) return '';
  let masked = raw.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s/]+)(@)/g, '$1****$3');
  masked = masked.replace(/((?:password|passwd|pwd|pass|token|secret)=)([^&\s]+)/gi, '$1****');
  return masked;
}

export function sanitizeLogText(text: string, rawUri?: string, extraSecret?: string | null): string {
  let cleaned = text || '';
  if (extraSecret) {
    cleaned = cleaned.split(extraSecret).join('****');
    cleaned = cleaned.split(encodeURIComponent(extraSecret)).join('****');
  }
  if (rawUri) {
    const masked = redactStreamUri(rawUri);
    if (cleaned.includes(rawUri)) {
      cleaned = cleaned.split(rawUri).join(masked);
    }
    try {
      const parsed = new URL(rawUri);
      if (parsed.password) {
        cleaned = cleaned.split(decodeURIComponent(parsed.password)).join('****');
        cleaned = cleaned.split(parsed.password).join('****');
      }
    } catch {
      // Non-URL local path
    }
  }
  cleaned = cleaned.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s/]+)(@)/g, '$1****$3');
  cleaned = cleaned.replace(/((?:password|passwd|pwd|pass|token|secret)=)([^&\s]+)/gi, '$1****');
  return cleaned;
}

function checkTcpPort(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, `TCP connection timed out connecting to ${host}:${port}`));
    socket.once('error', (err) => finish(false, `TCP connection failed to ${host}:${port} (${err.message})`));
    socket.connect(port, host);
  });
}

export async function ffprobeStream(
  uri: string,
  options: { rtspTransport?: RtspTransport; timeoutMs?: number } = {}
): Promise<{
  ok: boolean;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSeconds: number | null;
  error: string | null;
}> {
  const args = ['-v', 'error'];
  if (options.rtspTransport) {
    args.push('-rtsp_transport', options.rtspTransport);
  }
  args.push('-show_streams', '-show_format', '-of', 'json', uri);

  try {
    const { stdout } = await execFileAsync('ffprobe', args, { timeout: options.timeoutMs ?? 6000 });
    const parsed = JSON.parse(stdout || '{}') as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const videoStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
    if (!videoStream) {
      return {
        ok: false,
        codec: null,
        width: null,
        height: null,
        fps: null,
        durationSeconds: null,
        error: 'Endpoint responded, but no video stream track was detected.',
      };
    }

    let fps: number | null = null;
    if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes('/')) {
      const [numS, denS] = videoStream.r_frame_rate.split('/', 2);
      const den = Number(denS);
      if (den > 0) fps = Number((Number(numS) / den).toFixed(2));
    }

    const durationSeconds = parsed.format?.duration ? Number(Number(parsed.format.duration).toFixed(3)) : null;
    return {
      ok: true,
      codec: videoStream.codec_name ?? null,
      width: videoStream.width ?? null,
      height: videoStream.height ?? null,
      fps,
      durationSeconds,
      error: null,
    };
  } catch (err: unknown) {
    const rawMsg =
      typeof err === 'object' && err !== null && 'stderr' in err && (err as { stderr?: string }).stderr
        ? String((err as { stderr?: string }).stderr).trim()
        : err instanceof Error
          ? err.message
          : 'ffprobe stream check failed';
    return {
      ok: false,
      codec: null,
      width: null,
      height: null,
      fps: null,
      durationSeconds: null,
      error: sanitizeLogText(rawMsg, uri),
    };
  }
}

export async function verifyMp4DecodeIntegrity(filePath: string, timeoutMs = 8000): Promise<{ ok: boolean; error: string | null }> {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return { ok: false, error: 'Recorded MP4 file is missing or 0 bytes.' };
  }
  const probe = await ffprobeStream(filePath, { timeoutMs });
  if (!probe.ok) {
    return { ok: false, error: probe.error || 'No valid video stream inside recorded MP4.' };
  }
  try {
    await execFileAsync('ffmpeg', ['-v', 'error', '-i', filePath, '-t', '2', '-f', 'null', '-'], { timeout: timeoutMs });
    return { ok: true, error: null };
  } catch (err: unknown) {
    const msg =
      typeof err === 'object' && err !== null && 'stderr' in err && (err as { stderr?: string }).stderr
        ? String((err as { stderr?: string }).stderr).trim()
        : err instanceof Error
          ? err.message
          : 'FFmpeg decode integrity verification failed.';
    return { ok: false, error: msg };
  }
}

export function discoverLocalArchiveFiles(targetPath: string): string[] {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) return [];
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const ext = path.extname(resolved).toLowerCase();
    return ALLOWED_VIDEO_EXTENSIONS.has(ext) ? [resolved] : [];
  }
  if (stat.isDirectory()) {
    return fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ALLOWED_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(resolved, entry.name))
      .sort();
  }
  return [];
}

export function buildEffectiveCameraUri(params: {
  sourceType: CameraSourceType;
  streamUri: string;
  mainStreamUri?: string | null;
  subStreamUri?: string | null;
  streamProfile?: StreamProfileType;
  username?: string | null;
  password?: string | null;
}): string {
  let candidate = (params.streamUri || '').trim();
  if (params.sourceType === 'local_archive') {
    return candidate;
  }
  if (params.streamProfile === 'sub' && params.subStreamUri) {
    candidate = params.subStreamUri.trim();
  } else if (
    params.mainStreamUri &&
    (params.sourceType !== 'onvif' || /^rtsps?:\/\//i.test(params.mainStreamUri))
  ) {
    candidate = params.mainStreamUri.trim();
  }
  return injectUriCredentials(candidate, params.username, params.password);
}

export async function probeCameraConnection(
  sourceType: CameraSourceType,
  streamUri: string,
  options: {
    rtspTransport?: RtspTransport;
    username?: string | null;
    password?: string | null;
    streamProfile?: StreamProfileType;
    mainStreamUri?: string | null;
    subStreamUri?: string | null;
    timeoutSec?: number;
  } = {}
): Promise<CameraProbeOutcome> {
  const raw = (streamUri || '').trim();
  const rtspTransport: RtspTransport = options.rtspTransport === 'udp' ? 'udp' : 'tcp';
  const streamProfile: StreamProfileType = options.streamProfile === 'sub' ? 'sub' : 'main';
  const timeoutSec = Math.min(Math.max(Number(options.timeoutSec ?? 6), 1.5), 20);
  const timeoutMs = timeoutSec * 1000;

  if (!raw) {
    return {
      reachable: false,
      status: 'offline',
      message: 'Stream URI or local path is empty.',
      error: 'EMPTY_URI',
      codec: null,
      width: null,
      height: null,
      fps: null,
      discoveredFiles: 0,
    };
  }

  if (sourceType === 'local_archive') {
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
      return {
        reachable: false,
        status: 'offline',
        message: `Local archive path not found: ${raw}`,
        error: 'LOCAL_PATH_NOT_FOUND',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
      };
    }

    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
        return {
          reachable: false,
          status: 'offline',
          message: `Unsupported local video extension '${ext}'.`,
          error: 'UNSUPPORTED_EXTENSION',
          codec: null,
          width: null,
          height: null,
          fps: null,
          discoveredFiles: 0,
        };
      }
      const probe = await ffprobeStream(resolved);
      if (!probe.ok) {
        return {
          reachable: false,
          status: 'offline',
          message: probe.error || 'Local file has no decodable video stream.',
          error: 'NO_VIDEO_STREAM',
          codec: null,
          width: null,
          height: null,
          fps: null,
          discoveredFiles: 0,
        };
      }
      return {
        reachable: true,
        status: 'online',
        message: `Verified local video source (${probe.codec || 'video'} ${probe.width || '?'}x${probe.height || '?'}).`,
        error: null,
        codec: probe.codec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        discoveredFiles: 1,
      };
    }

    if (stat.isDirectory()) {
      const files = discoverLocalArchiveFiles(resolved);
      return {
        reachable: true,
        status: 'online',
        message: `Local archive directory accessible (${files.length} video file(s) discovered).`,
        error: null,
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: files.length,
      };
    }
  }

  const { cleanUri, username: uriUser, password: uriPass } = stripUriCredentials(raw);
  const effUser = options.username ?? uriUser;
  const effPass = options.password ?? uriPass;

  let parsed: URL;
  try {
    parsed = new URL(cleanUri);
    if (!parsed.hostname) throw new Error('Missing host');
  } catch {
    return {
      reachable: false,
      status: 'offline',
      message: 'Invalid stream URI syntax.',
      error: 'INVALID_URI',
      codec: null,
      width: null,
      height: null,
      fps: null,
      discoveredFiles: 0,
    };
  }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();

  if (sourceType === 'onvif' && scheme !== 'rtsp' && scheme !== 'rtsps') {
    const res = await verifyOnvifAndRtsp({
      endpointUrl: cleanUri,
      username: effUser,
      password: effPass,
      rtspTransport,
      streamProfile,
      timeoutSec,
      probeRtspFn: (uri, transport, ms) => ffprobeStream(uri, { rtspTransport: transport, timeoutMs: ms }),
    });
    return {
      reachable: res.reachable,
      status: res.status,
      message: sanitizeLogText(res.message, raw, effPass),
      error: res.error,
      codec: res.codec,
      width: res.width,
      height: res.height,
      fps: res.fps,
      discoveredFiles: 0,
      manufacturer: res.manufacturer,
      model: res.model,
      firmwareVersion: res.firmware_version,
      mainStreamUri: res.main_rtsp_uri,
      subStreamUri: res.sub_rtsp_uri,
      stages: res.stages,
    };
  }

  if (sourceType === 'rtsp' || (sourceType === 'onvif' && (scheme === 'rtsp' || scheme === 'rtsps'))) {
    const targetClean =
      streamProfile === 'sub' && options.subStreamUri
        ? options.subStreamUri.trim()
        : options.mainStreamUri?.trim() || cleanUri;
    let targetParsed: URL;
    try {
      targetParsed = new URL(targetClean);
    } catch {
      targetParsed = parsed;
    }
    const targetScheme = targetParsed.protocol.replace(':', '').toLowerCase();
    if (targetScheme !== 'rtsp' && targetScheme !== 'rtsps') {
      return {
        reachable: false,
        status: 'offline',
        message: 'RTSP camera requires rtsp:// or rtsps:// URI.',
        error: 'INVALID_SCHEME',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
      };
    }

    const stages: VerificationStages = {
      device_discovered: false,
      onvif_authenticated: false,
      device_info_retrieved: false,
      profiles_retrieved: false,
      rtsp_uri_retrieved: false,
      rtsp_stream_opened: false,
      checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    const port = Number(targetParsed.port) || (targetScheme === 'rtsps' ? 322 : 554);
    const tcp = await checkTcpPort(targetParsed.hostname, port, Math.min(timeoutMs, 3000));
    if (!tcp.ok) {
      stages.error = tcp.error || `RTSP port ${port} unreachable.`;
      return {
        reachable: false,
        status: 'offline',
        message: stages.error,
        error: 'TCP_UNREACHABLE',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
        stages,
      };
    }
    stages.device_discovered = true;
    stages.rtsp_uri_retrieved = true;

    const runtimeUri = injectUriCredentials(targetClean, effUser, effPass);
    const probe = await ffprobeStream(runtimeUri, { rtspTransport, timeoutMs });
    if (!probe.ok) {
      const msg = sanitizeLogText(
        `RTSP (${rtspTransport.toUpperCase()}) port ${port} reachable, but stream handshake failed: ${probe.error}`,
        runtimeUri,
        effPass
      );
      stages.error = msg;
      return {
        reachable: false,
        status: 'offline',
        message: msg,
        error: 'RTSP_HANDSHAKE_FAILED',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
        stages,
      };
    }
    stages.rtsp_stream_opened = true;
    return {
      reachable: true,
      status: 'online',
      message: `RTSP (${rtspTransport.toUpperCase()}) stream verified (${probe.codec || 'video'} ${probe.width || '?'}x${probe.height || '?'}).`,
      error: null,
      codec: probe.codec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      discoveredFiles: 0,
      mainStreamUri: options.mainStreamUri || cleanUri,
      subStreamUri: options.subStreamUri || null,
      stages,
    };
  }

  if (sourceType === 'http') {
    if (scheme !== 'http' && scheme !== 'https') {
      return {
        reachable: false,
        status: 'offline',
        message: 'HTTP camera requires http:// or https:// URI.',
        error: 'INVALID_SCHEME',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
      };
    }
    const port = Number(parsed.port) || (scheme === 'https' ? 443 : 80);
    const tcp = await checkTcpPort(parsed.hostname, port, Math.min(timeoutMs, 3000));
    if (!tcp.ok) {
      return {
        reachable: false,
        status: 'offline',
        message: tcp.error || 'HTTP host unreachable.',
        error: 'TCP_UNREACHABLE',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
      };
    }

    const runtimeUri = injectUriCredentials(cleanUri, effUser, effPass);
    const probe = await ffprobeStream(runtimeUri, { timeoutMs });
    if (!probe.ok) {
      return {
        reachable: false,
        status: 'offline',
        message: sanitizeLogText(
          probe.error || 'HTTP endpoint did not expose a valid video stream.',
          runtimeUri,
          effPass
        ),
        error: 'HTTP_STREAM_INVALID',
        codec: null,
        width: null,
        height: null,
        fps: null,
        discoveredFiles: 0,
      };
    }
    return {
      reachable: true,
      status: 'online',
      message: `HTTP stream verified (${probe.codec || 'video'} ${probe.width || '?'}x${probe.height || '?'}).`,
      error: null,
      codec: probe.codec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      discoveredFiles: 0,
    };
  }

  return {
    reachable: false,
    status: 'offline',
    message: `Unsupported source type '${sourceType}'.`,
    error: 'UNSUPPORTED_SOURCE',
    codec: null,
    width: null,
    height: null,
    fps: null,
    discoveredFiles: 0,
  };
}
