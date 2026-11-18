"""Stage 3 verification suite: CredentialVault, WS-Discovery, 6-stage ONVIF SOAP+Digest, NVR channels, stream limits, and security."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.core.credentials import (
    CredentialVault,
    inject_uri_credentials,
    sanitize_secret_text,
    strip_uri_credentials,
)
from backend.app.main import create_app
from video_processing.camera_connector import ffprobe_stream, verify_mp4_integrity
from video_processing.ffmpeg_probe import is_ffmpeg_available
from video_processing.nvr_connector import GenericRtspChannelsNvrAdapter, StandardOnvifRtspNvrAdapter
from video_processing.onvif_client import (
    _build_digest_auth_header,
    _parse_digest_challenge,
    discover_onvif_devices,
    verify_onvif_and_rtsp,
)
from video_processing.stream_worker import MAX_STREAM_BUFFER_BYTES


def _generate_sample_mp4(dest: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg sample clip generation failed: {proc.stderr}")


def _make_onvif_handler(
    expected_user: str,
    expected_secret: str,
    base_url_fn,
    *,
    profiles_enabled: bool = True,
    rtsp_main_uri: str = "rtsp://127.0.0.1:8554/main",
    rtsp_sub_uri: str = "rtsp://127.0.0.1:8554/sub",
):
    realm = "LumaFluxONVIF"
    nonce = secrets.token_hex(12)

    class OnvifSoapHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

        def _verify_digest(self) -> bool:
            auth = self.headers.get("Authorization") or ""
            if not auth.lower().startswith("digest "):
                return False
            params = _parse_digest_challenge(auth)
            if params.get("username") != expected_user or params.get("nonce") != nonce:
                return False
            uri = params.get("uri") or self.path
            expected_hdr = _build_digest_auth_header(
                {"realm": realm, "nonce": nonce, "qop": "auth", "algorithm": "MD5"},
                "POST",
                uri,
                expected_user,
                expected_secret,
            )
            ha1 = hashlib.md5(f"{expected_user}:{realm}:{expected_secret}".encode("utf-8")).hexdigest()
            ha2 = hashlib.md5(f"POST:{uri}".encode("utf-8")).hexdigest()
            cnonce = params.get("cnonce", "")
            nc = params.get("nc", "00000001")
            qop = params.get("qop", "auth")
            expected_resp = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}".encode("utf-8")).hexdigest()
            del expected_hdr
            return params.get("response") == expected_resp

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(length).decode("utf-8", errors="ignore")

            # Preflight unauthenticated ONVIF call
            if "GetSystemDateAndTime" in body:
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">'
                    "<s:Body><tds:GetSystemDateAndTimeResponse/></s:Body></s:Envelope>"
                )
                payload = xml.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/soap+xml; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if not self._verify_digest():
                msg = b"Unauthorized"
                self.send_response(401)
                self.send_header("WWW-Authenticate", f'Digest realm="{realm}", qop="auth", nonce="{nonce}", algorithm=MD5')
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return

            base_url = base_url_fn()
            media_xaddr = f"{base_url}/onvif/media_service"

            if "GetCapabilities" in body:
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
                    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
                    f"<s:Body><tds:GetCapabilitiesResponse><tds:Capabilities><tds:Media><tt:XAddr>{media_xaddr}</tt:XAddr></tds:Media></tds:Capabilities></tds:GetCapabilitiesResponse></s:Body></s:Envelope>"
                )
            elif "GetServices" in body:
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">'
                    "<s:Body><tds:GetServicesResponse><tds:Service>"
                    "<tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>"
                    f"<tds:XAddr>{media_xaddr}</tds:XAddr>"
                    "</tds:Service></tds:GetServicesResponse></s:Body></s:Envelope>"
                )
            elif "GetDeviceInformation" in body:
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">'
                    "<s:Body><tds:GetDeviceInformationResponse>"
                    "<tds:Manufacturer>TestVendor</tds:Manufacturer>"
                    "<tds:Model>NVT-3000</tds:Model>"
                    "<tds:FirmwareVersion>5.7.1</tds:FirmwareVersion>"
                    "<tds:SerialNumber>SN-TEST-01</tds:SerialNumber>"
                    "<tds:HardwareId>HW-1</tds:HardwareId>"
                    "</tds:GetDeviceInformationResponse></s:Body></s:Envelope>"
                )
            elif "GetProfiles" in body:
                if not profiles_enabled:
                    err = b"Not Found"
                    self.send_response(404)
                    self.send_header("Content-Length", str(len(err)))
                    self.end_headers()
                    self.wfile.write(err)
                    return
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
                    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
                    "<s:Body><trt:GetProfilesResponse>"
                    '<trt:Profiles token="profile_main">'
                    "<tt:Name>MainStream</tt:Name>"
                    "<tt:VideoSourceConfiguration><tt:SourceToken>src_1</tt:SourceToken></tt:VideoSourceConfiguration>"
                    "<tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding>"
                    "<tt:Resolution><tt:Width>320</tt:Width><tt:Height>240</tt:Height></tt:Resolution>"
                    "<tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit></tt:RateControl>"
                    "</tt:VideoEncoderConfiguration>"
                    "</trt:Profiles>"
                    '<trt:Profiles token="profile_sub">'
                    "<tt:Name>SubStream</tt:Name>"
                    "<tt:VideoSourceConfiguration><tt:SourceToken>src_1</tt:SourceToken></tt:VideoSourceConfiguration>"
                    "<tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding>"
                    "<tt:Resolution><tt:Width>160</tt:Width><tt:Height>120</tt:Height></tt:Resolution>"
                    "<tt:RateControl><tt:FrameRateLimit>15</tt:FrameRateLimit></tt:RateControl>"
                    "</tt:VideoEncoderConfiguration>"
                    "</trt:Profiles>"
                    "</trt:GetProfilesResponse></s:Body></s:Envelope>"
                )
            elif "GetStreamUri" in body:
                selected_uri = rtsp_sub_uri if "profile_sub" in body else rtsp_main_uri
                xml = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
                    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
                    "<s:Body><trt:GetStreamUriResponse><trt:MediaUri>"
                    f"<tt:Uri>{selected_uri}</tt:Uri>"
                    "</trt:MediaUri></trt:GetStreamUriResponse></s:Body></s:Envelope>"
                )
            else:
                xml = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>'

            payload = xml.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/soap+xml; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return OnvifSoapHandler


class Stage3OnvifNvrSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = Path(tempfile.mkdtemp(prefix="lumaflux-stage3-test-"))
        self.test_secret = f"tok-{secrets.token_hex(6)}"
        self.sample_mp4 = self.tmp_dir / "sample.mp4"
        if is_ffmpeg_available():
            _generate_sample_mp4(self.sample_mp4)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_credential_vault_aes256_gcm_and_sanitization(self) -> None:
        vault = CredentialVault(self.tmp_dir / "vault")
        ref = "cam:test-vault-1"
        vault.set_secret(ref, self.test_secret)

        self.assertTrue(vault.has_secret(ref))
        self.assertEqual(vault.get_secret(ref), self.test_secret)
        raw_vault_text = vault.vault_path.read_text(encoding="utf-8")
        self.assertNotIn(self.test_secret, raw_vault_text)
        self.assertIn("aes-256-gcm", raw_vault_text)

        if os.name == "posix":
            self.assertEqual(vault.vault_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(vault.key_path.stat().st_mode & 0o777, 0o600)

        clean_uri, u, p = strip_uri_credentials(f"rtsp://admin:{self.test_secret}@192.168.1.50:554/stream1")
        self.assertEqual(clean_uri, "rtsp://192.168.1.50:554/stream1")
        self.assertEqual(u, "admin")
        self.assertEqual(p, self.test_secret)

        injected = inject_uri_credentials(clean_uri, u, p)
        self.assertEqual(injected, f"rtsp://admin:{self.test_secret}@192.168.1.50:554/stream1")

        scrubbed = sanitize_secret_text(f"Connect failed on {injected}", self.test_secret, injected)
        self.assertNotIn(self.test_secret, scrubbed)

        self.assertTrue(vault.delete_secret(ref))
        self.assertFalse(vault.has_secret(ref))

    def test_ws_discovery_udp_loopback(self) -> None:
        udp_srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_srv.bind(("127.0.0.1", 0))
        udp_port = udp_srv.getsockname()[1]

        def _respond() -> None:
            udp_srv.settimeout(3.0)
            try:
                _data, addr = udp_srv.recvfrom(8192)
                reply = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
                    'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
                    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
                    'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
                    "<e:Body><d:ProbeMatches><d:ProbeMatch>"
                    "<w:EndpointReference><w:Address>urn:uuid:test-cam-01</w:Address></w:EndpointReference>"
                    "<d:Types>dn:NetworkVideoTransmitter</d:Types>"
                    "<d:Scopes>onvif://www.onvif.org/name/LobbyCam onvif://www.onvif.org/hardware/NVT3000</d:Scopes>"
                    "<d:XAddrs>http://127.0.0.1:8089/onvif/device_service</d:XAddrs>"
                    "</d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>"
                ).encode("utf-8")
                udp_srv.sendto(reply, addr)
            except OSError:
                pass
            finally:
                udp_srv.close()

        t = threading.Thread(target=_respond, daemon=True)
        t.start()
        devices = discover_onvif_devices(timeout_sec=1.2, target_host="127.0.0.1", target_port=udp_port)
        t.join(timeout=2.0)

        self.assertEqual(len(devices), 1)
        self.assertEqual(devices[0]["name"], "LobbyCam")
        self.assertEqual(devices[0]["hardware"], "NVT3000")
        self.assertEqual(devices[0]["port"], 8089)

    def test_onvif_6_stage_verification_and_auth_enforcement(self) -> None:
        base_holder = [""]
        handler_cls = _make_onvif_handler(
            "camadmin",
            self.test_secret,
            lambda: base_holder[0],
            profiles_enabled=True,
        )
        srv = http.server.HTTPServer(("127.0.0.1", 0), handler_cls)
        port = srv.server_address[1]
        base_holder[0] = f"http://127.0.0.1:{port}"
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()

        try:
            endpoint = f"{base_holder[0]}/onvif/device_service"

            # 1. Wrong credential must fail stage 2 and remain offline even though GetSystemDateAndTime returns 200
            bad_res = verify_onvif_and_rtsp(
                endpoint,
                username="camadmin",
                password=f"bad-{secrets.token_hex(4)}",
                rtsp_probe_fn=lambda _uri, _t, _to: (True, {"codec": "h264", "width": 320, "height": 240}, None),
            )
            self.assertFalse(bad_res.reachable)
            self.assertEqual(bad_res.status, "offline")
            self.assertTrue(bad_res.stages.device_discovered)
            self.assertFalse(bad_res.stages.onvif_authenticated)

            # 2. Valid credentials pass all 6 ONVIF+RTSP stages (probing real generated MP4 via ffprobe_stream)
            def _probe_real_clip(_uri: str, _transport: str, timeout: float):
                return ffprobe_stream(str(self.sample_mp4), timeout_sec=timeout)

            ok_res = verify_onvif_and_rtsp(
                endpoint,
                username="camadmin",
                password=self.test_secret,
                rtsp_probe_fn=_probe_real_clip,
            )
            self.assertTrue(ok_res.reachable)
            self.assertEqual(ok_res.status, "online")
            self.assertEqual(ok_res.manufacturer, "TestVendor")
            self.assertEqual(ok_res.model, "NVT-3000")
            self.assertEqual(len(ok_res.profiles), 2)
            self.assertEqual(ok_res.main_rtsp_uri, "rtsp://127.0.0.1:8554/main")
            self.assertEqual(ok_res.sub_rtsp_uri, "rtsp://127.0.0.1:8554/sub")
            self.assertTrue(ok_res.stages.device_discovered)
            self.assertTrue(ok_res.stages.onvif_authenticated)
            self.assertTrue(ok_res.stages.device_info_retrieved)
            self.assertTrue(ok_res.stages.profiles_retrieved)
            self.assertTrue(ok_res.stages.rtsp_uri_retrieved)
            self.assertTrue(ok_res.stages.rtsp_stream_opened)
        finally:
            srv.shutdown()
            srv.server_close()

        # 3. Server returning only GetSystemDateAndTime + empty/404 GetProfiles must stay offline
        base_holder2 = [""]
        no_prof_cls = _make_onvif_handler(
            "camadmin",
            self.test_secret,
            lambda: base_holder2[0],
            profiles_enabled=False,
        )
        srv2 = http.server.HTTPServer(("127.0.0.1", 0), no_prof_cls)
        port2 = srv2.server_address[1]
        base_holder2[0] = f"http://127.0.0.1:{port2}"
        th2 = threading.Thread(target=srv2.serve_forever, daemon=True)
        th2.start()
        try:
            incomplete_res = verify_onvif_and_rtsp(
                f"{base_holder2[0]}/onvif/device_service",
                username="camadmin",
                password=self.test_secret,
                rtsp_probe_fn=lambda _uri, _t, _to: (True, {}, None),
            )
            self.assertFalse(incomplete_res.reachable)
            self.assertEqual(incomplete_res.status, "offline")
            self.assertFalse(incomplete_res.stages.profiles_retrieved)
        finally:
            srv2.shutdown()
            srv2.server_close()

    def test_nvr_adapters_and_fastapi_stage3_endpoints(self) -> None:
        self.assertEqual(MAX_STREAM_BUFFER_BYTES, 4 * 1024 * 1024)

        # Corrupt MP4 must fail verify_mp4_integrity
        corrupt_mp4 = self.tmp_dir / "corrupt.mp4"
        corrupt_mp4.write_bytes(b"not-a-valid-mp4-stream")
        valid_mp4, _meta, mp4_err = verify_mp4_integrity(corrupt_mp4)
        self.assertFalse(valid_mp4)
        self.assertTrue(bool(mp4_err))

        # Local ONVIF server for NVR adapter test
        base_holder = [""]
        handler_cls = _make_onvif_handler(
            "nvradmin",
            self.test_secret,
            lambda: base_holder[0],
            profiles_enabled=True,
        )
        srv = http.server.HTTPServer(("127.0.0.1", 0), handler_cls)
        nvr_port = srv.server_address[1]
        base_holder[0] = f"http://127.0.0.1:{nvr_port}"
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()

        db_path = self.tmp_dir / "lumaflux.db"
        vault_dir = self.tmp_dir / "vault"
        videos_dir = self.tmp_dir / "videos"
        thumbs_dir = self.tmp_dir / "thumbs"
        logs_dir = self.tmp_dir / "logs"

        env_overrides = {
            "LUMAFLUX_DB_PATH": str(db_path),
            "LUMAFLUX_VAULT_DIR": str(vault_dir),
            "LUMAFLUX_STORAGE_DIR": str(videos_dir),
            "LUMAFLUX_THUMBNAIL_DIR": str(thumbs_dir),
            "LUMAFLUX_LOG_DIR": str(logs_dir),
            "LUMAFLUX_API_TOKEN": "test-ipc-token-stage3",
        }
        headers = {"Authorization": "Bearer test-ipc-token-stage3"}

        try:
            # Test generic template NVR adapter directly against unreachable port -> offline cleanly
            generic = GenericRtspChannelsNvrAdapter()
            gen_res = generic.test_connection("127.0.0.1", 80, 1, "u", self.test_secret, "tcp", None, 2)
            self.assertFalse(gen_res.reachable)
            self.assertEqual(gen_res.status, "offline")
            self.assertNotIn(self.test_secret, gen_res.message)

            # Test FastAPI endpoints with Bearer token protection
            with patch.dict(os.environ, env_overrides, clear=False):
                with TestClient(create_app()) as client:
                    # Unauthorized /api/system/shutdown blocked
                    self.assertEqual(client.post("/api/system/shutdown").status_code, 401)
                    self.assertEqual(client.get("/api/health").status_code, 200)

                    # Create structured IP camera with password and ensure SQLite/API never expose plaintext
                    cam_resp = client.post(
                        "/api/cameras",
                        headers=headers,
                        json={
                            "name": "Stage3 Cam",
                            "location_zone": "Gate A",
                            "source_type": "rtsp",
                            "ip_address": "192.168.10.20",
                            "rtsp_port": 554,
                            "username": "camuser",
                            "password": self.test_secret,
                            "rtsp_transport": "tcp",
                            "stream_profile": "main",
                        },
                    )
                    self.assertEqual(cam_resp.status_code, 201)
                    cam_data = cam_resp.json()
                    self.assertTrue(cam_data["has_credentials"])
                    self.assertNotIn(self.test_secret, json.dumps(cam_data))

                    # Create local_archive camera and test on-demand ?capture=1 snapshot while stream is stopped
                    local_cam_resp = client.post(
                        "/api/cameras",
                        headers=headers,
                        json={
                            "name": "Local Sample Archive",
                            "location_zone": "Lab",
                            "source_type": "local_archive",
                            "stream_uri": str(self.sample_mp4),
                            "target_fps": 4,
                            "target_resolution": "320x240",
                        },
                    )
                    self.assertEqual(local_cam_resp.status_code, 201)
                    local_cam_id = local_cam_resp.json()["id"]

                    snap_resp = client.get(f"/api/cameras/{local_cam_id}/snapshot?capture=1", headers=headers)
                    self.assertEqual(snap_resp.status_code, 200)
                    self.assertTrue(snap_resp.content.startswith(b"\xff\xd8"))

                    # Enforce max_concurrent_streams=1
                    set_resp = client.put(
                        "/api/settings",
                        headers=headers,
                        json={"max_concurrent_streams": "1"},
                    )
                    self.assertEqual(set_resp.status_code, 200)
                    self.assertEqual(client.post(f"/api/cameras/{local_cam_id}/stream/start", headers=headers).status_code, 201)

                    local_cam2 = client.post(
                        "/api/cameras",
                        headers=headers,
                        json={
                            "name": "Local Sample Archive 2",
                            "location_zone": "Lab",
                            "source_type": "local_archive",
                            "stream_uri": str(self.sample_mp4),
                        },
                    ).json()
                    overflow = client.post(f"/api/cameras/{local_cam2['id']}/stream/start", headers=headers)
                    self.assertEqual(overflow.status_code, 400)
                    self.assertEqual(overflow.json().get("error"), "STREAM_LIMIT_REACHED")
                    client.post(f"/api/cameras/{local_cam_id}/stream/stop", headers=headers)

                    # Reconnect endpoint returns probe + camera cleanly
                    recon = client.post(f"/api/cameras/{local_cam_id}/reconnect", headers=headers)
                    self.assertEqual(recon.status_code, 200)
                    self.assertEqual(recon.json()["camera"]["status"], "online")
                    client.post(f"/api/cameras/{local_cam_id}/stream/stop", headers=headers)

                    # Create NVR pointing at loopback ONVIF server, test auth, discover channels, register channel
                    nvr_resp = client.post(
                        "/api/nvrs",
                        headers=headers,
                        json={
                            "name": "Perimeter NVR",
                            "adapter_type": "standard_onvif_rtsp",
                            "host": "127.0.0.1",
                            "port": nvr_port,
                            "rtsp_port": 8554,
                            "username": "nvradmin",
                            "password": self.test_secret,
                            "channel_count": 4,
                        },
                    )
                    self.assertEqual(nvr_resp.status_code, 201)
                    nvr_id = nvr_resp.json()["id"]
                    self.assertTrue(nvr_resp.json()["has_credentials"])

                    nvr_test = client.post(f"/api/nvrs/{nvr_id}/test", headers=headers)
                    self.assertEqual(nvr_test.status_code, 200)
                    self.assertEqual(nvr_test.json()["nvr"]["status"], "online")
                    self.assertEqual(nvr_test.json()["nvr"]["device_manufacturer"], "TestVendor")

                    with patch(
                        "video_processing.nvr_connector.ffprobe_stream",
                        side_effect=lambda *_args, **_kw: ffprobe_stream(str(self.sample_mp4)),
                    ):
                        disc = client.post(f"/api/nvrs/{nvr_id}/discover-channels", headers=headers)
                    self.assertEqual(disc.status_code, 200)
                    channels = disc.json()["channels"]
                    self.assertGreaterEqual(len(channels), 1)
                    ch_id = channels[0]["id"]

                    # Toggle channel enabled
                    toggled = client.patch(
                        f"/api/nvrs/{nvr_id}/channels/{ch_id}",
                        headers=headers,
                        json={"enabled": False},
                    )
                    self.assertEqual(toggled.status_code, 200)
                    self.assertFalse(toggled.json()["enabled"])

                    # Register NVR channel into cameras table
                    reg = client.post(
                        f"/api/nvrs/{nvr_id}/channels/{ch_id}/register",
                        headers=headers,
                        json={"location_zone": "Dock B"},
                    )
                    self.assertEqual(reg.status_code, 201)
                    reg_cam = reg.json()
                    self.assertEqual(reg_cam["nvr_id"], nvr_id)
                    self.assertTrue(reg_cam["has_credentials"])
                    self.assertNotIn(self.test_secret, json.dumps(reg_cam))

                    # Verify DELETE /api/videos/{id} removes event crop thumbnail on disk
                    ingest_resp = client.post(f"/api/cameras/{local_cam_id}/ingest-local", headers=headers)
                    self.assertEqual(ingest_resp.status_code, 201)
                    vid_id = ingest_resp.json()["videos"][0]["id"]
                    crop_file = thumbs_dir / "events" / "crop-del-check.jpg"
                    crop_file.parent.mkdir(parents=True, exist_ok=True)
                    crop_file.write_bytes(b"\xff\xd8\xff\xd9")

                    repo = client.app.state.repo
                    with repo.db.connection() as conn:
                        conn.execute(
                            """
                            INSERT INTO person_events
                              (id, video_file_id, camera_id, event_timestamp_sec, confidence, frame_number, frame_count,
                               bbox_json, crop_path, model_name, status, created_at)
                            VALUES ('evt-del-check', ?, ?, 0.2, 0.85, 5, 1, '{"x":1,"y":1,"w":10,"h":10}', ?, 'opencv-hog-svm', 'unreviewed', '2026-01-01T00:00:00Z')
                            """,
                            (vid_id, local_cam_id, str(crop_file)),
                        )
                    self.assertTrue(crop_file.exists())
                    del_vid_resp = client.delete(f"/api/videos/{vid_id}", headers=headers)
                    self.assertEqual(del_vid_resp.status_code, 200)
                    self.assertFalse(crop_file.exists())

                    # Final raw SQLite scan: zero occurrences of plaintext secret
                    raw_db = db_path.read_bytes()
                    self.assertNotIn(self.test_secret.encode("utf-8"), raw_db)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
