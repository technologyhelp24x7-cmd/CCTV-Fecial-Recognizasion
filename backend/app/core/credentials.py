"""Cross-platform OS-protected credential store & URI secret sanitization for LumaFlux Intelligence.

Stores camera and NVR passwords outside SQLite:
  - Windows: DPAPI-protected master key (CryptProtectData / CryptUnprotectData)
  - macOS: Keychain Services (`security` generic password) with AES-256-GCM vault
  - Linux / fallback: 256-bit random master key (`0600`) encrypting AES-256-GCM `.vault.json` (`0600`)
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import quote, unquote, urlparse, urlunparse

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_KEYCHAIN_SERVICE = "LumaFlux Intelligence"
_KEYCHAIN_ACCOUNT = "lumaflux-vault-master-key"
_INLINE_CRED_RE = re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://[^:/\s@]+:)([^@\s/]+)(@)")
_QUERY_SECRET_RE = re.compile(r"((?:password|passwd|pwd|pass|token|secret)=)([^&\s]+)", re.IGNORECASE)


def _chmod_owner_only(path: Path) -> None:
    if os.name == "posix":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def _dpapi_protect(raw: bytes) -> Optional[bytes]:
    if sys.platform != "win32":
        return None
    try:
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = DATA_BLOB(len(raw), buf)
        blob_out = DATA_BLOB()
        if not crypt32.CryptProtectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def _dpapi_unprotect(enc: bytes) -> Optional[bytes]:
    if sys.platform != "win32":
        return None
    try:
        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        buf = ctypes.create_string_buffer(enc, len(enc))
        blob_in = DATA_BLOB(len(enc), buf)
        blob_out = DATA_BLOB()
        if not crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


class CredentialVault:
    """Interoperable encrypted secret store shared between Python FastAPI and Node Express."""

    def __init__(self, vault_dir: Path) -> None:
        self.vault_dir = Path(vault_dir).resolve()
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self.vault_path = self.vault_dir / ".vault.json"
        self.key_path = self.vault_dir / ".vault.key"
        self.dpapi_key_path = self.vault_dir / ".vault.key.dpapi"

    @property
    def backend_name(self) -> str:
        if sys.platform == "win32" and self.dpapi_key_path.exists():
            return "windows-dpapi+aes-256-gcm"
        if sys.platform == "darwin":
            return "macos-keychain+aes-256-gcm"
        return "aes-256-gcm-file-key"

    def _get_or_create_master_key(self) -> bytes:
        # 1. Windows DPAPI-protected master key
        if sys.platform == "win32" and self.dpapi_key_path.exists():
            dec = _dpapi_unprotect(self.dpapi_key_path.read_bytes())
            if dec and len(dec) == 32:
                return dec

        # 2. macOS Keychain master key
        if sys.platform == "darwin":
            try:
                proc = subprocess.run(
                    ["security", "find-generic-password", "-s", _KEYCHAIN_SERVICE, "-a", _KEYCHAIN_ACCOUNT, "-w"],
                    capture_output=True,
                    text=True,
                    timeout=3.0,
                    check=False,
                )
                if proc.returncode == 0 and len(proc.stdout.strip()) == 64:
                    return bytes.fromhex(proc.stdout.strip())
            except Exception:
                pass

        # 3. File-backed key (shared hex format with Node crypto)
        if self.key_path.exists():
            raw_hex = self.key_path.read_text(encoding="utf-8").strip()
            if len(raw_hex) == 64:
                return bytes.fromhex(raw_hex)

        master_key = secrets.token_bytes(32)
        master_hex = master_key.hex()

        if sys.platform == "win32":
            protected = _dpapi_protect(master_key)
            if protected:
                self.dpapi_key_path.write_bytes(protected)
                return master_key

        if sys.platform == "darwin":
            try:
                proc = subprocess.run(
                    [
                        "security",
                        "add-generic-password",
                        "-U",
                        "-s",
                        _KEYCHAIN_SERVICE,
                        "-a",
                        _KEYCHAIN_ACCOUNT,
                        "-w",
                        master_hex,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=3.0,
                    check=False,
                )
                if proc.returncode == 0:
                    return master_key
            except Exception:
                pass

        self.key_path.write_text(master_hex, encoding="utf-8")
        _chmod_owner_only(self.key_path)
        return master_key

    def _load_vault_doc(self) -> dict:
        if not self.vault_path.exists():
            return {"version": 1, "backend": self.backend_name, "entries": {}}
        try:
            doc = json.loads(self.vault_path.read_text(encoding="utf-8"))
            if isinstance(doc, dict) and isinstance(doc.get("entries"), dict):
                return doc
        except Exception:
            pass
        return {"version": 1, "backend": self.backend_name, "entries": {}}

    def _save_vault_doc(self, doc: dict) -> None:
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self.vault_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
        _chmod_owner_only(self.vault_path)

    def set_secret(self, ref: str, secret_value: str) -> str:
        if not ref:
            raise ValueError("Credential reference id is required.")
        key = self._get_or_create_master_key()
        iv = secrets.token_bytes(12)
        aes = AESGCM(key)
        ct_and_tag = aes.encrypt(iv, secret_value.encode("utf-8"), ref.encode("utf-8"))
        ciphertext = ct_and_tag[:-16]
        tag = ct_and_tag[-16:]

        doc = self._load_vault_doc()
        doc["backend"] = self.backend_name
        doc["entries"][ref] = {
            "v": 1,
            "alg": "aes-256-gcm",
            "iv": base64.b64encode(iv).decode("ascii"),
            "tag": base64.b64encode(tag).decode("ascii"),
            "data": base64.b64encode(ciphertext).decode("ascii"),
        }
        self._save_vault_doc(doc)
        return ref

    def get_secret(self, ref: Optional[str]) -> Optional[str]:
        if not ref:
            return None
        doc = self._load_vault_doc()
        entry = doc.get("entries", {}).get(ref)
        if not isinstance(entry, dict):
            return None
        try:
            key = self._get_or_create_master_key()
            iv = base64.b64decode(entry["iv"])
            tag = base64.b64decode(entry["tag"])
            ciphertext = base64.b64decode(entry["data"])
            aes = AESGCM(key)
            plaintext = aes.decrypt(iv, ciphertext + tag, ref.encode("utf-8"))
            return plaintext.decode("utf-8")
        except Exception:
            return None

    def has_secret(self, ref: Optional[str]) -> bool:
        if not ref:
            return False
        doc = self._load_vault_doc()
        return ref in doc.get("entries", {})

    def delete_secret(self, ref: Optional[str]) -> bool:
        if not ref:
            return False
        doc = self._load_vault_doc()
        if ref not in doc.get("entries", {}):
            return False
        del doc["entries"][ref]
        self._save_vault_doc(doc)
        return True


def strip_uri_credentials(uri: str) -> tuple[str, Optional[str], Optional[str]]:
    """Strip inline username/password from network URI; return (clean_uri, username, password)."""
    raw = (uri or "").strip()
    if not raw or "://" not in raw:
        return raw, None, None
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in ("rtsp", "rtsps", "http", "https"):
        return raw, None, None
    username = unquote(parsed.username) if parsed.username is not None else None
    password = unquote(parsed.password) if parsed.password is not None else None
    if parsed.username is None and parsed.password is None:
        return raw, None, None
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{parsed.port}" if parsed.port else host
    clean = urlunparse((parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))
    return clean, username, password


def inject_uri_credentials(uri: str, username: Optional[str], password: Optional[str]) -> str:
    """Inject credentials strictly in-memory for FFmpeg / ONVIF subprocess calls."""
    raw = (uri or "").strip()
    if not raw or "://" not in raw or (not username and not password):
        return raw
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in ("rtsp", "rtsps", "http", "https"):
        return raw
    # Do not overwrite if caller already passed an explicit runtime credential URI
    if parsed.username or parsed.password:
        return raw
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    user_enc = quote(username or "", safe="")
    pass_enc = quote(password or "", safe="")
    auth_part = f"{user_enc}:{pass_enc}@" if password else f"{user_enc}@"
    netloc = f"{auth_part}{host}:{parsed.port}" if parsed.port else f"{auth_part}{host}"
    return urlunparse((parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def sanitize_secret_text(text: str, *extra_secrets: Optional[str]) -> str:
    """Scrub URLs and explicit secret values before writing logs, errors, or audit entries."""
    cleaned = text or ""
    for secret in extra_secrets:
        if secret:
            cleaned = cleaned.replace(secret, "****")
            cleaned = cleaned.replace(quote(secret, safe=""), "****")
    cleaned = _INLINE_CRED_RE.sub(r"\1****\3", cleaned)
    cleaned = _QUERY_SECRET_RE.sub(r"\1****", cleaned)
    return cleaned
