"""Piper-Sprachdienst für das ATC-Radar.

GET /tts?voice=atc|us|gb&speaker=N&text=...  ->  WAV (mono, 16 bit, halbe Abtastrate der Stimme)
GET /health                                  ->  Stimmen und Zahl der Sprecher

Stimmen (frei lizenziert): en_US-joe-medium (CC0) für den Lotsen,
en_US-libritts_r-medium und en_GB-vctk-medium (CC BY 4.0) für die Piloten.
"""
import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from piper import PiperVoice, SynthesisConfig

VOICE_DIR = os.environ.get("VOICE_DIR", "/voices")
PORT = int(os.environ.get("PORT", "5002"))
MAX_TEXT = 400
# Schlüssel -> (Stimme, Sprechtempo); der Lotse spricht zügiger als die Piloten
VOICES = {
    "atc": ("en_US-joe-medium", 0.85),
    "us": ("en_US-libritts_r-medium", 0.9),
    "gb": ("en_GB-vctk-medium", 0.9),
}

voices = {key: PiperVoice.load(os.path.join(VOICE_DIR, f"{name}.onnx")) for key, (name, _) in VOICES.items()}
# onnxruntime rechnet selbst auf mehreren Kernen; Anfragen nacheinander abarbeiten
lock = threading.Lock()


def synthesize(voice_key: str, speaker: int, text: str) -> bytes:
    voice = voices[voice_key]
    speakers = voice.config.num_speakers
    cfg = SynthesisConfig(
        speaker_id=speaker % speakers if speakers > 1 else None,
        length_scale=VOICES[voice_key][1],
    )
    with lock:
        chunks = [chunk.audio_float_array for chunk in voice.synthesize(text, syn_config=cfg)]
    audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    rate = voice.config.sample_rate
    # Funk überträgt nur bis etwa 3 kHz: halbe Abtastrate genügt (Mittel je Paar = einfacher Tiefpass)
    if rate >= 16000:
        audio = audio[: len(audio) // 2 * 2].reshape(-1, 2).mean(axis=1)
        rate //= 2
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (Name von BaseHTTPRequestHandler vorgegeben)
        url = urlparse(self.path)
        if url.path == "/health":
            info = {key: voice.config.num_speakers for key, voice in voices.items()}
            self.reply(200, "application/json", json.dumps(info).encode())
            return
        if url.path != "/tts":
            self.reply(404, "text/plain", b"not found")
            return
        query = parse_qs(url.query)
        voice = query.get("voice", ["atc"])[0]
        text = query.get("text", [""])[0].strip()
        try:
            speaker = int(query.get("speaker", ["0"])[0])
        except ValueError:
            speaker = 0
        if voice not in voices or not text or len(text) > MAX_TEXT:
            self.reply(400, "text/plain", b"bad request")
            return
        try:
            self.reply(200, "audio/wav", synthesize(voice, max(0, speaker), text))
        except Exception as err:  # noqa: BLE001 (Fehler an den Aufrufer melden statt abzustürzen)
            self.reply(500, "text/plain", str(err).encode())

    def reply(self, status: int, ctype: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:  # keine Zugriffs-Logs
        pass


if __name__ == "__main__":
    summary = ", ".join(f"{key}={voice.config.num_speakers}" for key, voice in voices.items())
    print(f"Piper-Sprachdienst auf Port {PORT} ({summary} Sprecher)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
