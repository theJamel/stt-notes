"""OpenAI-compatible Whisper server for local testing.

Usage:
  python test/whisper_server.py                          # tiny model, port 8080
  python test/whisper_server.py --model base             # base model
  python test/whisper_server.py --model large-v3 --port 9000

The model downloads automatically on first run.

GPU: pass --device cuda --compute-type float16. On Windows this needs the CUDA
libraries CTranslate2 links against, installed as wheels:
  python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
Their DLLs live inside site-packages and aren't on PATH, so _register_cuda_dlls()
below adds them before faster_whisper (→ CTranslate2) loads.
"""
import argparse
import io
import logging
import os
import sys


def _register_cuda_dlls():
    """Make the pip-installed CUDA DLLs discoverable so --device cuda works on
    Windows without manually editing PATH. No-op elsewhere / if not installed."""
    if sys.platform != "win32":
        return
    import importlib.util
    for pkg in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(pkg)
            if not (spec and spec.submodule_search_locations):
                continue
            bindir = os.path.join(spec.submodule_search_locations[0], "bin")
            if os.path.isdir(bindir):
                os.add_dll_directory(bindir)
                # cuDNN lazily loads its own sub-DLLs (e.g. cudnn_ops64_9.dll) at
                # first inference via the legacy search order, which consults PATH
                # but NOT add_dll_directory — so prepend to PATH as well.
                os.environ["PATH"] = bindir + os.pathsep + os.environ.get("PATH", "")
        except Exception:
            pass  # fall through; CUDA just won't be available


_register_cuda_dlls()

from fastapi import FastAPI, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
import uvicorn

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("whisper-server")

app = FastAPI(title="Local Whisper Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None
_model_size = None


def get_model(size: str) -> WhisperModel:
    global _model, _model_size
    if _model is None or _model_size != size:
        log.info(f"Loading whisper model: {size} (device={args.device}, compute_type={args.compute_type})")
        _model = WhisperModel(size, device=args.device, compute_type=args.compute_type)
        _model_size = size
        log.info(f"Model {size} loaded.")
    return _model


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile,
    model: str = Form(default="whisper-1"),
    language: str | None = Form(default=None),
    response_format: str = Form(default="json"),
):
    audio_bytes = await file.read()
    segments, info = get_model(args.model).transcribe(
        io.BytesIO(audio_bytes),
        language=language if language and language != "auto" else None,
    )
    text = " ".join(seg.text for seg in segments).strip()
    return {"text": text}


@app.get("/health")
async def health():
    return {"status": "ok", "model": args.model}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="tiny", help="Model size: tiny, base, small, medium, large-v3")
    parser.add_argument("--port", type=int, default=8080)
    # CPU/int8 works everywhere. "auto"/"cuda" needs a CUDA GPU *and* cuDNN
    # installed — otherwise faster-whisper crashes mid-request loading cudnn_*.dll.
    parser.add_argument("--device", default="cpu", help="cpu, cuda, or auto")
    parser.add_argument("--compute-type", default="int8", help="int8, float16, float32, or auto")
    args = parser.parse_args()

    log.info(f"Starting Whisper server on port {args.port} with model '{args.model}'")
    uvicorn.run(app, host="0.0.0.0", port=args.port)
