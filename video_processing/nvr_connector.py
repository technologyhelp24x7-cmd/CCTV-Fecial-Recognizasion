"""Stage 3: Vendor-neutral NVR integration layer with pluggable protocol adapters.

Supported adapters:
  - standard_onvif_rtsp: Discovers NVR device info, media profiles, video sources, and main/sub RTSP URIs via ONVIF SOAP.
  - generic_rtsp_channels: Probes parameterized RTSP channel templates (e.g. rtsp://{host}:{rtsp_port}/ch{channel}/main).

Boundary for proprietary vendor plugins (Hikvision ISAPI, Dahua RPC2, Axis VAPIX, etc.):
  Future vendor-specific plugins implement `NvrProtocolAdapter` and register in `NVR_ADAPTERS` without
  modifying NVR repository schemas, credential storage, or stream workers.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Optional, Protocol

from backend.app.core.credentials import inject_uri_credentials, sanitize_secret_text, strip_uri_credentials
from video_processing.camera_connector import ffprobe_stream
from video_processing.onvif_client import _soap_post, verify_onvif_and_rtsp


@dataclass
class DiscoveredNvrChannel:
    channel_number: int
    name: str
    profile_token: Optional[str] = None
    main_stream_uri: str = ""
    sub_stream_uri: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    codec: Optional[str] = None
    status: str = "offline"  # 'online' | 'offline' | 'configured'
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NvrConnectionTestResult:
    reachable: bool
    status: str  # 'online' | 'offline'
    message: str
    error: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware_version: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NvrChannelDiscoveryResult:
    nvr_status: str
    message: str
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware_version: Optional[str] = None
    channels: list[DiscoveredNvrChannel] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "nvr_status": self.nvr_status,
            "message": self.message,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "firmware_version": self.firmware_version,
            "channels": [ch.to_dict() for ch in self.channels],
        }


class NvrProtocolAdapter(Protocol):
    adapter_id: str

    def test_connection(
        self,
        host: str,
        port: int,
        rtsp_port: int,
        username: Optional[str],
        password: Optional[str],
        rtsp_transport: str,
        rtsp_url_template: Optional[str],
        channel_count: int,
    ) -> NvrConnectionTestResult: ...

    def discover_channels(
        self,
        host: str,
        port: int,
        rtsp_port: int,
        username: Optional[str],
        password: Optional[str],
        rtsp_transport: str,
        rtsp_url_template: Optional[str],
        channel_count: int,
    ) -> NvrChannelDiscoveryResult: ...


def _render_rtsp_template(template: str, host: str, rtsp_port: int, channel: int) -> str:
    rendered = (
        template.replace("{host}", host)
        .replace("{rtsp_port}", str(rtsp_port))
        .replace("{port}", str(rtsp_port))
        .replace("{channel}", str(channel))
        .replace("{ch}", str(channel))
    )
    clean, _, _ = strip_uri_credentials(rendered)
    return clean


class StandardOnvifRtspNvrAdapter:
    """Standard ONVIF + RTSP multi-profile NVR adapter (vendor-neutral)."""

    adapter_id = "standard_onvif_rtsp"

    def test_connection(
        self,
        host: str,
        port: int,
        rtsp_port: int,
        username: Optional[str],
        password: Optional[str],
        rtsp_transport: str,
        rtsp_url_template: Optional[str],
        channel_count: int,
    ) -> NvrConnectionTestResult:
        del rtsp_port, rtsp_url_template, channel_count
        endpoint = f"http://{host}:{port}/onvif/device_service"
        res = verify_onvif_and_rtsp(
            endpoint_url=endpoint,
            username=username,
            password=password,
            rtsp_transport=rtsp_transport,
            stream_profile="main",
            timeout_sec=6.0,
            rtsp_probe_fn=ffprobe_stream,
        )
        if res.stages.onvif_authenticated:
            label = " ".join(x for x in (res.manufacturer, res.model) if x) or "ONVIF NVR"
            return NvrConnectionTestResult(
                reachable=True,
                status="online",
                message=f"{label}: ONVIF authenticated, {len(res.profiles)} channel profile(s) available.",
                manufacturer=res.manufacturer,
                model=res.model,
                firmware_version=res.firmware_version,
            )
        return NvrConnectionTestResult(
            reachable=False,
            status="offline",
            message=sanitize_secret_text(res.message, password, endpoint),
            error=res.error,
            manufacturer=res.manufacturer,
            model=res.model,
            firmware_version=res.firmware_version,
        )

    def discover_channels(
        self,
        host: str,
        port: int,
        rtsp_port: int,
        username: Optional[str],
        password: Optional[str],
        rtsp_transport: str,
        rtsp_url_template: Optional[str],
        channel_count: int,
    ) -> NvrChannelDiscoveryResult:
        del rtsp_port, rtsp_url_template
        endpoint = f"http://{host}:{port}/onvif/device_service"
        res = verify_onvif_and_rtsp(
            endpoint_url=endpoint,
            username=username,
            password=password,
            rtsp_transport=rtsp_transport,
            stream_profile="main",
            timeout_sec=6.0,
            rtsp_probe_fn=ffprobe_stream,
        )
        if not res.stages.onvif_authenticated:
            return NvrChannelDiscoveryResult(
                nvr_status="offline",
                message=sanitize_secret_text(res.message, password, endpoint),
                manufacturer=res.manufacturer,
                model=res.model,
                firmware_version=res.firmware_version,
                channels=[],
            )

        # Group ONVIF profiles by video_source_token when distinct; else treat each profile as an NVR stream channel
        grouped: dict[str, list[Any]] = {}
        order_keys: list[str] = []
        for idx, prof in enumerate(res.profiles):
            # Also resolve any GetStreamUri beyond the first 4 profiles if NVR has >4 profiles
            if not prof.rtsp_uri and res.media_xaddr:
                uri_body = (
                    '<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
                    'xmlns:tt="http://www.onvif.org/ver10/schema">'
                    '<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
                    '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
                    f"<trt:ProfileToken>{prof.token}</trt:ProfileToken>"
                    "</trt:GetStreamUri>"
                )
                _s, u_root, _e = _soap_post(
                    res.media_xaddr,
                    uri_body,
                    username=username,
                    password=password,
                    include_wsse=bool(username),
                    timeout_sec=4.0,
                )
                if u_root is not None:
                    from video_processing.onvif_client import _find_first_text

                    raw_rtsp = _find_first_text(u_root, "Uri")
                    if raw_rtsp and raw_rtsp.lower().startswith(("rtsp://", "rtsps://")):
                        prof.rtsp_uri, _, _ = strip_uri_credentials(raw_rtsp)

            key = prof.video_source_token or f"profile-{idx + 1}"
            if key not in grouped:
                grouped[key] = []
                order_keys.append(key)
            grouped[key].append(prof)

        limit = min(max(channel_count or len(order_keys), 1), 256)
        channels: list[DiscoveredNvrChannel] = []
        for ch_idx, key in enumerate(order_keys[:limit], start=1):
            profs = grouped[key]
            main_p = profs[0]
            sub_p = profs[1] if len(profs) > 1 else None
            main_uri = main_p.rtsp_uri or ""
            sub_uri = sub_p.rtsp_uri if sub_p else None
            ch_status = "offline"
            ch_err: Optional[str] = None
            codec = main_p.encoding
            width = main_p.width
            height = main_p.height
            fps = main_p.fps

            if main_uri:
                runtime_uri = inject_uri_credentials(main_uri, username, password)
                ok, info, probe_err = ffprobe_stream(runtime_uri, rtsp_transport=rtsp_transport, timeout_sec=5.0)
                if ok:
                    ch_status = "online"
                    codec = info.get("codec") or codec
                    width = info.get("width") or width
                    height = info.get("height") or height
                    fps = info.get("fps") or fps
                else:
                    ch_err = sanitize_secret_text(probe_err or "Channel RTSP unreachable", password, runtime_uri)
            else:
                ch_err = "ONVIF profile returned no RTSP URI."

            channels.append(
                DiscoveredNvrChannel(
                    channel_number=ch_idx,
                    name=main_p.name or f"Channel {ch_idx:02d}",
                    profile_token=main_p.token,
                    main_stream_uri=main_uri,
                    sub_stream_uri=sub_uri,
                    width=width,
                    height=height,
                    fps=fps,
                    codec=codec,
                    status=ch_status,
                    error=ch_err,
                )
            )

        online_cnt = sum(1 for c in channels if c.status == "online")
        return NvrChannelDiscoveryResult(
            nvr_status="online",
            message=f"Discovered {len(channels)} ONVIF NVR channel(s) ({online_cnt} online).",
            manufacturer=res.manufacturer,
            model=res.model,
            firmware_version=res.firmware_version,
            channels=channels,
        )


class GenericRtspChannelsNvrAdapter:
    """Vendor-neutral parameterized RTSP channel template NVR adapter."""

    adapter_id = "generic_rtsp_channels"
    DEFAULT_TEMPLATE = "rtsp://{host}:{rtsp_port}/channel{channel}"

    def test_connection(
        self,
        host: str,
        port: int,
        rtsp_port: int,
        username: Optional[str],
        password: Optional[str],
        rtsp_transport: str,
        rtsp_url_template: Optional[str],
        channel_count: int,
    ) -> NvrConnectionTestResult:
        del port, channel_count
        tmpl = (rtsp_url_template or "").strip() or self.DEFAULT_TEMPLATE
        ch1_clean = _render_rtsp_template(tmpl, host, rtsp_port, 1)
        runtime_uri = inject_uri_credentials(ch1_clean, username, password)
        ok, info, err = ffprobe_stream(runtime_uri, rtsp_transport=rtsp_transport, timeout_sec=5.0)
        if ok:
            return NvrConnectionTestResult(
                reachable=True,
                status="online",
                message=f"Generic RTSP NVR channel 1 verified ({info.get('codec') or 'video'} {info.get('width') or '?'}x{info.get('height') or '?'}).",
            )
        return NvrConnectionTestResult(
            reachable=False,
            status="offline",
            message=sanitize_secret_text(err or "NVR RTSP channel 1 probe failed.", password, runtime_uri),
            error="NVR_RTSP_UNREACHABLE",
        )

    def discover_channels(
        self,
        host: str,
        port: int,
        rtsp_port: int,
        username: Optional[str],
        password: Optional[str],
        rtsp_transport: str,
        rtsp_url_template: Optional[str],
        channel_count: int,
    ) -> NvrChannelDiscoveryResult:
        del port
        tmpl = (rtsp_url_template or "").strip() or self.DEFAULT_TEMPLATE
        total = min(max(channel_count or 4, 1), 256)
        probe_timeout = 2.0 if total > 16 else 4.0
        channels: list[DiscoveredNvrChannel] = []
        for ch_num in range(1, total + 1):
            clean_uri = _render_rtsp_template(tmpl, host, rtsp_port, ch_num)
            runtime_uri = inject_uri_credentials(clean_uri, username, password)
            ok, info, err = ffprobe_stream(runtime_uri, rtsp_transport=rtsp_transport, timeout_sec=probe_timeout)
            channels.append(
                DiscoveredNvrChannel(
                    channel_number=ch_num,
                    name=f"Channel {ch_num:02d}",
                    profile_token=f"ch{ch_num}",
                    main_stream_uri=clean_uri,
                    sub_stream_uri=None,
                    width=info.get("width") if ok else None,
                    height=info.get("height") if ok else None,
                    fps=info.get("fps") if ok else None,
                    codec=info.get("codec") if ok else None,
                    status="online" if ok else "offline",
                    error=None if ok else sanitize_secret_text(err or "Channel offline", password, runtime_uri),
                )
            )
        online_cnt = sum(1 for c in channels if c.status == "online")
        nvr_status = "online" if online_cnt > 0 else "offline"
        return NvrChannelDiscoveryResult(
            nvr_status=nvr_status,
            message=f"Probed {len(channels)} RTSP template channel(s) ({online_cnt} online).",
            channels=channels,
        )


NVR_ADAPTERS: dict[str, NvrProtocolAdapter] = {
    "standard_onvif_rtsp": StandardOnvifRtspNvrAdapter(),
    "generic_rtsp_channels": GenericRtspChannelsNvrAdapter(),
}


def get_nvr_adapter(adapter_type: str) -> NvrProtocolAdapter:
    return NVR_ADAPTERS.get(adapter_type, NVR_ADAPTERS["standard_onvif_rtsp"])


def test_single_nvr_channel(
    main_stream_uri: str,
    username: Optional[str] = None,
    password: Optional[str] = None,
    rtsp_transport: str = "tcp",
    timeout_sec: float = 5.0,
) -> dict[str, Any]:
    clean_uri, _, _ = strip_uri_credentials(main_stream_uri)
    runtime_uri = inject_uri_credentials(clean_uri, username, password)
    ok, info, err = ffprobe_stream(runtime_uri, rtsp_transport=rtsp_transport, timeout_sec=timeout_sec)
    if ok:
        return {
            "reachable": True,
            "status": "online",
            "codec": info.get("codec"),
            "width": info.get("width"),
            "height": info.get("height"),
            "fps": info.get("fps"),
            "message": f"Channel verified ({info.get('codec') or 'video'} {info.get('width') or '?'}x{info.get('height') or '?'}).",
            "error": None,
        }
    clean_err = sanitize_secret_text(err or "Channel RTSP stream unreachable.", password, runtime_uri)
    return {
        "reachable": False,
        "status": "offline",
        "codec": None,
        "width": None,
        "height": None,
        "fps": None,
        "message": clean_err,
        "error": clean_err,
    }
