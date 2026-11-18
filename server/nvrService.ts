import type { NvrAdapterType, RtspTransport } from '../shared/types.ts';
import { ffprobeStream, sanitizeLogText } from './cameraService.ts';
import { injectUriCredentials, stripUriCredentials } from './credentialStore.ts';
import { verifyOnvifAndRtsp } from './onvifClient.ts';

export interface DiscoveredNvrChannel {
  channel_number: number;
  name: string;
  profile_token: string | null;
  main_stream_uri: string;
  sub_stream_uri: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  status: 'online' | 'offline';
  error: string | null;
}

export interface NvrConnectionTestOutcome {
  reachable: boolean;
  status: 'online' | 'offline';
  message: string;
  error: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware_version: string | null;
}

export interface NvrChannelDiscoveryOutcome {
  nvr_status: 'online' | 'offline';
  message: string;
  manufacturer: string | null;
  model: string | null;
  firmware_version: string | null;
  channels: DiscoveredNvrChannel[];
}

export interface NvrAdapterParams {
  host: string;
  port: number;
  rtspPort: number;
  username?: string | null;
  password?: string | null;
  rtspTransport: RtspTransport;
  rtspUrlTemplate?: string | null;
  channelCount: number;
}

export interface NvrProtocolAdapter {
  adapterId: NvrAdapterType;
  testConnection(params: NvrAdapterParams): Promise<NvrConnectionTestOutcome>;
  discoverChannels(params: NvrAdapterParams): Promise<NvrChannelDiscoveryOutcome>;
}

const DEFAULT_GENERIC_TEMPLATE = 'rtsp://{host}:{rtsp_port}/channel{channel}';

function renderRtspTemplate(template: string, host: string, rtspPort: number, channel: number): string {
  const rendered = template
    .replace(/\{host\}/g, host)
    .replace(/\{rtsp_port\}/g, String(rtspPort))
    .replace(/\{port\}/g, String(rtspPort))
    .replace(/\{channel\}/g, String(channel))
    .replace(/\{ch\}/g, String(channel));
  return stripUriCredentials(rendered).cleanUri;
}

class StandardOnvifRtspNvrAdapter implements NvrProtocolAdapter {
  public readonly adapterId: NvrAdapterType = 'standard_onvif_rtsp';

  public async testConnection(params: NvrAdapterParams): Promise<NvrConnectionTestOutcome> {
    const endpoint = `http://${params.host}:${params.port}/onvif/device_service`;
    const res = await verifyOnvifAndRtsp({
      endpointUrl: endpoint,
      username: params.username,
      password: params.password,
      rtspTransport: params.rtspTransport,
      streamProfile: 'main',
      timeoutSec: 6,
      probeRtspFn: (uri, transport, ms) => ffprobeStream(uri, { rtspTransport: transport, timeoutMs: ms }),
    });
    if (res.stages.onvif_authenticated) {
      const label = [res.manufacturer, res.model].filter(Boolean).join(' ') || 'ONVIF NVR';
      return {
        reachable: true,
        status: 'online',
        message: `${label}: ONVIF authenticated, ${res.profiles.length} channel profile(s) available.`,
        error: null,
        manufacturer: res.manufacturer,
        model: res.model,
        firmware_version: res.firmware_version,
      };
    }
    return {
      reachable: false,
      status: 'offline',
      message: sanitizeLogText(res.message, endpoint, params.password),
      error: res.error,
      manufacturer: res.manufacturer,
      model: res.model,
      firmware_version: res.firmware_version,
    };
  }

  public async discoverChannels(params: NvrAdapterParams): Promise<NvrChannelDiscoveryOutcome> {
    const endpoint = `http://${params.host}:${params.port}/onvif/device_service`;
    const res = await verifyOnvifAndRtsp({
      endpointUrl: endpoint,
      username: params.username,
      password: params.password,
      rtspTransport: params.rtspTransport,
      streamProfile: 'main',
      timeoutSec: 6,
      probeRtspFn: (uri, transport, ms) => ffprobeStream(uri, { rtspTransport: transport, timeoutMs: ms }),
    });

    if (!res.stages.onvif_authenticated) {
      return {
        nvr_status: 'offline',
        message: sanitizeLogText(res.message, endpoint, params.password),
        manufacturer: res.manufacturer,
        model: res.model,
        firmware_version: res.firmware_version,
        channels: [],
      };
    }

    const grouped = new Map<string, typeof res.profiles>();
    res.profiles.forEach((prof, idx) => {
      const key = prof.video_source_token || `profile-${idx + 1}`;
      const list = grouped.get(key) || [];
      list.push(prof);
      grouped.set(key, list);
    });

    const maxChannels = Math.min(Math.max(params.channelCount || grouped.size || 1, 1), 256);
    const channels: DiscoveredNvrChannel[] = [];
    let chNum = 1;
    for (const [, profs] of Array.from(grouped.entries()).slice(0, maxChannels)) {
      const mainP = profs[0];
      const subP = profs.length > 1 ? profs[1] : null;
      const mainUri = mainP.rtsp_uri || '';
      const subUri = subP?.rtsp_uri || null;
      let chStatus: 'online' | 'offline' = 'offline';
      let chErr: string | null = null;
      let codec = mainP.encoding;
      let width = mainP.width;
      let height = mainP.height;
      let fps = mainP.fps;

      if (mainUri) {
        const runtimeUri = injectUriCredentials(mainUri, params.username, params.password);
        const probe = await ffprobeStream(runtimeUri, { rtspTransport: params.rtspTransport, timeoutMs: 5000 });
        if (probe.ok) {
          chStatus = 'online';
          codec = probe.codec || codec;
          width = probe.width || width;
          height = probe.height || height;
          fps = probe.fps || fps;
        } else {
          chErr = sanitizeLogText(probe.error || 'Channel RTSP unreachable', runtimeUri, params.password);
        }
      } else {
        chErr = 'ONVIF profile returned no RTSP URI.';
      }

      channels.push({
        channel_number: chNum,
        name: mainP.name || `Channel ${String(chNum).padStart(2, '0')}`,
        profile_token: mainP.token,
        main_stream_uri: mainUri,
        sub_stream_uri: subUri,
        width,
        height,
        fps,
        codec,
        status: chStatus,
        error: chErr,
      });
      chNum++;
    }

    const onlineCnt = channels.filter((c) => c.status === 'online').length;
    return {
      nvr_status: 'online',
      message: `Discovered ${channels.length} ONVIF NVR channel(s) (${onlineCnt} online).`,
      manufacturer: res.manufacturer,
      model: res.model,
      firmware_version: res.firmware_version,
      channels,
    };
  }
}

