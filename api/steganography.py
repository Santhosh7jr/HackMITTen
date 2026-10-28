import io
import secrets

import numpy as np
from PIL import Image

HEADER_MAGIC = b"CVS1"
HEADER_SIZE = 24
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 2_500_000
MAX_PAYLOAD_BYTES = 1_000_000


def _read_png(image_bytes: bytes) -> np.ndarray:
    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("PNG image must be smaller than 8 MB.")
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            if image.format != "PNG":
                raise ValueError("Secure messages require a PNG image.")
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("PNG image dimensions are too large.")
            return np.asarray(image.convert("RGB"), dtype=np.uint8).copy()
    except OSError as error:
        raise ValueError("The uploaded image is not a valid PNG.") from error


def embed_payload(image_bytes: bytes, payload: bytes) -> bytes:
    if not payload or len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError("Encrypted text is empty or too large.")

    pixels = _read_png(image_bytes)
    channels = pixels.reshape(-1)
    required_bits = len(payload) * 8
    available_bits = channels.size - HEADER_SIZE * 8
    if required_bits > available_bits:
        raise ValueError("The PNG image is too small to hold this encrypted text.")

    seed = secrets.token_bytes(16)
    header = HEADER_MAGIC + seed + len(payload).to_bytes(4, "big")
    header_bits = np.unpackbits(np.frombuffer(header, dtype=np.uint8))
    channels[: header_bits.size] = (channels[: header_bits.size] & 0xFE) | header_bits

    payload_bits = np.unpackbits(np.frombuffer(payload, dtype=np.uint8))
    rng = np.random.default_rng(int.from_bytes(seed, "big"))
    positions = rng.choice(
        np.arange(header_bits.size, channels.size, dtype=np.int64),
        size=payload_bits.size,
        replace=False,
    )
    channels[positions] = (channels[positions] & 0xFE) | payload_bits

    output = io.BytesIO()
    Image.fromarray(pixels, mode="RGB").save(output, format="PNG")
    return output.getvalue()


def extract_payload(image_bytes: bytes) -> bytes:
    pixels = _read_png(image_bytes)
    channels = pixels.reshape(-1)
    header_size_bits = HEADER_SIZE * 8
    if channels.size < header_size_bits:
        raise ValueError("The PNG image does not contain a secure message.")

    header_bits = channels[:header_size_bits] & 1
    header = np.packbits(header_bits).tobytes()
    if header[: len(HEADER_MAGIC)] != HEADER_MAGIC:
        raise ValueError("The PNG image does not contain a secure message.")

    seed = header[4:20]
    payload_size = int.from_bytes(header[20:24], "big")
    payload_bits_count = payload_size * 8
    if (
        payload_size == 0
        or payload_size > MAX_PAYLOAD_BYTES
        or payload_bits_count > channels.size - header_size_bits
    ):
        raise ValueError("The embedded message data is invalid.")

    rng = np.random.default_rng(int.from_bytes(seed, "big"))
    positions = rng.choice(
        np.arange(header_size_bits, channels.size, dtype=np.int64),
        size=payload_bits_count,
        replace=False,
    )
    return np.packbits(channels[positions] & 1).tobytes()
