"""
OpenWhispr Intel NPU Transcription Server

A lightweight FastAPI server that wraps openvino-genai's WhisperPipeline
to run Whisper speech-to-text on Intel NPU (AI Boost) hardware.

API matches whisper-server's /inference endpoint for drop-in compatibility.
"""

import argparse
import asyncio
import io
import json
import logging
import sys
import tempfile
import os

import numpy as np
import openvino_genai
import soundfile as sf
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="[NPU] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI()
pipeline = None
model_path = None
device_name = None
# Serialize NPU inference — the static pipeline doesn't handle concurrent requests
inference_lock = asyncio.Lock()


def load_audio(audio_bytes: bytes) -> np.ndarray:
    """Load audio bytes into a float32 numpy array at 16kHz mono."""
    audio_io = io.BytesIO(audio_bytes)
    try:
        audio, sr = sf.read(audio_io, dtype="float32")
    except Exception:
        # If soundfile can't read it directly, write to temp file
        # (handles formats like webm that need file extension hints)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        try:
            audio, sr = sf.read(tmp_path, dtype="float32")
        finally:
            os.unlink(tmp_path)

    # Convert stereo to mono
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Resample to 16kHz if needed
    if sr != 16000:
        try:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
        except ImportError:
            logger.warning("librosa not available for resampling, audio may not transcribe correctly")

    return audio.astype(np.float32)


@app.get("/")
async def health():
    """Health check endpoint - matches whisper-server pattern."""
    return JSONResponse({"status": "ok", "device": "NPU", "model": model_path})


@app.post("/inference")
async def inference(
    file: UploadFile = File(...),
    language: str = Form("auto"),
    prompt: str = Form(None),
    response_format: str = Form("json"),
):
    """Transcribe audio using Intel NPU via openvino-genai WhisperPipeline."""
    global pipeline

    if pipeline is None:
        return JSONResponse(
            status_code=503,
            content={"error": "Pipeline not loaded"},
        )

    try:
        audio_bytes = await file.read()

        async with inference_lock:
            audio = load_audio(audio_bytes)

            # Pad short audio to minimum 3 seconds — NPU static pipeline needs
            # sufficient audio length to reliably detect speech
            min_samples = 16000 * 3  # 3 seconds at 16kHz
            if len(audio) < min_samples:
                audio = np.pad(audio, (0, min_samples - len(audio)), mode="constant")

            # Build a fresh config each time to avoid stale state
            config = openvino_genai.WhisperGenerationConfig()
            config.max_new_tokens = 448

            if language and language != "auto":
                lang_token = language if language.startswith("<|") else f"<|{language}|>"
                try:
                    config.language = lang_token
                except Exception as lang_err:
                    logger.warning(f"Could not set language '{lang_token}': {lang_err}, using auto-detect")

            # initial_prompt is not supported on NPU static pipeline — skip for NPU
            if prompt and device_name != "NPU":
                config.initial_prompt = prompt

            result = pipeline.generate(audio, config)

            # Parse result - openvino_genai returns a DecodedResults or string
            if hasattr(result, "texts"):
                text = " ".join(result.texts).strip()
            elif hasattr(result, "__str__"):
                text = str(result).strip()
            else:
                text = result.strip() if isinstance(result, str) else ""

            logger.info(f"Transcribed {len(audio) / 16000:.1f}s audio -> {len(text)} chars")

        return JSONResponse({"text": text})

    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )


def main():
    parser = argparse.ArgumentParser(description="OpenWhispr NPU Server")
    parser.add_argument("--model", required=True, help="Path to OpenVINO IR model directory")
    parser.add_argument("--port", type=int, default=9178, help="Server port")
    parser.add_argument("--host", default="127.0.0.1", help="Server host")
    parser.add_argument("--device", default="NPU", help="OpenVINO device (NPU, CPU, GPU)")
    args = parser.parse_args()

    global pipeline, model_path, device_name
    model_path = args.model
    device_name = args.device

    logger.info(f"Loading WhisperPipeline from {args.model} on {args.device}...")

    try:
        pipeline = openvino_genai.WhisperPipeline(
            args.model, args.device, STATIC_PIPELINE=(args.device == "NPU")
        )
        logger.info(f"Pipeline loaded successfully on {args.device}")
    except Exception as e:
        logger.error(f"Failed to load pipeline on {args.device}: {e}")
        if args.device == "NPU":
            logger.info("Falling back to CPU...")
            try:
                pipeline = openvino_genai.WhisperPipeline(args.model, "CPU")
                logger.info("Pipeline loaded on CPU (NPU fallback)")
            except Exception as e2:
                logger.error(f"CPU fallback also failed: {e2}")
                sys.exit(1)

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
