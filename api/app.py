import base64
import binascii
import logging
import threading

import cv2
import inspireface as isf
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from steganography import embed_payload, extract_payload

app = FastAPI()
logger = logging.getLogger(__name__)
_session: isf.InspireFaceSession | None = None
_session_lock = threading.Lock()


class FaceEnrollmentRequest(BaseModel):
    image_base64: str


class SteganographyRequest(BaseModel):
    image_base64: str
    payload_base64: str | None = None


def _get_session() -> isf.InspireFaceSession:
    global _session
    with _session_lock:
        if _session is None:
            if not isf.query_launch_status() and not isf.launch("Pikachu"):
                raise RuntimeError("InspireFace failed to initialize.")
            _session = isf.InspireFaceSession(
                param=isf.HF_ENABLE_FACE_RECOGNITION,
                detect_mode=isf.HF_DETECT_MODE_ALWAYS_DETECT,
                auto_launch=False,
            )
        return _session


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/face/embedding")
def create_face_embedding(request: FaceEnrollmentRequest) -> dict[str, str]:
    if len(request.image_base64) > 2_800_000:
        raise HTTPException(status_code=413, detail="The face image is too large.")

    try:
        image_bytes = base64.b64decode(request.image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="The face image is invalid.") from None

    if not image_bytes:
        raise HTTPException(status_code=400, detail="The face image is invalid.")
    if len(image_bytes) > 2_000_000:
        raise HTTPException(status_code=413, detail="The face image is too large.")

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="The captured image could not be read.")

    height, width = image.shape[:2]
    if width < 100 or height < 100 or width * height > 6_000_000:
        raise HTTPException(status_code=400, detail="The captured image dimensions are invalid.")

    try:
        session = _get_session()
        with _session_lock:
            faces = session.face_detection(image)
            if len(faces) != 1:
                raise HTTPException(
                    status_code=422,
                    detail="Capture exactly one face, centered and clearly visible.",
                )
            embedding = session.face_feature_extract(image, faces[0])
    except HTTPException:
        raise
    except Exception:
        logger.exception("InspireFace enrollment failed.")
        raise HTTPException(
            status_code=503,
            detail="Facial recognition is temporarily unavailable.",
        ) from None

    if embedding is None or embedding.size == 0:
        raise HTTPException(
            status_code=422,
            detail="A face template could not be created from this image.",
        )

    template = np.asarray(embedding, dtype="<f4")
    return {"embedding": base64.b64encode(template.tobytes()).decode("ascii")}


@app.post("/stego/embed")
def embed_encrypted_payload(request: SteganographyRequest) -> dict[str, str]:
    try:
        image_bytes = base64.b64decode(request.image_base64, validate=True)
        if request.payload_base64 is None:
            raise ValueError("Encrypted text is required.")
        payload = base64.b64decode(request.payload_base64, validate=True)
        stego_png = embed_payload(image_bytes, payload)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return {"image_base64": base64.b64encode(stego_png).decode("ascii")}


@app.post("/stego/extract")
def extract_encrypted_payload(request: SteganographyRequest) -> dict[str, str]:
    try:
        image_bytes = base64.b64decode(request.image_base64, validate=True)
        payload = extract_payload(image_bytes)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return {"payload_base64": base64.b64encode(payload).decode("ascii")}
