"""Full ONVIF WS-Discovery, WS-UsernameToken / HTTP Digest authentication, and 6-stage RTSP verification."""

from __future__ import annotations

import base64
import hashlib
import os
import re
import socket
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from urllib.parse import unquote, urlparse, urlunparse

from backend.app.core.credentials import inject_uri_credentials, sanitize_secret_text, strip_uri_credentials

_WS_DISCOVERY_MULTICAST_IP = "239.255.255.250"
_WS_DISCOVERY_PORT = 3702


@dataclass
class VerificationStages:
    device_discovered: bool = False
    onvif_authenticated: bool = False
    device_info_retrieved: bool = False
    profiles_retrieved: bool = False
    rtsp_uri_retrieved: bool = False
    rtsp_stream_opened: bool = False
    checked_at: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OnvifProfile:
    token: str
    name: str
    video_source_token: Optional[str] = None
    encoding: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    rtsp_uri: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OnvifWorkflowResult:
    reachable: bool
    status: str  # 'online' | 'offline'
    message: str
    error: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware_version: Optional[str] = None
    serial_number: Optional[str] = None
    hardware_id: Optional[str] = None
    media_xaddr: Optional[str] = None
    profiles: list[OnvifProfile] = field(default_factory=list)
    main_rtsp_uri: Optional[str] = None
    sub_rtsp_uri: Optional[str] = None
    codec: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    stages: VerificationStages = field(default_factory=VerificationStages)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["profiles"] = [p.to_dict() for p in self.profiles]
        data["stages"] = self.stages.to_dict()
        return data


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_all_local(root: ET.Element, local_name: str) -> list[ET.Element]:
    return [el for el in root.iter() if _xml_local_name(el.tag) == local_name]


def _find_first_text(root: ET.Element, local_name: str) -> Optional[str]:
    for el in root.iter():
        if _xml_local_name(el.tag) == local_name and el.text and el.text.strip():
            return el.text.strip()
    return None


def _escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _build_ws_security_header(username: Optional[str], password: Optional[str]) -> str:
    if not username:
        return ""
    nonce_raw = os.urandom(16)
    created = _utc_now_iso()
    digest_input = nonce_raw + created.encode("utf-8") + (password or "").encode("utf-8")
    digest_b64 = base64.b64encode(hashlib.sha1(digest_input).digest()).decode("ascii")
    nonce_b64 = base64.b64encode(nonce_raw).decode("ascii")
    return (
        '<s:Header>'
        '<wsse:Security s:mustUnderstand="1" '
        'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" '
        'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">'
        "<wsse:UsernameToken>"
        f"<wsse:Username>{_escape_xml(username)}</wsse:Username>"
        '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
        f"{digest_b64}</wsse:Password>"
        '<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">'
        f"{nonce_b64}</wsse:Nonce>"
        f"<wsu:Created>{created}</wsu:Created>"
        "</wsse:UsernameToken>"
        "</wsse:Security>"
        "</s:Header>"
    )


def _build_soap_envelope(body_xml: str, username: Optional[str] = None, password: Optional[str] = None) -> bytes:
    header = _build_ws_security_header(username, password)
    xml_str = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
        'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
        'xmlns:tr2="http://www.onvif.org/ver20/media/wsdl" '
        'xmlns:tt="http://www.onvif.org/ver10/schema">'
        f"{header}"
        f"<s:Body>{body_xml}</s:Body>"
        "</s:Envelope>"
    )
    return xml_str.encode("utf-8")


def _parse_digest_challenge(header_val: str) -> dict[str, str]:
    params: dict[str, str] = {}
    raw = re.sub(r"^Digest\s+", "", header_val.strip(), flags=re.IGNORECASE)
    for match in re.finditer(r'([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^,\s]+))', raw):
        params[match.group(1).lower()] = match.group(2) if match.group(2) is not None else (match.group(3) or "")
    return params