class GenericRtspChannelsNvrAdapter implements NvrProtocolAdapter {
  public readonly adapterId: NvrAdapterType = 'generic_rtsp_channels';

  public async testConnection(params: NvrAdapterParams): Promise<NvrConnectionTestOutcome> {
    const tmpl = (params.rtspUrlTemplate || '').trim() || DEFAULT_GENERIC_TEMPLATE;
    const cleanCh1 = renderRtspTemplate(tmpl, params.host, params.rtspPort, 1);
    const runtimeUri = injectUriCredentials(cleanCh1, params.username, params.password);
    const probe = await ffprobeStream(runtimeUri, { rtspTransport: params.rtspTransport, timeoutMs: 5000 });
    if (probe.ok) {
      return {
        reachable: true,
        status: 'online',
        message: `Generic RTSP NVR channel 1 verified (${probe.codec || 'video'} ${probe.width || '?'}x${probe.height || '?'}).`,
        error: null,
        manufacturer: null,
        model: null,
        firmware_version: null,
      };
    }
    return {
      reachable: false,
      status: 'offline',
      message: sanitizeLogText(probe.error || 'NVR RTSP channel 1 unreachable.', runtimeUri, params.password),
      error: 'NVR_RTSP_UNREACHABLE',
      manufacturer: null,
      model: null,
      firmware_version: null,
    };
  }

  public async discoverChannels(params: NvrAdapterParams): Promise<NvrChannelDiscoveryOutcome> {
    const tmpl = (params.rtspUrlTemplate || '').trim() || DEFAULT_GENERIC_TEMPLATE;
    const total = Math.min(Math.max(params.channelCount || 4, 1), 256);
    const probeTimeout = total > 16 ? 2000 : 4000;
    const channels: DiscoveredNvrChannel[] = [];
    for (let chNum = 1; chNum <= total; chNum++) {
      const cleanUri = renderRtspTemplate(tmpl, params.host, params.rtspPort, chNum);
      const runtimeUri = injectUriCredentials(cleanUri, params.username, params.password);
      const probe = await ffprobeStream(runtimeUri, { rtspTransport: params.rtspTransport, timeoutMs: probeTimeout });
      channels.push({
        channel_number: chNum,
        name: `Channel ${String(chNum).padStart(2, '0')}`,
        profile_token: `ch${chNum}`,
        main_stream_uri: cleanUri,
        sub_stream_uri: null,
        width: probe.ok ? probe.width : null,
        height: probe.ok ? probe.height : null,
        fps: probe.ok ? probe.fps : null,
        codec: probe.ok ? probe.codec : null,
        status: probe.ok ? 'online' : 'offline',
        error: probe.ok ? null : sanitizeLogText(probe.error || 'Channel offline', runtimeUri, params.password),
      });
    }
    const onlineCnt = channels.filter((c) => c.status === 'online').length;
    return {
      nvr_status: onlineCnt > 0 ? 'online' : 'offline',
      message: `Probed ${channels.length} RTSP template channel(s) (${onlineCnt} online).`,
      manufacturer: null,
      model: null,
      firmware_version: null,
      channels,
    };
  }
}

const ADAPTERS: Record<NvrAdapterType, NvrProtocolAdapter> = {
  standard_onvif_rtsp: new StandardOnvifRtspNvrAdapter(),
  generic_rtsp_channels: new GenericRtspChannelsNvrAdapter(),
};

export function getNvrAdapter(adapterType: string): NvrProtocolAdapter {
  if (adapterType === 'generic_rtsp_channels') {
    return ADAPTERS.generic_rtsp_channels;
  }
  return ADAPTERS.standard_onvif_rtsp;
}

export async function testSingleNvrChannel(params: {
  mainStreamUri: string;
  username?: string | null;
  password?: string | null;
  rtspTransport: RtspTransport;
  timeoutMs?: number;
}): Promise<{
  reachable: boolean;
  status: 'online' | 'offline';
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  message: string;
  error: string | null;
}> {
  const { cleanUri } = stripUriCredentials(params.mainStreamUri);
  const runtimeUri = injectUriCredentials(cleanUri, params.username, params.password);
  const probe = await ffprobeStream(runtimeUri, {
    rtspTransport: params.rtspTransport,
    timeoutMs: params.timeoutMs ?? 5000,
  });
  if (probe.ok) {
    return {
      reachable: true,
      status: 'online',
      codec: probe.codec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      message: `Channel verified (${probe.codec || 'video'} ${probe.width || '?'}x${probe.height || '?'}).`,
      error: null,
    };
  }
  const cleanErr = sanitizeLogText(probe.error || 'Channel RTSP stream unreachable.', runtimeUri, params.password);
  return {
    reachable: false,
    status: 'offline',
    codec: null,
    width: null,
    height: null,
    fps: null,
    message: cleanErr,
    error: cleanErr,
  };
}
