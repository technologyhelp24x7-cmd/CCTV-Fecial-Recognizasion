"""Unit tests for LumaFlux Intelligence configuration, SQLite schema, repositories, and audit logs."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.app.core.config import AppConfig, ensure_storage_directories
from backend.app.core.errors import PolicyViolationError
from backend.app.core.logging import configure_logging
from backend.app.db.database import DatabaseManager
from backend.app.db.repositories import LumaFluxRepository


class TestDatabaseAndPrivacy(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        base = Path(self.tmp.name)
        self.config = AppConfig(
            app_name="LumaFlux Intelligence",
            version="0.1.0",
            env="test",
            host="127.0.0.1",
            port=8420,
            root_dir=root,
            db_path=base / "lumaflux-test.db",
            database_url=f"sqlite:///{base / 'lumaflux-test.db'}",
            storage_dir=base / "videos",
            thumbnail_dir=base / "thumbnails",
            log_dir=base / "logs",
            log_level="INFO",
        )
        ensure_storage_directories(self.config)
        configure_logging(self.config.log_dir, self.config.log_level)
        self.db = DatabaseManager(self.config)
        self.db.initialize()
        self.repo = LumaFluxRepository(self.db)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_initial_dashboard_has_zero_fake_stats(self) -> None:
        summary = self.repo.get_dashboard_summary()
        self.assertEqual(summary["total_imported_videos"], 0)
        self.assertEqual(summary["connected_cameras"], 0)
        self.assertEqual(summary["detected_person_events"], 0)
        self.assertEqual(summary["anonymous_person_profiles"], 0)
        self.assertEqual(summary["authorized_registered_profiles"], 0)
        self.assertEqual(summary["pending_security_reviews"], 0)
        self.assertFalse(summary["system_capabilities"]["biometric_identification_enabled"])

    def test_camera_and_profile_crud_writes_audit_logs(self) -> None:
        cam = self.repo.create_camera(
            {
                "name": "East Loading Dock",
                "location_zone": "Warehouse A",
                "source_type": "rtsp",
                "stream_uri": "rtsp://admin:SuperSecretPass@127.0.0.1:65432/stream1",
            }
        )
        self.assertEqual(cam["name"], "East Loading Dock")
        self.assertNotIn("SuperSecretPass", cam["stream_uri"])
        self.assertEqual(cam["stream_uri"], "rtsp://127.0.0.1:65432/stream1")
        self.assertEqual(cam["username"], "admin")
        self.assertTrue(cam["has_credentials"])
        self.assertEqual(len(self.repo.list_cameras()), 1)

        updated_cam = self.repo.update_camera(cam["id"], {"enabled": False, "retention_days": 60})
        self.assertFalse(updated_cam["enabled"])
        self.assertEqual(updated_cam["retention_days"], 60)

        probe_res = self.repo.check_camera(cam["id"])
        self.assertEqual(probe_res["camera"]["status"], "offline")
        self.assertIn("TCP connection failed", probe_res["message"])
        self.assertNotIn("SuperSecretPass", probe_res["message"])

        profile = self.repo.create_profile(
            {
                "display_name": "Facility Operator 01",
                "category": "authorized",
                "authorization_level": "authorized",
                "consent_status": "granted",
                "department_or_zone": "Warehouse A",
            }
        )
        self.assertTrue(profile["profile_code"].startswith("LFX-"))
        self.assertEqual(profile["consent_status"], "granted")

        updated_profile = self.repo.update_profile(profile["id"], {"department_or_zone": "Control Room"})
        self.assertEqual(updated_profile["department_or_zone"], "Control Room")

        summary = self.repo.get_dashboard_summary()
        self.assertEqual(summary["authorized_registered_profiles"], 1)

        logs = self.repo.list_audit_logs(limit=20)
        for entry in logs:
            self.assertNotIn("SuperSecretPass", entry["details"])
        actions = {entry["action"] for entry in logs}
        self.assertIn("CAMERA_CREATED", actions)
        self.assertIn("CAMERA_UPDATED", actions)
        self.assertIn("CAMERA_HEALTH_CHECKED", actions)
        self.assertIn("PROFILE_CREATED", actions)
        self.assertIn("PROFILE_UPDATED", actions)

        self.repo.delete_profile(profile["id"])
        self.assertEqual(len(self.repo.list_profiles()), 0)

        self.repo.delete_camera(cam["id"])
        self.assertEqual(len(self.repo.list_cameras()), 0)

    def test_consent_policy_and_settings_allowlist(self) -> None:
        with self.assertRaises(PolicyViolationError):
            self.repo.create_profile(
                {
                    "display_name": "Unconsented Staff",
                    "category": "authorized",
                    "authorization_level": "authorized",
                    "consent_status": "pending",
                }
            )

        updated_settings = self.repo.update_settings(
            {"default_retention_days": "90", "malicious_arbitrary_key": "blocked"}
        )
        self.assertEqual(updated_settings["default_retention_days"], "90")
        self.assertNotIn("malicious_arbitrary_key", updated_settings)

    def test_local_archive_probe_and_ingest(self) -> None:
        import subprocess
        clip = Path(self.tmp.name) / "local_cam_feed.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=navy:s=320x240:d=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip),
            ],
            capture_output=True,
            check=True,
        )
        cam = self.repo.create_camera(
            {
                "name": "Local Archive Cam",
                "location_zone": "Lab",
                "source_type": "local_archive",
                "stream_uri": str(clip),
            }
        )
        probe = self.repo.check_camera(cam["id"])
        self.assertEqual(probe["camera"]["status"], "online")
        self.assertEqual(probe["probe"]["width"], 320)

        ingested = self.repo.ingest_local_camera_videos(cam["id"])
        self.assertEqual(len(ingested), 1)
        self.assertEqual(ingested[0]["original_name"], "local_cam_feed.mp4")


if __name__ == "__main__":
    unittest.main()