def _build_digest_auth_header(
    challenge: dict[str, str],
    method: str,
    path_and_query: str,
    username: str,
    password: str,
) -> str:
    alg_name = (challenge.get("algorithm") or "MD5").upper()
    hash_fn = hashlib.sha256 if "SHA-256" in alg_name else hashlib.md5

    def h(data: str) -> str:
        return hash_fn(data.encode("utf-8")).hexdigest()

    realm = challenge.get("realm", "")
    nonce = challenge.get("nonce", "")
    opaque = challenge.get("opaque")
    qop_raw = challenge.get("qop", "")
    qop = "auth" if "auth" in [q.strip().lower() for q in qop_raw.split(",") if q.strip()] else ""

    ha1 = h(f"{username}:{realm}:{password}")
    if alg_name.endswith("-SESS"):
        cnonce = os.urandom(8).hex()
        ha1 = h(f"{ha1}:{nonce}:{cnonce}")
    else:
        cnonce = os.urandom(8).hex()

    ha2 = h(f"{method}:{path_and_query}")
    nc = "00000001"
    if qop:
        response = h(f"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}")
    else:
        response = h(f"{ha1}:{nonce}:{ha2}")

    parts = [
        f'username="{username}"',
        f'realm="{realm}"',
        f'nonce="{nonce}"',
        f'uri="{path_and_query}"',
        f'algorithm={alg_name}',
        f'response="{response}"',
    ]
    if qop:
        parts.append(f"qop={qop}")
        parts.append(f"nc={nc}")
        parts.append(f'cnonce="{cnonce}"')
    if opaque:
        parts.append(f'opaque="{opaque}"')
    return "Digest " + ", ".join(parts)


