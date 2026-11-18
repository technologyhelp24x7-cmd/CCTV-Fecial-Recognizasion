import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import type { DiscoveredOnvifDevice, RtspTransport, StreamProfileType, VerificationStages } from '../shared/types.ts';
import { injectUriCredentials, stripUriCredentials } from './credentialStore.ts';

const WS_DISCOVERY_MULTICAST_IP = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;

export interface OnvifProfile {
  token: string;
  name: string;
  video_source_token: string | null;
  encoding: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  rtsp_uri: string | null;
}

export interface OnvifWorkflowOutcome {
  reachable: boolean;
  status: 'online' | 'offline';
  message: string;
  error: string | null;
  manufacturer: string | null;
  model: string | null;
  firmware_version: string | null;
  serial_number: string | null;
  media_xaddr: string | null;
  profiles: OnvifProfile[];
  main_rtsp_uri: string | null;
  sub_rtsp_uri: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  stages: VerificationStages;
}

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function findFirstTagText(xml: string, localName: string): string | null {
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9_-]+:)?${localName}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function findAllTagBlocks(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}\\b([^>]*)>([\\s\\S]*?)</(?:[a-zA-Z0-9_-]+:)?${localName}>`, 'gi');
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

function buildWsSecurityHeader(username?: string | null, password?: string | null): string {
  if (!username) return '';
  const nonceRaw = crypto.randomBytes(16);
  const created = utcNowIso();
  const sha1 = crypto.createHash('sha1');
  sha1.update(Buffer.concat([nonceRaw, Buffer.from(created, 'utf8'), Buffer.from(password || '', 'utf8')]));
  const digestB64 = sha1.digest('base64');
  const nonceB64 = nonceRaw.toString('base64');
  return (
    '<s:Header>' +
    '<wsse:Security s:mustUnderstand="1" ' +
    'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
    'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
    '<wsse:UsernameToken>' +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' +
    `${digestB64}</wsse:Password>` +
    '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' +
    `${nonceB64}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    '</wsse:UsernameToken>' +
    '</wsse:Security>' +
    '</s:Header>'
  );
}

function buildSoapEnvelope(bodyXml: string, username?: string | null, password?: string | null): string {
  const header = username ? buildWsSecurityHeader(username, password) : '';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" ' +
    'xmlns:tt="http://www.onvif.org/ver10/schema">' +
    `${header}<s:Body>${bodyXml}</s:Body></s:Envelope>`
  );
}

