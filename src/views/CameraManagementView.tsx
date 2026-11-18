import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  Camera,
  CheckCircle2,
  CircleDot,
  Edit3,
  FolderInput,
  HardDrive,
  Image as ImageIcon,
  Lock,
  Play,
  Plus,
  Power,
  Radar,
  RefreshCw,
  Square,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { api, formatTimestamp, resolveApiUrl } from '../api/client.ts';
import { ConfirmDialog, EmptyState, ErrorBanner, LoadingSkeleton, StatusText } from '../components/StateViews.tsx';
import type {
  CameraRecord,
  CameraSourceType,
  DiscoveredOnvifDevice,
  NvrAdapterType,
  NvrChannelRecord,
  NvrRecord,
  RecordingMode,
  RtspTransport,
  StreamProfileType,
  VerificationStages,
} from '../../shared/types.ts';

interface CameraManagementViewProps {
  cameras: CameraRecord[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

function VerificationStageStrip({ stages }: { stages: VerificationStages }) {
  const items: Array<{ key: keyof VerificationStages; label: string }> = [
    { key: 'device_discovered', label: 'Discovered' },
    { key: 'onvif_authenticated', label: 'Auth' },
    { key: 'device_info_retrieved', label: 'Info' },
    { key: 'profiles_retrieved', label: 'Profiles' },
    { key: 'rtsp_uri_retrieved', label: 'URI' },
    { key: 'rtsp_stream_opened', label: 'RTSP' },
  ];

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" title={stages.error || 'ONVIF & RTSP verification stages'}>
      {items.map((item) => {
        const passed = Boolean(stages[item.key]);
        return (
          <span
            key={item.key}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] ${
              passed
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-100 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${passed ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-600'}`}
            />
            {item.label}
          </span>
        );
      })}
    </div>
  );
}

export function CameraManagementView({
  cameras,
  loading,
  error,
  onRefresh,
}: CameraManagementViewProps) {
  // Camera create/edit state
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [zone, setZone] = useState('');
  const [sourceType, setSourceType] = useState<CameraSourceType>('rtsp');
  const [ipAddress, setIpAddress] = useState('');
  const [rtspPort, setRtspPort] = useState('554');
  const [onvifPort, setOnvifPort] = useState('80');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rtspTransport, setRtspTransport] = useState<RtspTransport>('tcp');
  const [streamProfile, setStreamProfile] = useState<StreamProfileType>('main');
  const [connectionTimeoutSec, setConnectionTimeoutSec] = useState('6');
  const [streamUri, setStreamUri] = useState('');
  const [mainStreamUri, setMainStreamUri] = useState('');
  const [subStreamUri, setSubStreamUri] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('manual');
  const [targetFps, setTargetFps] = useState('5');
  const [targetResolution, setTargetResolution] = useState('1280x720');
  const [maxReconnects, setMaxReconnects] = useState('5');
  const [recordingSchedule, setRecordingSchedule] = useState('');

  // ONVIF discovery state
  const [discovering, setDiscovering] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<DiscoveredOnvifDevice[] | null>(null);

  // Snapshot modal & live preview state
  const [previewCameraId, setPreviewCameraId] = useState<string | null>(null);
  const [snapshotModal, setSnapshotModal] = useState<{ camera: CameraRecord; url: string } | null>(null);

  // NVR state
  const [nvrs, setNvrs] = useState<NvrRecord[]>([]);
  const [nvrChannels, setNvrChannels] = useState<Record<string, NvrChannelRecord[]>>({});
  const [expandedNvrId, setExpandedNvrId] = useState<string | null>(null);
  const [showNvrForm, setShowNvrForm] = useState(false);
  const [nvrName, setNvrName] = useState('');
  const [nvrAdapter, setNvrAdapter] = useState<NvrAdapterType>('standard_onvif_rtsp');
  const [nvrHost, setNvrHost] = useState('');
  const [nvrPort, setNvrPort] = useState('80');
  const [nvrRtspPort, setNvrRtspPort] = useState('554');
  const [nvrUsername, setNvrUsername] = useState('');
  const [nvrPassword, setNvrPassword] = useState('');
  const [nvrTransport, setNvrTransport] = useState<RtspTransport>('tcp');
  const [nvrTemplate, setNvrTemplate] = useState('rtsp://{host}:{rtsp_port}/channel{channel}');
  const [nvrChannelCount, setNvrChannelCount] = useState('4');
  const [busyNvrId, setBusyNvrId] = useState<string | null>(null);
  const [deleteNvrTarget, setDeleteNvrTarget] = useState<NvrRecord | null>(null);

  // General UI state
  const [submitting, setSubmitting] = useState(false);
  const [busyCameraId, setBusyCameraId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CameraRecord | null>(null);

  const loadNvrs = useCallback(async () => {
    try {
      const list = await api.listNvrs();
      setNvrs(list);
    } catch {
      // Non-fatal if NVR listing unavailable
    }
  }, []);

  useEffect(() => {
    void loadNvrs();
  }, [loadNvrs]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setZone('');
    setSourceType('rtsp');
    setIpAddress('');
    setRtspPort('554');
    setOnvifPort('80');
    setUsername('');
    setPassword('');
    setRtspTransport('tcp');
    setStreamProfile('main');
    setConnectionTimeoutSec('6');
    setStreamUri('');
    setMainStreamUri('');
    setSubStreamUri('');
    setRetentionDays('30');
    setRecordingMode('manual');
    setTargetFps('5');
    setTargetResolution('1280x720');
    setMaxReconnects('5');
    setRecordingSchedule('');
  };

  const openEditForm = (cam: CameraRecord) => {
    setEditingId(cam.id);
    setName(cam.name);
    setZone(cam.location_zone);
    setSourceType(cam.source_type);
    setIpAddress(cam.ip_address || '');
    setRtspPort(String(cam.rtsp_port ?? 554));
    setOnvifPort(String(cam.onvif_port ?? 80));
    setUsername(cam.username || '');
    setPassword('');
    setRtspTransport(cam.rtsp_transport || 'tcp');
    setStreamProfile(cam.stream_profile || 'main');
    setConnectionTimeoutSec(String(cam.connection_timeout_sec ?? 6));
    setStreamUri(cam.stream_uri);
    setMainStreamUri(cam.main_stream_uri || '');
    setSubStreamUri(cam.sub_stream_uri || '');
    setRetentionDays(String(cam.retention_days));
    setRecordingMode(cam.recording_mode);
    setTargetFps(String(cam.target_fps ?? 5));
    setTargetResolution(cam.target_resolution || '1280x720');
    setMaxReconnects(String(cam.max_reconnect_attempts ?? 5));
    setRecordingSchedule(cam.recording_schedule || '');
    setShowCreate(true);
  };

  const handleDiscoverOnvif = async () => {
    setDiscovering(true);
    setActionError(null);
    setFeedback(null);
    try {
      const res = await api.discoverCameras({ timeout_sec: 2.0 });
      setDiscoveredDevices(res.devices);
      setFeedback(`ONVIF WS-Discovery scan completed: ${res.discovered_count} device(s) responded on local network.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'ONVIF discovery scan failed.');
    } finally {
      setDiscovering(false);
    }
  };

  const applyDiscoveredDevice = (dev: DiscoveredOnvifDevice) => {
    resetForm();
    setSourceType('onvif');
    setName(dev.name || `ONVIF Camera (${dev.host})`);
    setZone('LAN Discovered');
    setIpAddress(dev.host);
    setOnvifPort(String(dev.port || 80));
    setRtspPort('554');
    setStreamUri(dev.xaddrs[0] || `http://${dev.host}:${dev.port}/onvif/device_service`);
    setShowCreate(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);
    setFeedback(null);
    try {
      if (editingId) {
        const updatePayload: Parameters<typeof api.updateCamera>[1] = {
          name,
          location_zone: zone,
          stream_uri: streamUri,
          ip_address: ipAddress.trim() || null,
          rtsp_port: Number(rtspPort) || 554,
          onvif_port: Number(onvifPort) || 80,
          username: username.trim() || null,
          rtsp_transport: rtspTransport,
          stream_profile: streamProfile,
          main_stream_uri: mainStreamUri.trim() || null,
          sub_stream_uri: subStreamUri.trim() || null,
          connection_timeout_sec: Number(connectionTimeoutSec) || 6,
          retention_days: Number(retentionDays) || 30,
          recording_mode: recordingMode,
          target_fps: Number(targetFps) || 5,
          target_resolution: targetResolution || '1280x720',
          max_reconnect_attempts: Number(maxReconnects) || 5,
          recording_schedule: recordingSchedule.trim() || null,
        };
        if (password.length > 0) {
          updatePayload.password = password;
        }
        await api.updateCamera(editingId, updatePayload);
        setFeedback(`Updated configuration for '${name}'.`);
      } else {
        await api.createCamera({
          name,
          location_zone: zone,
          source_type: sourceType,
          stream_uri: streamUri,
          ip_address: ipAddress.trim() || null,
          rtsp_port: Number(rtspPort) || 554,
          onvif_port: Number(onvifPort) || 80,
          username: username.trim() || null,
          password: password || null,
          rtsp_transport: rtspTransport,
          stream_profile: streamProfile,
          main_stream_uri: mainStreamUri.trim() || null,
          sub_stream_uri: subStreamUri.trim() || null,
          connection_timeout_sec: Number(connectionTimeoutSec) || 6,
          enabled: true,
          retention_days: Number(retentionDays) || 30,
          recording_mode: recordingMode,
          target_fps: Number(targetFps) || 5,
          target_resolution: targetResolution || '1280x720',
          max_reconnect_attempts: Number(maxReconnects) || 5,
          recording_schedule: recordingSchedule.trim() || null,
        });
        setFeedback(`Registered camera '${name}' (credentials stored in vault). Run Probe to verify connectivity.`);
      }
      resetForm();
      setShowCreate(false);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save camera.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleEnabled = async (cam: CameraRecord) => {
    setActionError(null);
    try {
      await api.updateCamera(cam.id, { enabled: !cam.enabled });
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update camera.');
    }
  };

  const handleCheck = async (cam: CameraRecord) => {
    setBusyCameraId(cam.id);
    setActionError(null);
    setFeedback(null);
    try {
      const res = await api.checkCamera(cam.id);
      setFeedback(res.message);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to probe camera.');
    } finally {
      setBusyCameraId(null);
    }
  };

  const handleReconnect = async (cam: CameraRecord) => {
    setBusyCameraId(cam.id);
    setActionError(null);
    setFeedback(null);
    try {
      const res = await api.reconnectCamera(cam.id);
      setFeedback(
        res.stream_restarted
          ? `${res.message} · Live preview restarted.`
          : res.message
      );
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reconnect camera.');
    } finally {
      setBusyCameraId(null);
    }
  };

  const handleSnapshot = (cam: CameraRecord) => {
    setSnapshotModal({
      camera: cam,
      url: api.getCameraSnapshotUrl(cam.id, true),
    });
  };

  const handleToggleStream = async (cam: CameraRecord) => {
    setBusyCameraId(cam.id);
    setActionError(null);
    setFeedback(null);
    try {
      if (cam.active_stream_id) {
        await api.stopCameraStream(cam.id);
        if (previewCameraId === cam.id) setPreviewCameraId(null);
        setFeedback(`Stopped live stream for '${cam.name}'.`);
      } else {
        await api.startCameraStream(cam.id);
        setPreviewCameraId(cam.id);
        setFeedback(`Started live MJPEG capture worker for '${cam.name}'.`);
      }
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to toggle camera stream.');
    } finally {
      setBusyCameraId(null);
    }
  };

  const handleToggleRecording = async (cam: CameraRecord) => {
    setBusyCameraId(cam.id);
    setActionError(null);
    setFeedback(null);
    try {
      if (cam.active_recording_id) {
        const res = await api.stopCameraRecording(cam.id);
        setFeedback(
          res.status === 'failed'
            ? `Recording failed integrity check: ${res.error_message || 'unusable file'}`
            : `Saved & verified recording for '${cam.name}' (${res.file_size_bytes} bytes).`
        );
      } else {
        await api.startCameraRecording(cam.id, 'manual');
        setFeedback(`Started fragmented MP4 recording for '${cam.name}'.`);
      }
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to toggle recording.');
    } finally {
      setBusyCameraId(null);
    }
  };

  const handleIngestLocal = async (cam: CameraRecord) => {
    setBusyCameraId(cam.id);
    setActionError(null);
    setFeedback(null);
    try {
      const res = await api.ingestLocalCamera(cam.id);
      setFeedback(`Ingested ${res.ingested_count} local video file(s) from '${cam.name}' into the vault.`);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Local archive ingestion failed.');
    } finally {
      setBusyCameraId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await api.deleteCamera(deleteTarget.id);
      if (previewCameraId === deleteTarget.id) setPreviewCameraId(null);
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete camera.');
    }
  };

  // NVR handlers
  const handleCreateNvr = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setActionError(null);
    setFeedback(null);
    try {
      await api.createNvr({
        name: nvrName,
        adapter_type: nvrAdapter,
        host: nvrHost,
        port: Number(nvrPort) || 80,
        rtsp_port: Number(nvrRtspPort) || 554,
        username: nvrUsername.trim() || null,
        password: nvrPassword || null,
        rtsp_transport: nvrTransport,
        rtsp_url_template: nvrAdapter === 'generic_rtsp_channels' ? nvrTemplate.trim() || null : null,
        channel_count: Number(nvrChannelCount) || 0,
      });
      setNvrName('');
      setNvrHost('');
      setNvrUsername('');
      setNvrPassword('');
      setShowNvrForm(false);
      setFeedback(`Registered NVR '${nvrName}' (password protected in vault).`);
      await loadNvrs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create NVR.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTestNvr = async (nvr: NvrRecord) => {
    setBusyNvrId(nvr.id);
    setActionError(null);
    setFeedback(null);
    try {
      const res = await api.testNvr(nvr.id);
      setFeedback(res.message);
      await loadNvrs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'NVR connection test failed.');
    } finally {
      setBusyNvrId(null);
    }
  };

  const handleDiscoverNvrChannels = async (nvr: NvrRecord) => {
    setBusyNvrId(nvr.id);
    setActionError(null);
    setFeedback(null);
    try {
      const res = await api.discoverNvrChannels(nvr.id);
      setNvrChannels((prev) => ({ ...prev, [nvr.id]: res.channels }));
      setExpandedNvrId(nvr.id);
      setFeedback(res.message);
      await loadNvrs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to discover NVR channels.');
    } finally {
      setBusyNvrId(null);
    }
  };

  const handleToggleExpandNvr = async (nvr: NvrRecord) => {
    if (expandedNvrId === nvr.id) {
      setExpandedNvrId(null);
      return;
    }
    setExpandedNvrId(nvr.id);
    try {
      const chs = await api.listNvrChannels(nvr.id);
      setNvrChannels((prev) => ({ ...prev, [nvr.id]: chs }));
    } catch {
      // Ignore
    }
  };

  const handleToggleNvrChannelEnabled = async (nvrId: string, ch: NvrChannelRecord) => {
    try {
      const updated = await api.updateNvrChannel(nvrId, ch.id, !ch.enabled);
      setNvrChannels((prev) => ({
        ...prev,
        [nvrId]: (prev[nvrId] || []).map((c) => (c.id === ch.id ? updated : c)),
      }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update NVR channel.');
    }
  };

  const handleRegisterNvrChannel = async (nvr: NvrRecord, ch: NvrChannelRecord) => {
    setBusyNvrId(nvr.id);
    setActionError(null);
    try {
      const cam = await api.registerNvrChannel(nvr.id, ch.id, nvr.name);
      const chs = await api.listNvrChannels(nvr.id);
      setNvrChannels((prev) => ({ ...prev, [nvr.id]: chs }));
      setFeedback(`Registered NVR channel '${ch.name}' as camera '${cam.name}'.`);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to register channel.');
    } finally {
      setBusyNvrId(null);
    }
  };

  const handleDeleteNvr = async () => {
    if (!deleteNvrTarget) return;
    try {
      await api.deleteNvr(deleteNvrTarget.id);
      setDeleteNvrTarget(null);
      await loadNvrs();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete NVR.');
    }
  };

  const activePreviewCam =
    cameras.find((c) => c.id === previewCameraId && c.active_stream_id) ??
    cameras.find((c) => Boolean(c.active_stream_id)) ??
    null;

  if (loading && cameras.length === 0) return <LoadingSkeleton rows={5} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Camera & NVR Management
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Discover ONVIF devices, connect RTSP (TCP/UDP) or HTTP endpoints, manage multi-channel NVRs, stream live MJPEG previews, and record verified MP4 footage.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDiscoverOnvif}
            disabled={discovering}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
          >
            <Radar className={`h-3.5 w-3.5 ${discovering ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{discovering ? 'Scanning LAN...' : 'Discover ONVIF'}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (showCreate) {
                resetForm();
                setShowCreate(false);
              } else {
                resetForm();
                setShowCreate(true);
              }
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{showCreate ? 'Close Form' : 'Add Camera'}</span>
          </button>
        </div>
      </div>

      {(error || actionError) && (
        <ErrorBanner message={actionError || error || 'Camera error'} onRetry={onRefresh} />
      )}

      {feedback && (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] px-4 py-3 text-xs text-slate-700 dark:text-slate-300">
          {feedback}
        </div>
      )}

      {discoveredDevices !== null && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
              ONVIF WS-Discovery Results ({discoveredDevices.length})
            </h3>
            <button
              type="button"
              onClick={() => setDiscoveredDevices(null)}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
            >
              Dismiss
            </button>
          </div>
          {discoveredDevices.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No ONVIF WS-Discovery responders detected on UDP 239.255.255.250:3702 within timeout. You can still configure a camera or NVR manually by IP/host.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {discoveredDevices.map((dev, idx) => (
                <div
                  key={`${dev.endpoint_reference}-${idx}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] px-3.5 py-2.5 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-slate-100 truncate">{dev.name}</div>
                    <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {dev.host}:{dev.port} · {dev.hardware}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => applyDiscoveredDevice(dev)}
                    className="px-2.5 py-1.5 rounded text-[11px] font-semibold bg-blue-600 hover:bg-blue-700 text-white shrink-0"
                  >
                    Use Device
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activePreviewCam && (
        <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs">
              <Video className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                Live Stream · {activePreviewCam.name}
              </span>
              <span className="font-mono text-slate-500 dark:text-slate-400">
                {activePreviewCam.target_resolution || '1280x720'} · {activePreviewCam.target_fps ?? 5} fps ·{' '}
                {(activePreviewCam.rtsp_transport || 'tcp').toUpperCase()}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSnapshot(activePreviewCam)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                <span>Snapshot</span>
              </button>
              <button
                type="button"
                onClick={() => handleToggleRecording(activePreviewCam)}
                disabled={busyCameraId === activePreviewCam.id}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium ${
                  activePreviewCam.active_recording_id
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <CircleDot className="h-3.5 w-3.5" />
                <span>{activePreviewCam.active_recording_id ? 'Stop Recording' : 'Record MP4'}</span>
              </button>
              <button
                type="button"
                onClick={() => handleToggleStream(activePreviewCam)}
                disabled={busyCameraId === activePreviewCam.id}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Square className="h-3 w-3" />
                <span>Stop Stream</span>
              </button>
            </div>
          </div>
          <div className="bg-black aspect-video max-h-[380px] w-full flex items-center justify-center">
            <img
              src={resolveApiUrl(`/api/cameras/${activePreviewCam.id}/stream/mjpeg`)}
              alt={`Live stream from ${activePreviewCam.name}`}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </section>
      )}

      {showCreate && (
        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4"
        >
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            {editingId ? 'Edit Camera Endpoint' : 'Configure Camera Endpoint'}
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Camera Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. North Loading Bay"
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Location Zone
              </label>
              <input
                type="text"
                required
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                placeholder="e.g. Building A · Perimeter"
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Source Protocol
              </label>
              <select
                value={sourceType}
                disabled={Boolean(editingId)}
                onChange={(e) => setSourceType(e.target.value as CameraSourceType)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100 disabled:opacity-60"
              >
                <option value="rtsp">RTSP Stream</option>
                <option value="onvif">ONVIF Camera</option>
                <option value="http">HTTP / HLS Endpoint</option>
                <option value="local_archive">Local Video / Directory</option>
              </select>
            </div>

            {sourceType !== 'local_archive' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    IP Address / Hostname
                  </label>
                  <input
                    type="text"
                    value={ipAddress}
                    onChange={(e) => setIpAddress(e.target.value)}
                    placeholder="e.g. 192.168.1.40"
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      RTSP Port
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={rtspPort}
                      onChange={(e) => setRtspPort(e.target.value)}
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      ONVIF / HTTP Port
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={onvifPort}
                      onChange={(e) => setOnvifPort(e.target.value)}
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="admin"
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Password (Vault Encrypted)
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={editingId ? 'Leave blank to keep stored' : 'Enter password'}
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {sourceType === 'local_archive'
                  ? 'Local Video File or Directory Path'
                  : 'Primary Stream / ONVIF Service URI (Optional if IP provided)'}
              </label>
              <input
                type="text"
                required={!ipAddress || sourceType === 'local_archive'}
                value={streamUri}
                onChange={(e) => setStreamUri(e.target.value)}
                placeholder={
                  sourceType === 'onvif'
                    ? 'http://192.168.1.40:80/onvif/device_service'
                    : sourceType === 'local_archive'
                      ? '/data/archive/cam01.mp4'
                      : 'rtsp://192.168.1.40:554/stream1'
                }
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            {sourceType !== 'local_archive' && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Transport
                  </label>
                  <select
                    value={rtspTransport}
                    onChange={(e) => setRtspTransport(e.target.value as RtspTransport)}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-2 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="tcp">RTSP TCP</option>
                    <option value="udp">RTSP UDP</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Profile
                  </label>
                  <select
                    value={streamProfile}
                    onChange={(e) => setStreamProfile(e.target.value as StreamProfileType)}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-2 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="main">Main Stream</option>
                    <option value="sub">Sub Stream</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Timeout (s)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min={1.5}
                    max={30}
                    value={connectionTimeoutSec}
                    onChange={(e) => setConnectionTimeoutSec(e.target.value)}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-2 text-xs tabular-nums text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
            )}

            {sourceType !== 'local_archive' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Main Stream URI (Optional Override)
                  </label>
                  <input
                    type="text"
                    value={mainStreamUri}
                    onChange={(e) => setMainStreamUri(e.target.value)}
                    placeholder="rtsp://192.168.1.40:554/Streaming/Channels/101"
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Sub Stream URI (Optional Override)
                  </label>
                  <input
                    type="text"
                    value={subStreamUri}
                    onChange={(e) => setSubStreamUri(e.target.value)}
                    placeholder="rtsp://192.168.1.40:554/Streaming/Channels/102"
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                  />
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Retention (Days)
                </label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Recording Mode
                </label>
                <select
                  value={recordingMode}
                  onChange={(e) => setRecordingMode(e.target.value as RecordingMode)}
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                >
                  <option value="manual">Manual</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="motion_trigger">Motion Trigger</option>
                  <option value="continuous">Continuous</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Stream Sample FPS
              </label>
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={30}
                value={targetFps}
                onChange={(e) => setTargetFps(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Preview Resolution
              </label>
              <select
                value={targetResolution}
                onChange={(e) => setTargetResolution(e.target.value)}
                className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="640x360">640×360</option>
                <option value="1280x720">1280×720</option>
                <option value="1920x1080">1920×1080</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Max Reconnects
                </label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={maxReconnects}
                  onChange={(e) => setMaxReconnects(e.target.value)}
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Schedule Window
                </label>
                <input
                  type="text"
                  value={recordingSchedule}
                  onChange={(e) => setRecordingSchedule(e.target.value)}
                  placeholder="08:00-18:00"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                resetForm();
                setShowCreate(false);
              }}
              className="px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
            >
              {submitting ? 'Saving...' : editingId ? 'Save Changes' : 'Save Camera'}
            </button>
          </div>
        </form>
      )}

      {cameras.length === 0 ? (
        <EmptyState
          icon={<Camera className="h-5 w-5" />}
          title="No cameras configured"
          description="Discover an ONVIF device or add an RTSP, HTTP, or local archive source to verify connectivity, capture snapshots, stream MJPEG previews, and record MP4 footage."
          action={
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white"
            >
              Add Camera
            </button>
          }
        />
      ) : (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-3 px-5 font-medium">Camera</th>
                <th className="py-3 px-4 font-medium">Protocol & Endpoint</th>
                <th className="py-3 px-4 font-medium">Stream / Rec</th>
                <th className="py-3 px-4 font-medium">Status & Verification</th>
                <th className="py-3 px-4 font-medium">Last Checked</th>
                <th className="py-3 px-5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {cameras.map((cam) => (
                <tr key={cam.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30">
                  <td className="py-3 px-5">
                    <div className="flex items-center gap-1.5 font-medium text-slate-900 dark:text-slate-100">
                      <span>{cam.name}</span>
                      {cam.has_credentials && (
                        <span title="Password stored in OS-protected vault">
                          <Lock className="h-3 w-3 text-emerald-500" aria-hidden="true" />
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">{cam.location_zone}</div>
                    {(cam.device_manufacturer || cam.device_model) && (
                      <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                        {[cam.device_manufacturer, cam.device_model, cam.firmware_version].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-mono text-[11px] uppercase text-slate-500 dark:text-slate-400">
                      {cam.source_type}
                      {cam.source_type !== 'local_archive'
                        ? ` · ${(cam.rtsp_transport || 'tcp').toUpperCase()} · ${(cam.stream_profile || 'main').toUpperCase()}`
                        : ''}
                      {' · '}
                      {cam.recording_mode} · {cam.retention_days}d
                    </div>
                    <div className="font-mono text-slate-800 dark:text-slate-200 max-w-[260px] truncate" title={cam.stream_uri}>
                      {cam.stream_uri}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px] tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    <div>{cam.active_stream_id ? 'Streaming live' : 'Stream idle'}</div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {cam.active_recording_id ? 'Recording MP4' : 'Rec idle'}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <StatusText
                      label={!cam.enabled ? 'disabled' : cam.status}
                      tone={
                        !cam.enabled
                          ? 'neutral'
                          : cam.status === 'online'
                            ? 'success'
                            : cam.status === 'offline'
                              ? 'danger'
                              : 'warning'
                      }
                    />
                    {cam.verification_stages && <VerificationStageStrip stages={cam.verification_stages} />}
                    {cam.last_error && (
                      <div className="mt-0.5 text-[11px] text-red-500 dark:text-red-400 max-w-[260px] truncate" title={cam.last_error}>
                        {cam.last_error}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    {formatTimestamp(cam.last_checked_at)}
                  </td>
                  <td className="py-3 px-5 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleCheck(cam)}
                        disabled={busyCameraId === cam.id}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title="Probe real endpoint connectivity"
                        aria-label={`Check ${cam.name}`}
                      >
                        <Activity className={`h-3.5 w-3.5 ${busyCameraId === cam.id ? 'animate-pulse' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReconnect(cam)}
                        disabled={busyCameraId === cam.id}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title="Manual reconnect & verify stream"
                        aria-label={`Reconnect ${cam.name}`}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${busyCameraId === cam.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSnapshot(cam)}
                        disabled={!cam.enabled}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-40"
                        title="Capture live snapshot frame"
                        aria-label={`Snapshot ${cam.name}`}
                      >
                        <ImageIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleStream(cam)}
                        disabled={!cam.enabled || busyCameraId === cam.id}
                        className={`p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 ${
                          cam.active_stream_id ? 'text-emerald-500' : 'text-slate-600 dark:text-slate-300'
                        }`}
                        title={cam.active_stream_id ? 'Stop live stream' : 'Start live stream'}
                        aria-label={`${cam.active_stream_id ? 'Stop' : 'Start'} stream for ${cam.name}`}
                      >
                        {cam.active_stream_id ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleRecording(cam)}
                        disabled={!cam.enabled || busyCameraId === cam.id}
                        className={`p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 disabled:opacity-40 ${
                          cam.active_recording_id ? 'text-red-500' : 'text-slate-600 dark:text-slate-300'
                        }`}
                        title={cam.active_recording_id ? 'Stop MP4 recording' : 'Start MP4 recording'}
                        aria-label={`${cam.active_recording_id ? 'Stop' : 'Start'} recording for ${cam.name}`}
                      >
                        <CircleDot className="h-3.5 w-3.5" />
                      </button>
                      {cam.source_type === 'local_archive' && (
                        <button
                          type="button"
                          onClick={() => handleIngestLocal(cam)}
                          disabled={busyCameraId === cam.id}
                          className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-40"
                          title="Ingest local archive video files"
                          aria-label={`Ingest local videos from ${cam.name}`}
                        >
                          <FolderInput className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditForm(cam)}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title="Edit camera configuration"
                        aria-label={`Edit ${cam.name}`}
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleEnabled(cam)}
                        className="p-1.5 rounded hover:bg-slate-200/70 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title={cam.enabled ? 'Disable camera' : 'Enable camera'}
                        aria-label={`${cam.enabled ? 'Disable' : 'Enable'} ${cam.name}`}
                      >
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(cam)}
                        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                        title="Remove camera"
                        aria-label={`Delete ${cam.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Vendor-Neutral NVR & Multi-Channel Management Section */}
      <section className="space-y-4 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <HardDrive className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                NVR Devices & Multi-Channel Recorders
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Vendor-neutral NVR integration via ONVIF Profile S/T or generic RTSP channel templates. Discover channels and register them as individual cameras.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowNvrForm((v) => !v)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-md text-xs font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{showNvrForm ? 'Close NVR Form' : 'Add NVR'}</span>
          </button>
        </div>

        {showNvrForm && (
          <form
            onSubmit={handleCreateNvr}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] p-6 space-y-4"
          >
            <h4 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Configure NVR Recorder
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  NVR Name
                </label>
                <input
                  type="text"
                  required
                  value={nvrName}
                  onChange={(e) => setNvrName(e.target.value)}
                  placeholder="e.g. Warehouse Core NVR"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Protocol Adapter
                </label>
                <select
                  value={nvrAdapter}
                  onChange={(e) => setNvrAdapter(e.target.value as NvrAdapterType)}
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                >
                  <option value="standard_onvif_rtsp">Standard ONVIF + RTSP NVR</option>
                  <option value="generic_rtsp_channels">Generic RTSP Channel Template</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Host IP / Hostname
                </label>
                <input
                  type="text"
                  required
                  value={nvrHost}
                  onChange={(e) => setNvrHost(e.target.value)}
                  placeholder="192.168.1.100"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    ONVIF Port
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={nvrPort}
                    onChange={(e) => setNvrPort(e.target.value)}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-2 text-xs tabular-nums text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    RTSP Port
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={nvrRtspPort}
                    onChange={(e) => setNvrRtspPort(e.target.value)}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-2 text-xs tabular-nums text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Transport
                  </label>
                  <select
                    value={nvrTransport}
                    onChange={(e) => setNvrTransport(e.target.value as RtspTransport)}
                    className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2 py-2 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={nvrUsername}
                  onChange={(e) => setNvrUsername(e.target.value)}
                  placeholder="admin"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Password (Vault Encrypted)
                </label>
                <input
                  type="password"
                  value={nvrPassword}
                  onChange={(e) => setNvrPassword(e.target.value)}
                  placeholder="NVR password"
                  className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                />
              </div>

              {nvrAdapter === 'generic_rtsp_channels' && (
                <>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      RTSP Channel Template (placeholders: {'{host}'}, {'{rtsp_port}'}, {'{channel}'})
                    </label>
                    <input
                      type="text"
                      value={nvrTemplate}
                      onChange={(e) => setNvrTemplate(e.target.value)}
                      placeholder="rtsp://{host}:{rtsp_port}/Streaming/Channels/{channel}01"
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Channels to Probe
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={nvrChannelCount}
                      onChange={(e) => setNvrChannelCount(e.target.value)}
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowNvrForm(false)}
                className="px-4 py-2 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-md text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Save NVR'}
              </button>
            </div>
          </form>
        )}

        {nvrs.length > 0 && (
          <div className="space-y-3">
            {nvrs.map((nvr) => {
              const channels = nvrChannels[nvr.id] || [];
              const isExpanded = expandedNvrId === nvr.id;
              return (
                <div
                  key={nvr.id}
                  className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-hidden"
                >
                  <div className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                        <span>{nvr.name}</span>
                        {nvr.has_credentials && <Lock className="h-3 w-3 text-emerald-500" aria-hidden="true" />}
                        <StatusText
                          label={nvr.status}
                          tone={nvr.status === 'online' ? 'success' : nvr.status === 'offline' ? 'danger' : 'warning'}
                        />
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {nvr.adapter_type} · {nvr.host}:{nvr.port} (RTSP {nvr.rtsp_port} {nvr.rtsp_transport.toUpperCase()}) ·{' '}
                        {nvr.channel_count} channel(s)
                        {nvr.device_manufacturer || nvr.device_model
                          ? ` · ${[nvr.device_manufacturer, nvr.device_model].filter(Boolean).join(' ')}`
                          : ''}
                      </div>
                      {nvr.last_error && (
                        <div className="mt-0.5 text-[11px] text-red-500 dark:text-red-400">{nvr.last_error}</div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleTestNvr(nvr)}
                        disabled={busyNvrId === nvr.id}
                        className="px-3 py-1.5 rounded text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        Test Auth
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDiscoverNvrChannels(nvr)}
                        disabled={busyNvrId === nvr.id}
                        className="px-3 py-1.5 rounded text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                      >
                        Discover Channels
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleExpandNvr(nvr)}
                        className="px-3 py-1.5 rounded text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {isExpanded ? 'Hide Channels' : 'Channels'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteNvrTarget(nvr)}
                        className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-red-600 dark:text-red-400"
                        title="Delete NVR"
                        aria-label={`Delete ${nvr.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-slate-200 dark:border-slate-800 overflow-x-auto">
                      {channels.length === 0 ? (
                        <div className="px-5 py-4 text-xs text-slate-500 dark:text-slate-400">
                          No discovered channels stored yet. Click Discover Channels to probe the NVR.
                        </div>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-[#0B0F17]">
                              <th className="py-2 px-5 font-medium">Ch #</th>
                              <th className="py-2 px-4 font-medium">Channel Name</th>
                              <th className="py-2 px-4 font-medium">Stream Spec</th>
                              <th className="py-2 px-4 font-medium">Status</th>
                              <th className="py-2 px-5 font-medium text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                            {channels.map((ch) => (
                              <tr key={ch.id}>
                                <td className="py-2.5 px-5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                  CH-{String(ch.channel_number).padStart(2, '0')}
                                </td>
                                <td className="py-2.5 px-4">
                                  <div className="font-medium text-slate-900 dark:text-slate-100">{ch.name}</div>
                                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 max-w-[300px] truncate">
                                    {ch.main_stream_uri}
                                  </div>
                                </td>
                                <td className="py-2.5 px-4 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                                  {[
                                    ch.codec?.toUpperCase(),
                                    ch.width && ch.height ? `${ch.width}x${ch.height}` : null,
                                    ch.fps ? `${ch.fps}fps` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ') || '—'}
                                </td>
                                <td className="py-2.5 px-4">
                                  <StatusText
                                    label={ch.enabled ? ch.status : 'disabled'}
                                    tone={
                                      !ch.enabled
                                        ? 'neutral'
                                        : ch.status === 'online'
                                          ? 'success'
                                          : ch.status === 'offline'
                                            ? 'danger'
                                            : 'warning'
                                    }
                                  />
                                </td>
                                <td className="py-2.5 px-5 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleToggleNvrChannelEnabled(nvr.id, ch)}
                                      className="px-2 py-1 rounded text-[11px] border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
                                    >
                                      {ch.enabled ? 'Disable' : 'Enable'}
                                    </button>
                                    {ch.registered_camera_id ? (
                                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                        Registered
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => handleRegisterNvrChannel(nvr, ch)}
                                        disabled={busyNvrId === nvr.id}
                                        className="px-2.5 py-1 rounded text-[11px] font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                                      >
                                        Register Camera
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {snapshotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111724] overflow-hidden shadow-xl"
          >
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Snapshot · {snapshotModal.camera.name}
              </div>
              <button
                type="button"
                onClick={() => setSnapshotModal(null)}
                className="p-1 rounded text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                aria-label="Close snapshot"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="bg-black aspect-video w-full flex items-center justify-center">
              <img
                src={snapshotModal.url}
                alt={`Snapshot from ${snapshotModal.camera.name}`}
                className="max-h-full max-w-full object-contain"
              />
            </div>
            <div className="px-5 py-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>Live frame captured directly from camera stream via FFmpeg.</span>
              <button
                type="button"
                onClick={() => handleSnapshot(snapshotModal.camera)}
                className="px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Refresh Frame
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Camera Configuration"
        message={
          deleteTarget
            ? `Remove "${deleteTarget.name}" from the camera registry? Any active live streams, recordings, and vaulted credentials for this camera will be removed.`
            : ''
        }
        confirmLabel="Remove Camera"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteNvrTarget)}
        title="Delete NVR Configuration"
        message={
          deleteNvrTarget
            ? `Remove NVR "${deleteNvrTarget.name}" and its discovered channel cache?`
            : ''
        }
        confirmLabel="Remove NVR"
        destructive
        onConfirm={handleDeleteNvr}
        onCancel={() => setDeleteNvrTarget(null)}
      />
    </div>
  );
}
