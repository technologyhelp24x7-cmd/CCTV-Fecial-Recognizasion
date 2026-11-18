"""Pluggable protocol-driven CCTV camera & DVR/NVR vendor driver registry.

Strictly capability-driven and honest: each driver models documented ONVIF/RTSP/HTTP URI templates
and protocol capabilities without claiming untested universal compatibility across every model/firmware.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class CameraCapabilityMatrix:
    live_stream: bool = True
    recording: bool = True
    snapshot: bool = True
    dual_stream: bool = True
    onvif_discovery: bool = False
    rtsp_tcp: bool = True
    rtsp_udp: bool = True
    http_snapshot_fallback: bool = False
    nvr_multi_channel: bool = False
    audio_stream: bool = False
    ptz_control: bool = False


@dataclass(frozen=True)
class CameraDriverDescriptor:
    id: str
    vendor_name: str
    label: str
    default_source_type: str
    default_rtsp_port: int
    default_control_port: int
    main_uri_template: str
    sub_uri_template: str | None
    snapshot_path_template: str | None
    auth_modes: list[str]
    capabilities: CameraCapabilityMatrix
    compatibility_note: str

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


CAMERA_DRIVERS: dict[str, CameraDriverDescriptor] = {
    "standard_onvif": CameraDriverDescriptor(
        id="standard_onvif",
        vendor_name="Generic / ONVIF Profile S/T",
        label="Standard ONVIF + RTSP Camera",
        default_source_type="onvif",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="http://{host}:{control_port}/onvif/device_service",
        sub_uri_template=None,
        snapshot_path_template=None,
        auth_modes=["WS-UsernameToken Digest", "HTTP Digest", "RTSP Digest/Basic"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=True,
            nvr_multi_channel=True,
        ),
        compatibility_note="Protocol-level support via ONVIF WS-Discovery, SOAP GetProfiles/GetStreamUri, and FFmpeg RTSP.",
    ),
    "hikvision_isapi": CameraDriverDescriptor(
        id="hikvision_isapi",
        vendor_name="Hikvision",
        label="Hikvision IP Camera / NVR (ONVIF + ISAPI RTSP)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/Streaming/Channels/{channel}01",
        sub_uri_template="rtsp://{host}:{rtsp_port}/Streaming/Channels/{channel}02",
        snapshot_path_template="http://{host}:{control_port}/ISAPI/Streaming/channels/{channel}01/picture",
        auth_modes=["RTSP Digest", "HTTP Digest", "ONVIF WS-Security"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=True,
            nvr_multi_channel=True,
        ),
        compatibility_note="Uses documented Hikvision RTSP channel paths & ISAPI snapshot URI; requires RTSP/ONVIF enabled in camera web UI. Untested on physical hardware in this build.",
    ),
    "dahua_rpc2": CameraDriverDescriptor(
        id="dahua_rpc2",
        vendor_name="Dahua",
        label="Dahua IP Camera / XVR / NVR (RTSP + CGI)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=0",
        sub_uri_template="rtsp://{host}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=1",
        snapshot_path_template="http://{host}:{control_port}/cgi-bin/snapshot.cgi?channel={channel}",
        auth_modes=["RTSP Digest", "HTTP Digest", "ONVIF WS-Security"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=True,
            nvr_multi_channel=True,
        ),
        compatibility_note="Uses standard Dahua cam/realmonitor RTSP paths and snapshot.cgi template. Physical firmware verification pending.",
    ),
    "terabyte_rtsp": CameraDriverDescriptor(
        id="terabyte_rtsp",
        vendor_name="TeraByte",
        label="TeraByte DVR / NVR / IP Camera (RTSP + ONVIF)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/ch0{channel}.264",
        sub_uri_template="rtsp://{host}:{rtsp_port}/ch0{channel}_sub.264",
        snapshot_path_template=None,
        auth_modes=["RTSP Digest/Basic", "ONVIF"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=False,
            nvr_multi_channel=True,
        ),
        compatibility_note="TeraByte OEM firmware varies (H.264/H.265 Xiongmai/ONVIF); adjust RTSP path or use ONVIF discovery when supported by device firmware.",
    ),
    "cp_plus_rtsp": CameraDriverDescriptor(
        id="cp_plus_rtsp",
        vendor_name="CP Plus",
        label="CP Plus IP Camera / DVR / NVR (RTSP + ONVIF)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=0",
        sub_uri_template="rtsp://{host}:{rtsp_port}/cam/realmonitor?channel={channel}&subtype=1",
        snapshot_path_template="http://{host}:{control_port}/cgi-bin/snapshot.cgi?channel={channel}",
        auth_modes=["RTSP Digest", "ONVIF"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=True,
            nvr_multi_channel=True,
        ),
        compatibility_note="Supports CP Plus Orange/Indigo series using realmonitor RTSP or Hik-OEM /Streaming/Channels/{channel}01 paths. Physical model test pending.",
    ),
    "axis_vapix": CameraDriverDescriptor(
        id="axis_vapix",
        vendor_name="Axis Communications",
        label="Axis VAPIX / ONVIF Camera",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/axis-media/media.amp",
        sub_uri_template="rtsp://{host}:{rtsp_port}/axis-media/media.amp?resolution=640x360",
        snapshot_path_template="http://{host}:{control_port}/axis-cgi/jpg/image.cgi",
        auth_modes=["RTSP Digest", "HTTP Digest"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=True,
            nvr_multi_channel=False,
        ),
        compatibility_note="Uses documented Axis VAPIX media.amp RTSP and jpg/image.cgi endpoints.",
    ),
    "reolink_http_rtsp": CameraDriverDescriptor(
        id="reolink_http_rtsp",
        vendor_name="Reolink",
        label="Reolink IP Camera / NVR (RTSP + ONVIF)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/h264Preview_0{channel}_main",
        sub_uri_template="rtsp://{host}:{rtsp_port}/h264Preview_0{channel}_sub",
        snapshot_path_template="http://{host}:{control_port}/cgi-bin/api.cgi?cmd=Snap&channel={channel}",
        auth_modes=["RTSP Digest/Basic", "ONVIF"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=True,
            nvr_multi_channel=True,
        ),
        compatibility_note="Requires RTSP/ONVIF ports enabled in Reolink Network -> Advanced Port Settings.",
    ),
    "uniview_rtsp": CameraDriverDescriptor(
        id="uniview_rtsp",
        vendor_name="Uniview (UNV)",
        label="Uniview IP Camera / NVR (RTSP + ONVIF)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/unicast/c{channel}/s0/live",
        sub_uri_template="rtsp://{host}:{rtsp_port}/unicast/c{channel}/s1/live",
        snapshot_path_template=None,
        auth_modes=["RTSP Digest", "ONVIF"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=False,
            nvr_multi_channel=True,
        ),
        compatibility_note="Uses documented Uniview unicast RTSP stream routing.",
    ),
    "tvt_rtsp": CameraDriverDescriptor(
        id="tvt_rtsp",
        vendor_name="TVT",
        label="TVT NVR / DVR / IP Camera (RTSP + ONVIF)",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/chID={channel}&streamType=main",
        sub_uri_template="rtsp://{host}:{rtsp_port}/chID={channel}&streamType=sub",
        snapshot_path_template=None,
        auth_modes=["RTSP Digest/Basic", "ONVIF"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=True,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=False,
            nvr_multi_channel=True,
        ),
        compatibility_note="Protocol template for TVT NVR/DVR firmware; verify RTSP URL in device manual.",
    ),
    "manual_rtsp": CameraDriverDescriptor(
        id="manual_rtsp",
        vendor_name="Manual RTSP",
        label="Manual RTSP / RTSPS Stream URL",
        default_source_type="rtsp",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="rtsp://{host}:{rtsp_port}/stream1",
        sub_uri_template="rtsp://{host}:{rtsp_port}/stream2",
        snapshot_path_template=None,
        auth_modes=["RTSP Digest", "RTSP Basic"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=True,
            onvif_discovery=False,
            rtsp_tcp=True,
            rtsp_udp=True,
            http_snapshot_fallback=False,
            nvr_multi_channel=False,
        ),
        compatibility_note="Works with any standard RFC 2326 / 7826 H.264/H.265 RTSP source decodable by FFmpeg.",
    ),
    "http_mjpeg": CameraDriverDescriptor(
        id="http_mjpeg",
        vendor_name="HTTP / MJPEG / HLS",
        label="HTTP / HTTPS Video & MJPEG Endpoint",
        default_source_type="http",
        default_rtsp_port=80,
        default_control_port=80,
        main_uri_template="http://{host}:{control_port}/video",
        sub_uri_template=None,
        snapshot_path_template=None,
        auth_modes=["HTTP Basic", "HTTP Digest", "None"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=False,
            onvif_discovery=False,
            rtsp_tcp=False,
            rtsp_udp=False,
            http_snapshot_fallback=True,
            nvr_multi_channel=False,
        ),
        compatibility_note="Connects to HTTP MJPEG, HLS (.m3u8), or HTTP-MP4 camera feeds.",
    ),
    "local_archive": CameraDriverDescriptor(
        id="local_archive",
        vendor_name="Local Storage",
        label="Local Video File / Directory Vault",
        default_source_type="local_archive",
        default_rtsp_port=554,
        default_control_port=80,
        main_uri_template="/path/to/archive",
        sub_uri_template=None,
        snapshot_path_template=None,
        auth_modes=["Local Filesystem Permissions"],
        capabilities=CameraCapabilityMatrix(
            live_stream=True,
            recording=True,
            snapshot=True,
            dual_stream=False,
            onvif_discovery=False,
            rtsp_tcp=False,
            rtsp_udp=False,
            http_snapshot_fallback=False,
            nvr_multi_channel=False,
        ),
        compatibility_note="Verified offline/lab ingestion and looped FFmpeg streaming from local CCTV archives.",
    ),
}


def list_camera_drivers() -> list[dict[str, Any]]:
    return [drv.to_dict() for drv in CAMERA_DRIVERS.values()]


def get_camera_driver(driver_id: str | None) -> CameraDriverDescriptor:
    if driver_id and driver_id in CAMERA_DRIVERS:
        return CAMERA_DRIVERS[driver_id]
    return CAMERA_DRIVERS["standard_onvif"]


def render_driver_uri(template: str, host: str, rtsp_port: int = 554, control_port: int = 80, channel: int = 1) -> str:
    return (
        template.replace("{host}", host)
        .replace("{rtsp_port}", str(rtsp_port))
        .replace("{control_port}", str(control_port))
        .replace("{channel}", str(channel))
    )