function parseDigestChallenge(headerVal: string): Record<string, string> {
  const params: Record<string, string> = {};
  const cleaned = headerVal.replace(/^Digest\s+/i, '').trim();
  const re = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    params[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return params;
}

function buildDigestAuthHeader(
  challenge: Record<string, string>,
  method: string,
  pathAndQuery: string,
  username: string,
  password: string
): string {
  const algName = (challenge.algorithm || 'MD5').toUpperCase();
  const hashAlg = algName.includes('SHA-256') ? 'sha256' : 'md5';
  const h = (v: string) => crypto.createHash(hashAlg).update(v, 'utf8').digest('hex');

  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const opaque = challenge.opaque;
  const qopList = (challenge.qop || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const qop = qopList.includes('auth') ? 'auth' : '';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';

  let ha1 = h(`${username}:${realm}:${password}`);
  if (algName.endsWith('-SESS')) {
    ha1 = h(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = h(`${method}:${pathAndQuery}`);
  const response = qop ? h(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${pathAndQuery}"`,
    `algorithm=${algName}`,
    `response="${response}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (opaque) {
    parts.push(`opaque="${opaque}"`);
  }
  return `Digest ${parts.join(', ')}`;
}

async function soapPost(
  url: string,
  bodyXml: string,
  options: { username?: string | null; password?: string | null; includeWsse?: boolean; timeoutMs?: number } = {}
): Promise<{ status: number; xml: string | null; error: string | null }> {
  const parsed = new URL(url);
  const cleanUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname || '/onvif/device_service'}${parsed.search}`;
  const pathAndQuery = `${parsed.pathname || '/onvif/device_service'}${parsed.search}`;
  const soapXml = buildSoapEnvelope(
    bodyXml,
    options.includeWsse !== false ? options.username : undefined,
    options.includeWsse !== false ? options.password : undefined
  );
  const timeoutMs = options.timeoutMs ?? 4000;

  const doFetch = async (extraHeaders: Record<string, string> = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(cleanUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', ...extraHeaders },
        body: soapXml,
        signal: ctrl.signal,
      });
      const text = await resp.text();
      return { status: resp.status, headers: resp.headers, text };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await doFetch();
    const wwwAuth = res.headers.get('www-authenticate') || '';
    if (res.status === 401 && /digest/i.test(wwwAuth) && options.username) {
      const challenge = parseDigestChallenge(wwwAuth);
      const authHeader = buildDigestAuthHeader(
        challenge,
        'POST',
        pathAndQuery,
        options.username,
        options.password || ''
      );
      res = await doFetch({ Authorization: authHeader });
    }

    if (res.status === 401) {
      return { status: 401, xml: null, error: 'ONVIF authentication failed (HTTP 401 Unauthorized).' };
    }
    if (res.status === 403) {
      return { status: 403, xml: null, error: 'ONVIF access denied (HTTP 403 Forbidden).' };
    }
    const xml = res.text.trim();
    if (!xml) {
      return { status: res.status, xml: null, error: `Empty ONVIF response (HTTP ${res.status}).` };
    }
    const faultBlocks = findAllTagBlocks(xml, 'Fault');
    if (faultBlocks.length > 0) {
      const reason =
        findFirstTagText(faultBlocks[0], 'Text') ||
        findFirstTagText(faultBlocks[0], 'faultstring') ||
        'SOAP Fault returned.';
      const code = findFirstTagText(faultBlocks[0], 'Value') || findFirstTagText(faultBlocks[0], 'faultcode') || '';
      return { status: res.status, xml, error: code ? `${code}: ${reason}` : reason };
    }
    if (res.status >= 400) {
      return { status: res.status, xml, error: `ONVIF service returned HTTP ${res.status}.` };
    }
    return { status: res.status, xml, error: null };
  } catch (err) {
    return { status: 0, xml: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseProbeMatchXml(xmlText: string): DiscoveredOnvifDevice[] {
  const blocks = findAllTagBlocks(xmlText, 'ProbeMatch');
  const results: DiscoveredOnvifDevice[] = [];
  for (const block of blocks) {
    const epRef = findFirstTagText(block, 'Address') || '';
    const xaddrsRaw = findFirstTagText(block, 'XAddrs') || '';
    const typesRaw = findFirstTagText(block, 'Types') || '';
    const scopesRaw = findFirstTagText(block, 'Scopes') || '';
    const xaddrs = xaddrsRaw.split(/\s+/).filter((u) => u.startsWith('http://') || u.startsWith('https://'));
    if (xaddrs.length === 0) continue;
    try {
      const parsed = new URL(xaddrs[0]);
      const host = parsed.hostname;
      const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
      const servicePath = parsed.pathname || '/onvif/device_service';
      const scopes = scopesRaw.split(/\s+/).filter(Boolean);
      let name = '';
      let hardware = '';
      for (const sc of scopes) {
        const lower = sc.toLowerCase();
        if (lower.includes('/name/') && !name) {
          name = decodeURIComponent(sc.split(/\/name\//i)[1] || '').trim();
        } else if (lower.includes('/hardware/') && !hardware) {
          hardware = decodeURIComponent(sc.split(/\/hardware\//i)[1] || '').trim();
        }
      }
      results.push({
        endpoint_reference: epRef,
        xaddrs,
        host,
        port,
        service_path: servicePath,
        name: name || hardware || `ONVIF Camera (${host})`,
        hardware: hardware || 'ONVIF NVT',
        scopes,
        types: typesRaw.split(/\s+/).filter(Boolean),
      });
    } catch {
      // Ignore malformed XAddrs
    }
  }
  return results;
}

export async function discoverOnvifDevices(options: {
  timeoutMs?: number;
  targetHost?: string;
  targetPort?: number;
} = {}): Promise<DiscoveredOnvifDevice[]> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 2000, 400), 6000);
  const destHost = options.targetHost || WS_DISCOVERY_MULTICAST_IP;
  const destPort = options.targetPort ?? WS_DISCOVERY_PORT;
  const msgId = `urn:uuid:${crypto.randomUUID()}`;
  const probeXml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    '<e:Header>' +
    `<w:MessageID>${msgId}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>' +
    '</e:Envelope>';

  return new Promise((resolve) => {
    const found: DiscoveredOnvifDevice[] = [];
    const seen = new Set<string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // Ignore already closed
      }
      resolve(found);
    };

    const timer = setTimeout(finish, timeoutMs);
    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    socket.on('message', (msg) => {
      const devices = parseProbeMatchXml(msg.toString('utf8'));
      for (const dev of devices) {
        if (!seen.has(dev.xaddrs[0])) {
          seen.add(dev.xaddrs[0]);
          found.push(dev);
        }
      }
    });

    socket.bind(0, () => {
      try {
        if (!options.targetHost) {
          socket.setMulticastTTL(2);
        }
        const buf = Buffer.from(probeXml, 'utf8');
        socket.send(buf, 0, buf.length, destPort, destHost);
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  });
}

function checkTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

export async function verifyOnvifAndRtsp(params: {
  endpointUrl: string;
  username?: string | null;
  password?: string | null;
  rtspTransport?: RtspTransport;
  streamProfile?: StreamProfileType;
  timeoutSec?: number;
  probeRtspFn: (
    uri: string,
    transport: RtspTransport,
    timeoutMs: number
  ) => Promise<{
    ok: boolean;
    codec: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    error: string | null;
  }>;
}): Promise<OnvifWorkflowOutcome> {
  const stages: VerificationStages = {
    device_discovered: false,
    onvif_authenticated: false,
    device_info_retrieved: false,
    profiles_retrieved: false,
    rtsp_uri_retrieved: false,
    rtsp_stream_opened: false,
    checked_at: utcNowIso(),
  };

  const { cleanUri, username: uriUser, password: uriPass } = stripUriCredentials(params.endpointUrl);
  const effUser = params.username ?? uriUser;
  const effPass = params.password ?? uriPass;
  const rtspTransport: RtspTransport = params.rtspTransport === 'udp' ? 'udp' : 'tcp';
  const streamProfile: StreamProfileType = params.streamProfile === 'sub' ? 'sub' : 'main';
  const timeoutMs = Math.min(Math.max((params.timeoutSec ?? 6) * 1000, 1500), 15000);

  let parsed: URL;
  try {
    parsed = new URL(cleanUri);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('Invalid scheme');
    }
  } catch {
    stages.error = 'ONVIF endpoint requires a valid http:// or https:// URL.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'INVALID_ONVIF_URL',
      manufacturer: null,
      model: null,
      firmware_version: null,
      serial_number: null,
      media_xaddr: null,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }

  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const tcpOk = await checkTcp(parsed.hostname, port, Math.min(timeoutMs, 3000));
  if (!tcpOk) {
    stages.error = `TCP unreachable at ${parsed.hostname}:${port}`;
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'TCP_UNREACHABLE',
      manufacturer: null,
      model: null,
      firmware_version: null,
      serial_number: null,
      media_xaddr: null,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }
  stages.device_discovered = true;

  const deviceUrl = `${parsed.protocol}//${parsed.hostname}:${port}${parsed.pathname || '/onvif/device_service'}${parsed.search}`;

  // Preflight GetSystemDateAndTime (never sufficient by itself for online)
  const dtRes = await soapPost(
    deviceUrl,
    '<tds:GetSystemDateAndTime xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>',
    { includeWsse: false, timeoutMs: Math.min(timeoutMs, 4000) }
  );
  if (dtRes.status === 0) {
    stages.error = dtRes.error || 'ONVIF GetSystemDateAndTime failed.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_UNREACHABLE',
      manufacturer: null,
      model: null,
      firmware_version: null,
      serial_number: null,
      media_xaddr: null,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }

  // Stage 2: Authenticated GetCapabilities & GetServices
  const capRes = await soapPost(
    deviceUrl,
    '<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>All</tds:Category></tds:GetCapabilities>',
    { username: effUser, password: effPass, includeWsse: Boolean(effUser), timeoutMs: Math.min(timeoutMs, 4000) }
  );
  if (
    capRes.status === 401 ||
    capRes.status === 403 ||
    (capRes.error && /NotAuthorized|FailedAuthentication|401/i.test(capRes.error))
  ) {
    stages.error = capRes.error || 'ONVIF authentication rejected.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_AUTH_REQUIRED',
      manufacturer: null,
      model: null,
      firmware_version: null,
      serial_number: null,
      media_xaddr: null,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }

  let mediaXaddr: string | null = null;
  if (capRes.xml && !capRes.error) {
    stages.onvif_authenticated = true;
    const mediaBlock = findAllTagBlocks(capRes.xml, 'Media')[0];
    if (mediaBlock) {
      mediaXaddr = findFirstTagText(mediaBlock, 'XAddr');
    }
  }

  const svcRes = await soapPost(
    deviceUrl,
    '<tds:GetServices xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>',
    { username: effUser, password: effPass, includeWsse: Boolean(effUser), timeoutMs: Math.min(timeoutMs, 4000) }
  );
  if (svcRes.status === 401 || svcRes.status === 403) {
    stages.onvif_authenticated = false;
    stages.error = svcRes.error || 'ONVIF authentication rejected on GetServices.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_AUTH_REQUIRED',
      manufacturer: null,
      model: null,
      firmware_version: null,
      serial_number: null,
      media_xaddr: null,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }
  if (svcRes.xml && !svcRes.error) {
    stages.onvif_authenticated = true;
    for (const svc of findAllTagBlocks(svcRes.xml, 'Service')) {
      const ns = (findFirstTagText(svc, 'Namespace') || '').toLowerCase();
      const xaddr = findFirstTagText(svc, 'XAddr');
      if (ns.includes('media') && xaddr) {
        mediaXaddr = xaddr;
        break;
      }
    }
  }

  if (!stages.onvif_authenticated) {
    stages.error = capRes.error || svcRes.error || 'ONVIF capability check failed.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_CAPABILITIES_FAILED',
      manufacturer: null,
      model: null,
      firmware_version: null,
      serial_number: null,
      media_xaddr: null,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }

  // Stage 3: GetDeviceInformation
  const infoRes = await soapPost(
    deviceUrl,
    '<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>',
    { username: effUser, password: effPass, includeWsse: Boolean(effUser), timeoutMs: Math.min(timeoutMs, 4000) }
  );
  let manufacturer: string | null = null;
  let model: string | null = null;
  let firmwareVersion: string | null = null;
  let serialNumber: string | null = null;
  if (infoRes.xml && !infoRes.error) {
    manufacturer = findFirstTagText(infoRes.xml, 'Manufacturer');
    model = findFirstTagText(infoRes.xml, 'Model');
    firmwareVersion = findFirstTagText(infoRes.xml, 'FirmwareVersion');
    serialNumber = findFirstTagText(infoRes.xml, 'SerialNumber');
    if (manufacturer || model || firmwareVersion || serialNumber) {
      stages.device_info_retrieved = true;
    }
  }

  // Stage 4: GetProfiles
  if (!mediaXaddr) {
    mediaXaddr = `${parsed.protocol}//${parsed.hostname}:${port}/onvif/media_service`;
  }
  const profRes = await soapPost(
    mediaXaddr,
    '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>',
    { username: effUser, password: effPass, includeWsse: Boolean(effUser), timeoutMs: Math.min(timeoutMs, 4000) }
  );
  const profiles: OnvifProfile[] = [];
  if (profRes.xml && !profRes.error) {
    const profileBlocks = findAllTagBlocks(profRes.xml, 'Profiles');
    for (const block of profileBlocks) {
      const tokenMatch = block.match(/token="([^"]+)"/i);
      const token = tokenMatch?.[1] || findFirstTagText(block, 'Token');
      if (!token) continue;
      const pname = findFirstTagText(block, 'Name') || token;
      const vscBlock = findAllTagBlocks(block, 'VideoSourceConfiguration')[0] || '';
      const vsToken = vscBlock ? findFirstTagText(vscBlock, 'SourceToken') : null;
      const vecBlock = findAllTagBlocks(block, 'VideoEncoderConfiguration')[0] || '';
      const encoding = vecBlock ? findFirstTagText(vecBlock, 'Encoding') : null;
      const wTxt = vecBlock ? findFirstTagText(vecBlock, 'Width') : null;
      const hTxt = vecBlock ? findFirstTagText(vecBlock, 'Height') : null;
      const fTxt = vecBlock ? findFirstTagText(vecBlock, 'FrameRateLimit') : null;
      profiles.push({
        token,
        name: pname,
        video_source_token: vsToken,
        encoding,
        width: wTxt ? Number(wTxt) : null,
        height: hTxt ? Number(hTxt) : null,
        fps: fTxt ? Number(fTxt) : null,
        rtsp_uri: null,
      });
    }
  }

  if (profiles.length === 0) {
    stages.error = profRes.error || 'ONVIF GetProfiles returned zero media profiles.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_NO_PROFILES',
      manufacturer,
      model,
      firmware_version: firmwareVersion,
      serial_number: serialNumber,
      media_xaddr: mediaXaddr,
      profiles: [],
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }
  stages.profiles_retrieved = true;

  // Stage 5: GetStreamUri
  for (const prof of profiles.slice(0, 4)) {
    const uriRes = await soapPost(
      mediaXaddr,
      '<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">' +
        '<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>' +
        '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>' +
        `<trt:ProfileToken>${escapeXml(prof.token)}</trt:ProfileToken>` +
        '</trt:GetStreamUri>',
      { username: effUser, password: effPass, includeWsse: Boolean(effUser), timeoutMs: Math.min(timeoutMs, 4000) }
    );
    if (uriRes.xml) {
      const rawUri = findFirstTagText(uriRes.xml, 'Uri');
      if (rawUri && /^rtsps?:\/\//i.test(rawUri)) {
        prof.rtsp_uri = stripUriCredentials(rawUri).cleanUri;
      }
    }
  }

  const withUri = profiles.filter((p) => Boolean(p.rtsp_uri));
  if (withUri.length === 0) {
    stages.error = 'ONVIF GetStreamUri did not return an RTSP stream URI.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_NO_STREAM_URI',
      manufacturer,
      model,
      firmware_version: firmwareVersion,
      serial_number: serialNumber,
      media_xaddr: mediaXaddr,
      profiles,
      main_rtsp_uri: null,
      sub_rtsp_uri: null,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }
  stages.rtsp_uri_retrieved = true;

  const mainRtsp = withUri[0].rtsp_uri!;
  const subRtsp = withUri.length > 1 ? withUri[1].rtsp_uri : null;
  const selectedUri = streamProfile === 'sub' && subRtsp ? subRtsp : mainRtsp;
  const runtimeRtsp = injectUriCredentials(selectedUri, effUser, effPass);

  // Stage 6: Open actual RTSP video stream via FFprobe
  const rtspOutcome = await params.probeRtspFn(runtimeRtsp, rtspTransport, timeoutMs);
  if (!rtspOutcome.ok) {
    stages.error = rtspOutcome.error || 'ONVIF RTSP stream failed to open.';
    return {
      reachable: false,
      status: 'offline',
      message: stages.error,
      error: 'ONVIF_RTSP_OPEN_FAILED',
      manufacturer,
      model,
      firmware_version: firmwareVersion,
      serial_number: serialNumber,
      media_xaddr: mediaXaddr,
      profiles,
      main_rtsp_uri: mainRtsp,
      sub_rtsp_uri: subRtsp,
      codec: null,
      width: null,
      height: null,
      fps: null,
      stages,
    };
  }

  stages.rtsp_stream_opened = true;
  const label = [manufacturer, model].filter(Boolean).join(' ') || 'ONVIF Camera';
  return {
    reachable: true,
    status: 'online',
    message: `${label}: ONVIF authenticated, ${profiles.length} profile(s) retrieved, RTSP (${rtspTransport.toUpperCase()}) stream verified (${rtspOutcome.codec || 'video'} ${rtspOutcome.width || '?'}x${rtspOutcome.height || '?'}).`,
    error: null,
    manufacturer,
    model,
    firmware_version: firmwareVersion,
    serial_number: serialNumber,
    media_xaddr: mediaXaddr,
    profiles,
    main_rtsp_uri: mainRtsp,
    sub_rtsp_uri: subRtsp,
    codec: rtspOutcome.codec,
    width: rtspOutcome.width,
    height: rtspOutcome.height,
    fps: rtspOutcome.fps,
    stages,
  };
}
