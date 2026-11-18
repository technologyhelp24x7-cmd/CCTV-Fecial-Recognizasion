import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { BoundingBox } from '../shared/types.ts';

const execFileAsync = promisify(execFile);

export type PrivacyMaskMode = 'blur' | 'pixelate';

export function buildFfmpegPrivacyFilter(
  regions: BoundingBox[],
  mode: PrivacyMaskMode,
  frameWidth = 1280,
  frameHeight = 720
): string {
  const fullFilter =
    mode === 'pixelate'
      ? 'scale=max(4\\,iw/12):max(4\\,ih/12):flags=neighbor,scale=iw*12:ih*12:flags=neighbor'
      : 'boxblur=16:3';

  if (regions.length === 0) {
    return `[0:v]${fullFilter},format=yuv420p[vout]`;
  }

  const safeRegions: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const r of regions.slice(0, 12)) {
    const x = Math.max(0, Math.min(frameWidth - 16, Math.round(r.x)));
    const y = Math.max(0, Math.min(frameHeight - 16, Math.round(r.y)));
    let w = Math.max(16, Math.min(frameWidth - x, Math.round(r.w)));
    let h = Math.max(16, Math.min(frameHeight - y, Math.round(r.h)));
    w -= w % 2;
    h -= h % 2;
    if (w >= 16 && h >= 16) {
      safeRegions.push({ x, y, w, h });
    }
  }

  if (safeRegions.length === 0) {
    return `[0:v]${fullFilter},format=yuv420p[vout]`;
  }

  const splitOutputs = `[base]${safeRegions.map((_, idx) => `[rsrc${idx}]`).join('')}`;
  const parts: string[] = [`[0:v]split=${safeRegions.length + 1}${splitOutputs}`];
  let prev = '[base]';

  safeRegions.forEach((r, idx) => {
    const op =
      mode === 'pixelate'
        ? `scale=max(4\\,${Math.max(4, Math.floor(r.w / 12))}):max(4\\,${Math.max(4, Math.floor(r.h / 12))}):flags=neighbor,scale=${r.w}:${r.h}:flags=neighbor`
        : 'boxblur=14:3';
    parts.push(`[rsrc${idx}]crop=${r.w}:${r.h}:${r.x}:${r.y},${op}[masked${idx}]`);
    const isLast = idx === safeRegions.length - 1;
    const nextLbl = isLast ? '[vout]' : `[tmp${idx}]`;
    parts.push(
      isLast
        ? `${prev}[masked${idx}]overlay=${r.x}:${r.y},format=yuv420p${nextLbl}`
        : `${prev}[masked${idx}]overlay=${r.x}:${r.y}${nextLbl}`
    );
    prev = nextLbl;
  });

  return parts.join(';');
}

export async function exportPrivacyMaskedVideo(params: {
  inputPath: string;
  outputPath: string;
  regions: BoundingBox[];
  mode: PrivacyMaskMode;
  frameWidth: number | null;
  frameHeight: number | null;
}): Promise<{ sizeBytes: number; sha256: string }> {
  const fw = params.frameWidth || 1280;
  const fh = params.frameHeight || 720;
  const filterGraph = buildFfmpegPrivacyFilter(params.regions, params.mode, fw, fh);

  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      params.inputPath,
      '-filter_complex',
      filterGraph,
      '-map',
      '[vout]',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      params.outputPath,
    ],
    { timeout: 60000 }
  );

  if (!fs.existsSync(params.outputPath) || fs.statSync(params.outputPath).size === 0) {
    throw new Error('FFmpeg privacy export produced no output video.');
  }

  const sizeBytes = fs.statSync(params.outputPath).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(params.outputPath)).digest('hex');
  return { sizeBytes, sha256 };
}

export function enforceRetentionPolicies(db: Database.Database): {
  expired_videos_deleted: number;
  orphaned_events_purged: number;
} {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiredVideos = db
    .prepare('SELECT id, storage_path, thumbnail_path FROM video_files WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .all(nowIso) as Array<{ id: string; storage_path: string; thumbnail_path: string | null }>;

  let deletedVideos = 0;
  for (const vid of expiredVideos) {
    const eventCrops = db
      .prepare('SELECT crop_path FROM person_events WHERE video_file_id = ?')
      .all(vid.id) as Array<{ crop_path: string | null }>;
    for (const c of eventCrops) {
      if (c.crop_path && fs.existsSync(c.crop_path)) {
        try {
          fs.unlinkSync(c.crop_path);
        } catch {
          // Ignore file removal errors
        }
      }
    }
    db.prepare('DELETE FROM video_files WHERE id = ?').run(vid.id);
    for (const p of [vid.storage_path, vid.thumbnail_path]) {
      if (p && fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // Ignore file removal errors
        }
      }
    }
    deletedVideos += 1;
  }

  const info = db
    .prepare(
      `DELETE FROM person_events
       WHERE status = 'dismissed'
         AND created_at <= datetime('now', '-30 days')`
    )
    .run();

  return {
    expired_videos_deleted: deletedVideos,
    orphaned_events_purged: Number(info.changes || 0),
  };
}
