"""Structured rotating file and console logging for LumaFlux Intelligence."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path


def configure_logging(log_dir: Path, level_name: str = "INFO") -> logging.Logger:
    log_dir.mkdir(parents=True, exist_ok=True)
    level = getattr(logging, level_name.upper(), logging.INFO)

    logger = logging.getLogger("lumaflux")
    logger.setLevel(level)

    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )

    file_handler = RotatingFileHandler(
        log_dir / "lumaflux-backend.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    logger.propagate = False
    return logger
