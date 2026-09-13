"""Everything the agent sends to the Worker."""

from __future__ import annotations

import io
from pathlib import Path

import requests
from PIL import Image

from common import auth_header, worker_endpoint


def push_status(config: dict, payload: dict) -> None:
    response = requests.post(f"{worker_endpoint(config)}/status", json=payload,
                             headers=auth_header(config), timeout=15)
    response.raise_for_status()


def push_image(config: dict, route: str, image: bytes) -> None:
    """route: "shot" (the latest frame) or "pano" (the logout panorama)."""
    response = requests.post(f"{worker_endpoint(config)}/{route}", data=image,
                             headers={**auth_header(config), "Content-Type": "image/jpeg"}, timeout=60)
    response.raise_for_status()


def encode_jpeg(path: Path, quality: int, max_width: int | None = None) -> bytes:
    with Image.open(path) as image:
        image = image.convert("RGB")
        if max_width and image.width > max_width:
            height = round(image.height * max_width / image.width)
            image = image.resize((max_width, height), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=quality, optimize=True)
        return buffer.getvalue()
