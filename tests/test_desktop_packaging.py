"""Verification tests for Tauri 2 desktop packaging configuration, icons, and resource paths."""

from __future__ import annotations

import json
import unittest
from pathlib import Path


class TestDesktopPackaging(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(__file__).resolve().parents[1]
        self.tauri_dir = self.root / "desktop" / "src-tauri"
        self.conf = json.loads((self.tauri_dir / "tauri.conf.json").read_text(encoding="utf-8"))

    def test_tauri_targets_and_resources_exist(self) -> None:
        bundle = self.conf["bundle"]
        self.assertTrue(bundle["active"])
        for target in ("msi", "nsis", "dmg", "app"):
            self.assertIn(target, bundle["targets"])

        self.assertEqual(bundle["macOS"]["minimumSystemVersion"], "12.0")
        self.assertEqual(bundle["windows"]["webviewInstallMode"]["type"], "downloadBootstrapper")

        resources = bundle["resources"]
        self.assertIsInstance(resources, dict)
        for rel_resource, dest_name in resources.items():
            resolved = (self.tauri_dir / rel_resource).resolve()
            self.assertTrue(resolved.exists(), f"Missing bundle resource: {resolved}")
            self.assertTrue(dest_name.endswith("/"), f"Expected directory destination for {dest_name}")

    def test_tauri_icons_exist_and_have_valid_headers(self) -> None:
        icons = self.conf["bundle"]["icon"]
        self.assertGreaterEqual(len(icons), 5)
        for rel_icon in icons:
            icon_path = (self.tauri_dir / rel_icon).resolve()
            self.assertTrue(icon_path.exists(), f"Missing icon: {icon_path}")
            header = icon_path.read_bytes()[:8]
            if icon_path.suffix == ".png":
                self.assertTrue(header.startswith(b"\x89PNG\r\n\x1a\n"))
            elif icon_path.suffix == ".ico":
                self.assertTrue(header.startswith(b"\x00\x00\x01\x00"))
            elif icon_path.suffix == ".icns":
                self.assertTrue(header.startswith(b"icns"))

    def test_rust_entry_and_capabilities(self) -> None:
        lib_rs = (self.tauri_dir / "src" / "lib.rs").read_text(encoding="utf-8")
        self.assertIn("get_runtime_info", lib_rs)
        self.assertIn("pick_storage_directory", lib_rs)
        self.assertIn("LUMAFLUX_API_TOKEN", lib_rs)
        self.assertIn("LUMAFLUX_VAULT_DIR", lib_rs)
        self.assertIn("LUMAFLUX_FFMPEG_BIN", lib_rs)
        self.assertIn("/api/system/shutdown", lib_rs)
        self.assertIn("CREATE_NO_WINDOW", lib_rs)

        caps = json.loads((self.tauri_dir / "capabilities" / "default.json").read_text(encoding="utf-8"))
        self.assertIn("dialog:allow-open", caps["permissions"])
        self.assertIn("dialog:allow-save", caps["permissions"])


if __name__ == "__main__":
    unittest.main()
