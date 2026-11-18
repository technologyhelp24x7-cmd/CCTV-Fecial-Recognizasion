import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createLumaFluxApp } from '../server.ts';

const execFileAsync = promisify(execFile);

test('LumaFlux Intelligence API end-to-end integration', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumaflux-api-test-'));
  const dbPath = path.join(tmpDir, 'lumaflux.db');
  const storageDir = path.join(tmpDir, 'videos');
  const thumbnailDir = path.join(tmpDir, 'thumbnails');
  const logDir = path.join(tmpDir, 'logs');

  const { app, db, streamManager } = await createLumaFluxApp({
    dbPath,
    storageDir,
    thumbnailDir,
    logDir,
    skipVite: true,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Health & zeroed initial summary
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.biometric_identification_enabled, false);

    const summaryRes = await fetch(`${baseUrl}/api/dashboard/summary`);
    assert.equal(summaryRes.status, 200);
    const summary = await summaryRes.json();
    assert.equal(summary.total_imported_videos, 0);
    assert.equal(summary.detected_person_events, 0);

    // 2. Consent policy enforcement on Person Profiles
    const deniedProfileRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Unconsented Staff',
        category: 'authorized',
        authorization_level: 'authorized',
        consent_status: 'pending',
      }),
    });
    assert.equal(deniedProfileRes.status, 403);

    const okProfileRes = await fetch(`${baseUrl}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'Consented Operator',
        category: 'authorized',
        authorization_level: 'authorized',
        consent_status: 'granted',
        department_or_zone: 'Control Room',
      }),
    });
    assert.equal(okProfileRes.status, 201);
    const profile = await okProfileRes.json();

    // 3. Camera registration
    const camRes = await fetch(`${baseUrl}/api/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Gate 01',
        location_zone: 'Perimeter',
        source_type: 'rtsp',
        stream_uri: 'rtsp://127.0.0.1:554/stream1',
      }),
    });
    assert.equal(camRes.status, 201);
    const cam = await camRes.json();

    // 4. Real video import via multipart FormData + FFmpeg inspection
    const clipPath = path.join(tmpDir, 'test_clip.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=navy:s=320x240:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      clipPath,
    ]);
    const fileBuf = fs.readFileSync(clipPath);
    const form = new FormData();
    form.append('file', new Blob([fileBuf], { type: 'video/mp4' }), 'gate01_sample.mp4');
    form.append('camera_id', cam.id);

    const importRes = await fetch(`${baseUrl}/api/videos/import`, {
      method: 'POST',
      body: form,
    });
    assert.equal(importRes.status, 201);
    const importedVideo = await importRes.json();
    assert.equal(importedVideo.width, 320);
    assert.equal(importedVideo.height, 240);
    assert.equal(importedVideo.processing_status, 'ready');

    // 5. Range streaming (including clamping past EOF) & thumbnail verification
    const streamRes = await fetch(`${baseUrl}/api/videos/${importedVideo.id}/stream`, {
      headers: { Range: 'bytes=0-127' },
    });
    assert.equal(streamRes.status, 206);

    const clampedStreamRes = await fetch(`${baseUrl}/api/videos/${importedVideo.id}/stream`, {
      headers: { Range: 'bytes=0-999999999' },
    });
    assert.equal(clampedStreamRes.status, 206);

    const thumbRes = await fetch(`${baseUrl}/api/videos/${importedVideo.id}/thumbnail`);
    assert.equal(thumbRes.status, 200);

    // 5b. Invalid file extension rejection (400)
    const badExtForm = new FormData();
    badExtForm.append('file', new Blob(['not a video'], { type: 'text/plain' }), 'notes.txt');
    const badExtRes = await fetch(`${baseUrl}/api/videos/import`, {
      method: 'POST',
      body: badExtForm,
    });
    assert.equal(badExtRes.status, 400);

    // 5c. Corrupt .mp4 payload rejection by FFmpeg (422)
    const corruptForm = new FormData();
    corruptForm.append('file', new Blob(['corrupt mp4 bytes'], { type: 'video/mp4' }), 'corrupt.mp4');
    const corruptRes = await fetch(`${baseUrl}/api/videos/import`, {
      method: 'POST',
      body: corruptForm,
    });
    assert.equal(corruptRes.status, 422);

    // 5d. Empty 0-byte .mp4 rejection (400)
    const emptyForm = new FormData();
    emptyForm.append('file', new Blob([], { type: 'video/mp4' }), 'empty.mp4');
    const emptyRes = await fetch(`${baseUrl}/api/videos/import`, {
      method: 'POST',
      body: emptyForm,
    });
    assert.equal(emptyRes.status, 400);

    // 6. Biometric job must be denied (403)
    const bioRes = await fetch(`${baseUrl}/api/ai/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_file_id: importedVideo.id,
        engine_id: 'biometric-matching-guard',
      }),
    });
    assert.equal(bioRes.status, 403);

    // 7. Watchlist Review & Settings persistence (plus allowlist check)
    const reviewRes = await fetch(`${baseUrl}/api/watchlist-reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Verify Gate 01 Delivery',
        priority: 'medium',
        reason: 'Routine perimeter log verification',
        profile_id: profile.id,
        video_file_id: importedVideo.id,
      }),
    });
    assert.equal(reviewRes.status, 201);

    const settingsRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_retention_days: '45', injected_arbitrary_key: 'ignored' }),
    });
    assert.equal(settingsRes.status, 200);
    const updatedSettings = await settingsRes.json();
    assert.equal(updatedSettings.default_retention_days, '45');
    assert.equal(updatedSettings.injected_arbitrary_key, undefined);

    // 8. Final dashboard & audit log check reflects real counts + no leaked secrets
    const finalSummary = await (await fetch(`${baseUrl}/api/dashboard/summary`)).json();
    assert.equal(finalSummary.total_imported_videos, 1);
    assert.equal(finalSummary.total_cameras, 1);
    assert.equal(finalSummary.authorized_registered_profiles, 1);
    assert.equal(finalSummary.pending_security_reviews, 1);
    assert.equal(finalSummary.detected_person_events, 0);

    const auditLogs = await (await fetch(`${baseUrl}/api/audit-logs?limit=50`)).json();
    const actions = new Set(auditLogs.map((l) => l.action));
    assert.ok(actions.has('VIDEO_IMPORTED'));
    assert.ok(actions.has('VIDEO_IMPORT_REJECTED'));
    assert.ok(actions.has('BIOMETRIC_PIPELINE_DENIED'));
    assert.ok(actions.has('SETTINGS_UPDATED'));

    // 9. Stage 2 Phase A + B: local_archive camera probe, local ingest, live stream snapshot, recording, schedule & recovery
    const archiveCamRes = await fetch(`${baseUrl}/api/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Lab Archive Feed',
        location_zone: 'Lab Bay',
        source_type: 'local_archive',
        stream_uri: clipPath,
        recording_mode: 'scheduled',
        recording_schedule: '00:00-23:59',
        target_fps: 5,
        target_resolution: '320x240',
      }),
    });
    assert.equal(archiveCamRes.status, 201);
    const archiveCam = await archiveCamRes.json();

    const probeRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/check`, { method: 'POST' });
    assert.equal(probeRes.status, 200);
    const probeData = await probeRes.json();
    assert.equal(probeData.camera.status, 'online');
    assert.equal(probeData.probe.reachable, true);

    const ingestRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/ingest-local`, { method: 'POST' });
    assert.equal(ingestRes.status, 201);
    const ingestData = await ingestRes.json();
    assert.equal(ingestData.ingested_count, 1);

    const streamStartRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/stream/start`, { method: 'POST' });
    assert.equal(streamStartRes.status, 201);

    let snapOk = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const snapRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/snapshot`);
      if (snapRes.status === 200) {
        const buf = Buffer.from(await snapRes.arrayBuffer());
        assert.equal(buf[0], 0xff);
        assert.equal(buf[1], 0xd8);
        snapOk = true;
        break;
      }
    }
    assert.ok(snapOk, 'Expected live camera snapshot JPEG to be served');

    // Start scheduled recording via schedule evaluator
    const schedStartRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/schedule/evaluate`, { method: 'POST' });
    assert.equal(schedStartRes.status, 200);
    const schedStart = await schedStartRes.json();
    assert.equal(schedStart.schedule_active, true);
    assert.equal(schedStart.action_taken, 'started_scheduled_recording');

    await new Promise((r) => setTimeout(r, 1300));

    const recStopRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/recording/stop`, { method: 'POST' });
    assert.equal(recStopRes.status, 200);
    const recStopped = await recStopRes.json();
    assert.equal(recStopped.status, 'completed');
    assert.ok(recStopped.video_file_id);
    assert.ok(recStopped.file_size_bytes > 0);

    // Byte-range playback on the recorded video
    const recStreamRes = await fetch(`${baseUrl}/api/videos/${recStopped.video_file_id}/stream`, {
      headers: { Range: 'bytes=0-127' },
    });
    assert.equal(recStreamRes.status, 206);

    const streamStopRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/stream/stop`, { method: 'POST' });
    assert.equal(streamStopRes.status, 200);
    const streamStopped = await streamStopRes.json();
    assert.equal(streamStopped.stopped, true);

    // Schedule helper checks
    assert.equal(streamManager.isScheduleActive('08:00-18:00', new Date('2026-01-01T12:00:00')), true);
    assert.equal(streamManager.isScheduleActive('08:00-18:00', new Date('2026-01-01T22:00:00')), false);

    // Startup interrupted recording recovery check
    const staleRecId = 'rec-interrupted-test';
    const staleOutPath = path.join(tmpDir, 'stale_recording.mp4');
    fs.copyFileSync(clipPath, staleOutPath);
    db.prepare(
      `INSERT INTO recording_sessions (id, camera_id, trigger_mode, status, output_path, file_size_bytes, started_at)
       VALUES (?, ?, 'manual', 'recording', ?, ?, '2026-01-01T00:00:00Z')`
    ).run(staleRecId, archiveCam.id, staleOutPath, fs.statSync(staleOutPath).size);
    const recovered = await streamManager.recoverInterruptedRecordings(thumbnailDir);
    assert.equal(recovered, 1);
    const recoveredRow = db.prepare('SELECT status, video_file_id FROM recording_sessions WHERE id = ?').get(staleRecId);
    assert.equal(recoveredRow.status, 'interrupted');
    assert.ok(recoveredRow.video_file_id);

    // 10. Stage 2 Phase C-F: OpenCV job truthfulness, event gallery CRUD/filters, privacy redaction export, retention enforcement
    const cvJobRes = await fetch(`${baseUrl}/api/ai/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_file_id: importedVideo.id,
        engine_id: 'opencv-person-detector',
        sample_fps: 2,
        confidence_threshold: 0.45,
      }),
    });
    assert.equal(cvJobRes.status, 201);
    const cvJob = await cvJobRes.json();
    assert.ok(['completed', 'skipped'].includes(cvJob.status));

    // Seed a deterministic anonymous track & person event to verify Gallery/Timeline/Consent/Deletion endpoints
    const testTrackId = 'trk-stage2-test';
    const testEventId = 'evt-stage2-test';
    const testCropPath = path.join(thumbnailDir, 'events', `${testEventId}.jpg`);
    fs.mkdirSync(path.dirname(testCropPath), { recursive: true });
    fs.writeFileSync(testCropPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    db.prepare(
      `INSERT INTO anonymous_tracks (id, track_code, camera_id, video_file_id, first_seen_sec, last_seen_sec, event_count, best_confidence, status, created_at, updated_at)
       VALUES (?, 'TRK-GATE-0001', ?, ?, 0.25, 0.75, 1, 0.87, 'closed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    ).run(testTrackId, cam.id, importedVideo.id);
    db.prepare(
      `INSERT INTO person_events (id, video_file_id, camera_id, anonymous_track_id, event_timestamp_sec, end_timestamp_sec, confidence, frame_number, frame_count, bbox_json, crop_path, model_name, status, created_at)
       VALUES (?, ?, ?, ?, 0.5, 0.75, 0.87, 12, 3, '{"x":40,"y":20,"w":80,"h":120}', ?, 'opencv-hog-svm', 'unreviewed', '2026-01-01T00:00:00Z')`
    ).run(testEventId, importedVideo.id, cam.id, testTrackId, testCropPath);

    const eventsList = await (await fetch(`${baseUrl}/api/person-events?camera_id=${cam.id}&status=unreviewed`)).json();
    assert.equal(eventsList.length, 1);
    assert.equal(eventsList[0].track_code, 'TRK-GATE-0001');

    const videoEvents = await (await fetch(`${baseUrl}/api/videos/${importedVideo.id}/events`)).json();
    assert.equal(videoEvents.length, 1);

    const evtThumbRes = await fetch(`${baseUrl}/api/person-events/${testEventId}/thumbnail`);
    assert.equal(evtThumbRes.status, 200);

    // Review & link event to consented profile
    const patchEvtRes = await fetch(`${baseUrl}/api/person-events/${testEventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'linked', profile_id: profile.id, reviewed_by: 'Auditor 01' }),
    });
    assert.equal(patchEvtRes.status, 200);
    const patchedEvt = await patchEvtRes.json();
    assert.equal(patchedEvt.status, 'linked');
    assert.equal(patchedEvt.profile_id, profile.id);

    // Privacy-masked video export (pixelate + blur)
    const redactRes = await fetch(`${baseUrl}/api/videos/${importedVideo.id}/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'pixelate' }),
    });
    assert.equal(redactRes.status, 201);
    const redactedVideo = await redactRes.json();
    assert.equal(redactedVideo.source_origin, 'redacted_export');
    assert.equal(redactedVideo.width, 320);

    // Retention policy enforcement on an expired video
    const expVidId = 'vid-expired-test';
    const expPath = path.join(storageDir, 'expired_clip.mp4');
    fs.copyFileSync(clipPath, expPath);
    db.prepare(
      `INSERT INTO video_files (id, camera_id, filename, original_name, storage_path, sha256_hash, file_size_bytes, processing_status, source_origin, expires_at, imported_at)
       VALUES (?, ?, 'expired_clip.mp4', 'expired_clip.mp4', ?, 'abc123', 100, 'ready', 'recorded', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`
    ).run(expVidId, cam.id, expPath);
    const retRes = await fetch(`${baseUrl}/api/retention/enforce`, { method: 'POST' });
    assert.equal(retRes.status, 200);
    const retData = await retRes.json();
    assert.equal(retData.expired_videos_deleted, 1);
    assert.equal(fs.existsSync(expPath), false);

    // Delete event cleans up row and thumbnail file
    const delEvtRes = await fetch(`${baseUrl}/api/person-events/${testEventId}`, { method: 'DELETE' });
    assert.equal(delEvtRes.status, 200);
    assert.equal(fs.existsSync(testCropPath), false);

    // 11. Stage 3: Vaulted credentials, on-demand ?capture=1 snapshot, stream cap, NVR CRUD/channels, and video delete crop unlink
    const dynamicSecret = `sec-${crypto.randomBytes(6).toString('hex')}`;
    const credCamRes = await fetch(`${baseUrl}/api/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Vaulted Perimeter Cam',
        location_zone: 'South Fence',
        source_type: 'rtsp',
        stream_uri: `rtsp://operator:${dynamicSecret}@192.168.50.10:554/ch1`,
        rtsp_transport: 'tcp',
        stream_profile: 'main',
      }),
    });
    assert.equal(credCamRes.status, 201);
    const credCam = await credCamRes.json();
    assert.equal(credCam.has_credentials, true);
    assert.equal(credCam.username, 'operator');
    assert.equal(JSON.stringify(credCam).includes(dynamicSecret), false);

    // On-demand ?capture=1 snapshot while local_archive stream is stopped
    const onDemandSnapRes = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/snapshot?capture=1`);
    assert.equal(onDemandSnapRes.status, 200);
    const onDemandBuf = Buffer.from(await onDemandSnapRes.arrayBuffer());
    assert.equal(onDemandBuf[0], 0xff);
    assert.equal(onDemandBuf[1], 0xd8);

    // Enforce max_concurrent_streams=1 across Express StreamManager
    const capSetRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_concurrent_streams: '1' }),
    });
    assert.equal(capSetRes.status, 200);

    const s1 = await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/stream/start`, { method: 'POST' });
    assert.equal(s1.status, 201);

    const archiveCam2 = await (
      await fetch(`${baseUrl}/api/cameras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Lab Archive Feed 2',
          location_zone: 'Lab Bay',
          source_type: 'local_archive',
          stream_uri: clipPath,
        }),
      })
    ).json();

    const s2 = await fetch(`${baseUrl}/api/cameras/${archiveCam2.id}/stream/start`, { method: 'POST' });
    assert.equal(s2.status, 400);
    const s2Err = await s2.json();
    assert.equal(s2Err.error, 'STREAM_START_FAILED');

    await fetch(`${baseUrl}/api/cameras/${archiveCam.id}/stream/stop`, { method: 'POST' });

    // NVR CRUD, channel toggle, registration to camera, and vault isolation
    const nvrSecret = `nvr-${crypto.randomBytes(6).toString('hex')}`;
    const nvrCreateRes = await fetch(`${baseUrl}/api/nvrs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Warehouse NVR 01',
        adapter_type: 'generic_rtsp_channels',
        host: '192.168.50.90',
        port: 80,
        rtsp_port: 554,
        username: 'nvradm',
        password: nvrSecret,
        channel_count: 2,
      }),
    });
    assert.equal(nvrCreateRes.status, 201);
    const createdNvr = await nvrCreateRes.json();
    assert.equal(createdNvr.has_credentials, true);
    assert.equal(JSON.stringify(createdNvr).includes(nvrSecret), false);

    const nvrListRes = await fetch(`${baseUrl}/api/nvrs`);
    assert.equal(nvrListRes.status, 200);
    const nvrList = await nvrListRes.json();
    assert.equal(nvrList.length, 1);

    // Seed channel row representing discovered NVR stream channel
    const chId = 'nvr-ch-stage3-1';
    db.prepare(
      `INSERT INTO nvr_channels
        (id, nvr_id, channel_number, name, profile_token, main_stream_uri, width, height, fps, codec, enabled, status, created_at, updated_at)
       VALUES (?, ?, 1, 'Channel 01', 'ch1', 'rtsp://192.168.50.90:554/ch1/main', 1280, 720, 25, 'h264', 1, 'online', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    ).run(chId, createdNvr.id);

    const toggleChRes = await fetch(`${baseUrl}/api/nvrs/${createdNvr.id}/channels/${chId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggleChRes.status, 200);
    assert.equal((await toggleChRes.json()).enabled, false);

    const regChRes = await fetch(`${baseUrl}/api/nvrs/${createdNvr.id}/channels/${chId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_zone: 'Loading Bay' }),
    });
    assert.equal(regChRes.status, 201);
    const regCam = await regChRes.json();
    assert.equal(regCam.nvr_id, createdNvr.id);
    assert.equal(regCam.has_credentials, true);
    assert.equal(JSON.stringify(regCam).includes(nvrSecret), false);

    // Verify DELETE /api/videos/:id unlinks event crop thumbnail alongside video file
    const delCropPath = path.join(thumbnailDir, 'events', 'crop-vid-delete.jpg');
    fs.mkdirSync(path.dirname(delCropPath), { recursive: true });
    fs.writeFileSync(delCropPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    db.prepare(
      `INSERT INTO person_events
        (id, video_file_id, camera_id, event_timestamp_sec, confidence, frame_number, frame_count, bbox_json, crop_path, model_name, status, created_at)
       VALUES ('evt-vid-del-1', ?, ?, 0.3, 0.9, 6, 1, '{"x":5,"y":5,"w":20,"h":40}', ?, 'opencv-hog-svm', 'unreviewed', '2026-01-01T00:00:00Z')`
    ).run(importedVideo.id, cam.id, delCropPath);

    const delVidRes = await fetch(`${baseUrl}/api/videos/${importedVideo.id}`, { method: 'DELETE' });
    assert.equal(delVidRes.status, 200);
    assert.equal(fs.existsSync(delCropPath), false);

    // Verify raw SQLite DB file contains zero plaintext secrets
    const rawDbBuf = fs.readFileSync(dbPath);
    assert.equal(rawDbBuf.includes(Buffer.from(dynamicSecret, 'utf8')), false);
    assert.equal(rawDbBuf.includes(Buffer.from(nvrSecret, 'utf8')), false);

    const delNvrRes = await fetch(`${baseUrl}/api/nvrs/${createdNvr.id}`, { method: 'DELETE' });
    assert.equal(delNvrRes.status, 200);
  } finally {
    await streamManager.shutdownAll(thumbnailDir);
    await new Promise((r) => setTimeout(r, 150));
    server.closeAllConnections?.();
    server.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Local IPC bearer token authentication blocks unauthorized local callers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumaflux-auth-test-'));
  const { app, db } = await createLumaFluxApp({
    dbPath: path.join(tmpDir, 'lumaflux.db'),
    storageDir: path.join(tmpDir, 'videos'),
    thumbnailDir: path.join(tmpDir, 'thumbnails'),
    logDir: path.join(tmpDir, 'logs'),
    apiToken: 'ephemeral-session-token-123',
    skipVite: true,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);

    const unauthRes = await fetch(`${baseUrl}/api/dashboard/summary`);
    assert.equal(unauthRes.status, 401);

    const authRes = await fetch(`${baseUrl}/api/dashboard/summary`, {
      headers: { Authorization: 'Bearer ephemeral-session-token-123' },
    });
    assert.equal(authRes.status, 200);

    const auditLogs = await (
      await fetch(`${baseUrl}/api/audit-logs?limit=10`, {
        headers: { Authorization: 'Bearer ephemeral-session-token-123' },
      })
    ).json();
    assert.ok(auditLogs.some((l) => l.action === 'UNAUTHORIZED_API_ACCESS' && l.outcome === 'denied'));
  } finally {
    server.closeAllConnections?.();
    server.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