def _soap_post(
    url: str,
    body_xml: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    include_wsse: bool = True,
    timeout_sec: float = 4.0,
) -> tuple[int, Optional[ET.Element], Optional[str]]:
    """Send an ONVIF SOAP 1.2 request with optional WS-Security and automatic HTTP Digest retry."""
    parsed = urlparse(url)
    clean_netloc = parsed.hostname or ""
    if ":" in clean_netloc and not clean_netloc.startswith("["):
        clean_netloc = f"[{clean_netloc}]"
    if parsed.port:
        clean_netloc = f"{clean_netloc}:{parsed.port}"
    clean_url = urlunparse((parsed.scheme, clean_netloc, parsed.path or "/onvif/device_service", "", parsed.query, ""))
    uri_path = (parsed.path or "/onvif/device_service") + (f"?{parsed.query}" if parsed.query else "")

    payload = _build_soap_envelope(body_xml, username if include_wsse else None, password if include_wsse else None)
    headers = {"Content-Type": "application/soap+xml; charset=utf-8"}

    def _send(extra_headers: dict[str, str]) -> tuple[int, bytes]:
        req = urllib.request.Request(clean_url, data=payload, headers={**headers, **extra_headers}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                return resp.status, resp.read(262144)
        except urllib.error.HTTPError as exc:
            challenge = exc.headers.get("WWW-Authenticate", "") if exc.headers else ""
            raw_err = exc.read(65536) if hasattr(exc, "read") else b""
            if exc.code == 401 and "digest" in challenge.lower() and username is not None and not extra_headers.get("Authorization"):
                digest_params = _parse_digest_challenge(challenge)
                auth_hdr = _build_digest_auth_header(digest_params, "POST", uri_path, username, password or "")
                return _send({"Authorization": auth_hdr})
            return exc.code, raw_err

    try:
        status, raw_bytes = _send({})
    except Exception as exc:
        return 0, None, sanitize_secret_text(str(exc), password, url)

    if status == 401:
        return 401, None, "ONVIF authentication failed (HTTP 401 Unauthorized)."
    if status == 403:
        return 403, None, "ONVIF access denied (HTTP 403 Forbidden)."
    if status == 0:
        return 0, None, "No response from ONVIF endpoint."

    text = raw_bytes.decode("utf-8", errors="ignore").strip()
    if not text:
        return status, None, f"Empty ONVIF response (HTTP {status})."

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        return status, None, f"Malformed XML from ONVIF service (HTTP {status}): {exc}"

    faults = _find_all_local(root, "Fault")
    if faults:
        reason = _find_first_text(faults[0], "Text") or _find_first_text(faults[0], "faultstring") or "SOAP Fault returned."
        subcode = _find_first_text(faults[0], "Value") or _find_first_text(faults[0], "faultcode") or ""
        combined = f"{subcode}: {reason}" if subcode else reason
        return status, root, combined

    if status >= 400:
        return status, root, f"ONVIF service returned HTTP {status}."
    return status, root, None


def _parse_probe_match_xml(xml_text: str) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return devices

    for match in _find_all_local(root, "ProbeMatch"):
        ep_ref = _find_first_text(match, "Address") or ""
        xaddrs_raw = _find_first_text(match, "XAddrs") or ""
        types_raw = _find_first_text(match, "Types") or ""
        scopes_raw = _find_first_text(match, "Scopes") or ""
        xaddrs = [x for x in xaddrs_raw.split() if x.startswith(("http://", "https://"))]
        if not xaddrs:
            continue
        parsed = urlparse(xaddrs[0])
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        service_path = parsed.path or "/onvif/device_service"
        scopes = [s for s in scopes_raw.split() if s]

        name = ""
        hardware = ""
        for sc in scopes:
            low = sc.lower()
            if "/name/" in low and not name:
                name = unquote(sc.split("/name/", 1)[-1]).strip()
            elif "/hardware/" in low and not hardware:
                hardware = unquote(sc.split("/hardware/", 1)[-1]).strip()

        devices.append(
            {
                "endpoint_reference": ep_ref,
                "xaddrs": xaddrs,
                "host": host,
                "port": port,
                "service_path": service_path,
                "name": name or hardware or f"ONVIF Camera ({host})",
                "hardware": hardware or "ONVIF NVT",
                "scopes": scopes,
                "types": [t for t in types_raw.split() if t],
            }
        )
    return devices


def discover_onvif_devices(
    timeout_sec: float = 2.0,
    target_host: Optional[str] = None,
    target_port: int = _WS_DISCOVERY_PORT,
) -> list[dict[str, Any]]:
    """Send real ONVIF WS-Discovery UDP multicast/unicast Probe and parse ProbeMatches."""
    msg_id = f"urn:uuid:{uuid.uuid4()}"
    probe_xml = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
        'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        "<e:Header>"
        f"<w:MessageID>{msg_id}</w:MessageID>"
        "<w:To e:mustUnderstand=\"true\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"
        "<w:Action e:mustUnderstand=\"true\">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>"
        "</e:Header>"
        "<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>"
        "</e:Envelope>"
    ).encode("utf-8")

    dest_ip = target_host or _WS_DISCOVERY_MULTICAST_IP
    seen_xaddrs: set[str] = set()
    found: list[dict[str, Any]] = []

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.settimeout(max(0.4, min(timeout_sec, 6.0)))
        if not target_host:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.sendto(probe_xml, (dest_ip, target_port))

        deadline = datetime.now(timezone.utc).timestamp() + max(0.4, min(timeout_sec, 6.0))
        while datetime.now(timezone.utc).timestamp() < deadline:
            remaining = deadline - datetime.now(timezone.utc).timestamp()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, _addr = sock.recvfrom(65535)
            except socket.timeout:
                break
            except OSError:
                break
            for item in _parse_probe_match_xml(data.decode("utf-8", errors="ignore")):
                key = item["xaddrs"][0]
                if key not in seen_xaddrs:
                    seen_xaddrs.add(key)
                    found.append(item)
    except OSError:
        # Multicast blocked or host network unreachable: return what was found cleanly
        pass
    finally:
        sock.close()

    return found


def verify_onvif_and_rtsp(
    endpoint_url: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    rtsp_transport: str = "tcp",
    stream_profile: str = "main",
    timeout_sec: float = 6.0,
    rtsp_probe_fn: Optional[Callable[[str, str, float], tuple[bool, dict, Optional[str]]]] = None,
) -> OnvifWorkflowResult:
    """Execute full 6-stage ONVIF + RTSP verification without ever faking online status."""
    stages = VerificationStages(checked_at=_utc_now_iso())
    clean_ep, url_user, url_pass = strip_uri_credentials(endpoint_url)
    eff_user = username if username is not None else url_user
    eff_pass = password if password is not None else url_pass

    parsed = urlparse(clean_ep)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        stages.error = "ONVIF endpoint requires a valid http:// or https:// URL."
        return OnvifWorkflowResult(False, "offline", stages.error, error="INVALID_ONVIF_URL", stages=stages)

    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    # Stage 1: Discovery / TCP reachability
    try:
        with socket.create_connection((parsed.hostname, port), timeout=min(timeout_sec, 3.0)):
            stages.device_discovered = True
    except OSError as exc:
        stages.error = f"TCP unreachable at {parsed.hostname}:{port} ({exc})"
        return OnvifWorkflowResult(False, "offline", stages.error, error="TCP_UNREACHABLE", stages=stages)

    device_url = urlunparse(
        (
            parsed.scheme,
            f"{parsed.hostname}:{port}",
            parsed.path or "/onvif/device_service",
            "",
            parsed.query,
            "",
        )
    )

    # Preflight: GetSystemDateAndTime (does NOT satisfy authentication or mark camera online)
    dt_status, _dt_root, dt_err = _soap_post(
        device_url,
        '<tds:GetSystemDateAndTime xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>',
        include_wsse=False,
        timeout_sec=min(timeout_sec, 4.0),
    )
    if dt_status == 0:
        stages.error = dt_err or "ONVIF GetSystemDateAndTime failed."
        return OnvifWorkflowResult(False, "offline", stages.error, error="ONVIF_UNREACHABLE", stages=stages)

    # Stage 2: Authenticated GetCapabilities + GetServices
    cap_status, cap_root, cap_err = _soap_post(
        device_url,
        '<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>All</tds:Category></tds:GetCapabilities>',
        username=eff_user,
        password=eff_pass,
        include_wsse=bool(eff_user),
        timeout_sec=min(timeout_sec, 4.0),
    )
    if cap_status in (401, 403) or (cap_err and ("NotAuthorized" in cap_err or "FailedAuthentication" in cap_err or "401" in cap_err)):
        stages.error = sanitize_secret_text(cap_err or "ONVIF authentication rejected.", eff_pass, endpoint_url)
        return OnvifWorkflowResult(False, "offline", stages.error, error="ONVIF_AUTH_REQUIRED", stages=stages)

    media_xaddr: Optional[str] = None
    if cap_root is not None and not cap_err:
        stages.onvif_authenticated = True
        for media_el in _find_all_local(cap_root, "Media"):
            xaddr = _find_first_text(media_el, "XAddr")
            if xaddr:
                media_xaddr = xaddr
                break

    svc_status, svc_root, svc_err = _soap_post(
        device_url,
        '<tds:GetServices xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>',
        username=eff_user,
        password=eff_pass,
        include_wsse=bool(eff_user),
        timeout_sec=min(timeout_sec, 4.0),
    )
    if svc_status in (401, 403) or (svc_err and ("NotAuthorized" in svc_err or "FailedAuthentication" in svc_err)):
        stages.error = sanitize_secret_text(svc_err or "ONVIF authentication rejected on GetServices.", eff_pass, endpoint_url)
        return OnvifWorkflowResult(False, "offline", stages.error, error="ONVIF_AUTH_REQUIRED", stages=stages)

    if svc_root is not None and not svc_err:
        stages.onvif_authenticated = True
        for svc in _find_all_local(svc_root, "Service"):
            ns = (_find_first_text(svc, "Namespace") or "").lower()
            xaddr = _find_first_text(svc, "XAddr")
            if "media" in ns and xaddr:
                media_xaddr = xaddr
                break

    if not stages.onvif_authenticated:
        stages.error = sanitize_secret_text(cap_err or svc_err or "ONVIF device capability query failed.", eff_pass, endpoint_url)
        return OnvifWorkflowResult(False, "offline", stages.error, error="ONVIF_CAPABILITIES_FAILED", stages=stages)

    # Stage 3: GetDeviceInformation
    info_status, info_root, info_err = _soap_post(
        device_url,
        '<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>',
        username=eff_user,
        password=eff_pass,
        include_wsse=bool(eff_user),
        timeout_sec=min(timeout_sec, 4.0),
    )
    manufacturer = model = firmware = serial = hw_id = None
    if info_root is not None and not info_err:
        manufacturer = _find_first_text(info_root, "Manufacturer")
        model = _find_first_text(info_root, "Model")
        firmware = _find_first_text(info_root, "FirmwareVersion")
        serial = _find_first_text(info_root, "SerialNumber")
        hw_id = _find_first_text(info_root, "HardwareId")
        if manufacturer or model or firmware or serial:
            stages.device_info_retrieved = True
    elif info_status in (401, 403):
        stages.onvif_authenticated = False
        stages.error = "ONVIF GetDeviceInformation rejected credentials."
        return OnvifWorkflowResult(False, "offline", stages.error, error="ONVIF_AUTH_REQUIRED", stages=stages)

    # Stage 4: GetProfiles
    if not media_xaddr:
        media_xaddr = urlunparse((parsed.scheme, f"{parsed.hostname}:{port}", "/onvif/media_service", "", "", ""))

    prof_status, prof_root, prof_err = _soap_post(
        media_xaddr,
        '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>',
        username=eff_user,
        password=eff_pass,
        include_wsse=bool(eff_user),
        timeout_sec=min(timeout_sec, 4.0),
    )
    profiles: list[OnvifProfile] = []
    if prof_root is not None and not prof_err:
        for p_el in _find_all_local(prof_root, "Profiles"):
            token = p_el.attrib.get("token") or p_el.attrib.get("Token") or _find_first_text(p_el, "Token")
            if not token:
                continue
            pname = _find_first_text(p_el, "Name") or token
            vs_token = None
            for vsc in _find_all_local(p_el, "VideoSourceConfiguration"):
                vs_token = _find_first_text(vsc, "SourceToken") or vsc.attrib.get("token")
            encoding = None
            width = height = None
            fps = None
            for vec in _find_all_local(p_el, "VideoEncoderConfiguration"):
                encoding = _find_first_text(vec, "Encoding")
                w_txt = _find_first_text(vec, "Width")
                h_txt = _find_first_text(vec, "Height")
                f_txt = _find_first_text(vec, "FrameRateLimit")
                if w_txt and w_txt.isdigit():
                    width = int(w_txt)
                if h_txt and h_txt.isdigit():
                    height = int(h_txt)
                if f_txt:
                    try:
                        fps = float(f_txt)
                    except ValueError:
                        pass
            profiles.append(
                OnvifProfile(
                    token=token,
                    name=pname,
                    video_source_token=vs_token,
                    encoding=encoding,
                    width=width,
                    height=height,
                    fps=fps,
                )
            )
    if not profiles:
        stages.error = sanitize_secret_text(prof_err or "ONVIF GetProfiles returned zero media profiles.", eff_pass, endpoint_url)
        return OnvifWorkflowResult(
            False,
            "offline",
            stages.error,
            error="ONVIF_NO_PROFILES",
            manufacturer=manufacturer,
            model=model,
            firmware_version=firmware,
            serial_number=serial,
            hardware_id=hw_id,
            media_xaddr=media_xaddr,
            stages=stages,
        )
    stages.profiles_retrieved = True

    # Stage 5: GetStreamUri for main & sub profiles
    for prof in profiles[:4]:
        uri_body = (
            '<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
            'xmlns:tt="http://www.onvif.org/ver10/schema">'
            '<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
            '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
            f"<trt:ProfileToken>{_escape_xml(prof.token)}</trt:ProfileToken>"
            "</trt:GetStreamUri>"
        )
        _u_status, u_root, _u_err = _soap_post(
            media_xaddr,
            uri_body,
            username=eff_user,
            password=eff_pass,
            include_wsse=bool(eff_user),
            timeout_sec=min(timeout_sec, 4.0),
        )
        if u_root is not None:
            raw_rtsp = _find_first_text(u_root, "Uri")
            if raw_rtsp and raw_rtsp.lower().startswith(("rtsp://", "rtsps://")):
                sanitized_rtsp, _, _ = strip_uri_credentials(raw_rtsp)
                prof.rtsp_uri = sanitized_rtsp

    rtsp_profiles = [p for p in profiles if p.rtsp_uri]
    if not rtsp_profiles:
        stages.error = "ONVIF GetStreamUri did not return a valid rtsp:// stream URI."
        return OnvifWorkflowResult(
            False,
            "offline",
            stages.error,
            error="ONVIF_NO_STREAM_URI",
            manufacturer=manufacturer,
            model=model,
            firmware_version=firmware,
            serial_number=serial,
            hardware_id=hw_id,
            media_xaddr=media_xaddr,
            profiles=profiles,
            stages=stages,
        )
    stages.rtsp_uri_retrieved = True

    main_rtsp = rtsp_profiles[0].rtsp_uri
    sub_rtsp = rtsp_profiles[1].rtsp_uri if len(rtsp_profiles) > 1 else None
    selected_rtsp = sub_rtsp if (stream_profile == "sub" and sub_rtsp) else main_rtsp

    # Stage 6: Open and verify real RTSP video stream via FFprobe/FFmpeg
    if not rtsp_probe_fn:
        stages.error = "RTSP URI retrieved via ONVIF, waiting for FFprobe RTSP stream check."
        return OnvifWorkflowResult(
            False,
            "offline",
            stages.error,
            error="RTSP_PROBE_NOT_RUN",
            manufacturer=manufacturer,
            model=model,
            firmware_version=firmware,
            serial_number=serial,
            hardware_id=hw_id,
            media_xaddr=media_xaddr,
            profiles=profiles,
            main_rtsp_uri=main_rtsp,
            sub_rtsp_uri=sub_rtsp,
            stages=stages,
        )

    runtime_rtsp = inject_uri_credentials(selected_rtsp or "", eff_user, eff_pass)
    rtsp_ok, stream_info, rtsp_err = rtsp_probe_fn(runtime_rtsp, rtsp_transport, timeout_sec)
    if not rtsp_ok:
        stages.error = sanitize_secret_text(rtsp_err or "ONVIF RTSP stream failed to open.", eff_pass, runtime_rtsp)
        return OnvifWorkflowResult(
            False,
            "offline",
            stages.error,
            error="ONVIF_RTSP_OPEN_FAILED",
            manufacturer=manufacturer,
            model=model,
            firmware_version=firmware,
            serial_number=serial,
            hardware_id=hw_id,
            media_xaddr=media_xaddr,
            profiles=profiles,
            main_rtsp_uri=main_rtsp,
            sub_rtsp_uri=sub_rtsp,
            stages=stages,
        )

    stages.rtsp_stream_opened = True
    device_label = " ".join(x for x in (manufacturer, model) if x) or "ONVIF Camera"
    msg = (
        f"{device_label}: ONVIF authenticated, {len(profiles)} profile(s) retrieved, "
        f"RTSP ({rtsp_transport.upper()}) stream verified "
        f"({stream_info.get('codec') or 'video'} {stream_info.get('width') or '?'}x{stream_info.get('height') or '?'})."
    )
    return OnvifWorkflowResult(
        True,
        "online",
        msg,
        manufacturer=manufacturer,
        model=model,
        firmware_version=firmware,
        serial_number=serial,
        hardware_id=hw_id,
        media_xaddr=media_xaddr,
        profiles=profiles,
        main_rtsp_uri=main_rtsp,
        sub_rtsp_uri=sub_rtsp,
        codec=stream_info.get("codec"),
        width=stream_info.get("width"),
        height=stream_info.get("height"),
        fps=stream_info.get("fps"),
        stages=stages,
    )
