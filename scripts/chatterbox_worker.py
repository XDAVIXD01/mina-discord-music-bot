import json
import os
import re
import sys
import traceback
from contextlib import redirect_stderr
from pathlib import Path

import torch
import torchaudio as ta


try:
    import perth

    if getattr(perth, "PerthImplicitWatermarker", None) is None:
        class DummyWatermarker:
            def apply_watermark(self, wav, sample_rate=None):
                return wav

        perth.PerthImplicitWatermarker = DummyWatermarker
except Exception:
    pass

try:
    from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402
except Exception:
    ChatterboxTurboTTS = None
try:
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402
except Exception:
    ChatterboxMultilingualTTS = None
from chatterbox.tts import ChatterboxTTS  # noqa: E402


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def detect_expressive_mode(text):
    """Detecta texto emocional/animado sin añadir capas de audio externas."""
    text = text.strip()
    if not text:
        return False

    text_lower = text.lower()
    expressive_patterns = [
        r"[!?¡¿]{2,}",
        r"\b(jaja+|jeje+|jiji+|haha+|hehe+)\b",
        r"([aeiouáéíóú])\1{2,}",
        r"\b(wao+w*|wow+|ay+|uy+|oye+|vamos+|genial+|incre[ií]ble|sii+)\b",
    ]
    has_expressive_word = any(re.search(pattern, text_lower) for pattern in expressive_patterns)
    letters = [char for char in text if char.isalpha()]
    uppercase_ratio = sum(1 for char in letters if char.isupper()) / max(len(letters), 1)
    return has_expressive_word or (len(letters) >= 6 and uppercase_ratio > 0.65)


def detect_high_expressiveness(text):
    """Detecta expresividad alta para frases claramente animadas."""
    text_lower = text.lower()
    high_patterns = [
        r"a+h+a*h+",
        r"a+h+h+",
        r"j+a+j+a+",
        r"j+e+j+e+",
        r"w+o+w+",
        r"s+i+i+",
        r"g+e+n+i+a+l+",
        r"incre+[ií]+ble+",
        r"[!?¡¿]{3,}",
    ]
    return any(re.search(pattern, text_lower) for pattern in high_patterns)


def main():
    reference = Path(os.environ.get("MINA_VOICE_REFERENCE", "assets/voice/user_reference.wav")).resolve()
    if not reference.exists():
        raise FileNotFoundError(f"No existe la referencia de voz: {reference}")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    use_turbo = os.environ.get("MINA_VOICE_TURBO", "0") == "1" and ChatterboxTurboTTS is not None
    use_multilingual = not use_turbo and os.environ.get("MINA_VOICE_MULTILINGUAL", "1") != "0" and ChatterboxMultilingualTTS is not None
    model_name = "ChatterboxTurboTTS" if use_turbo else "ChatterboxMultilingualTTS" if use_multilingual else "ChatterboxTTS"
    print(f"[voice-worker] cargando {model_name} en {device} con {reference}", file=sys.stderr, flush=True)
    if use_turbo:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
        model.prepare_conditionals(str(reference), exaggeration=0.0, norm_loudness=True)
    elif use_multilingual:
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    else:
        model = ChatterboxTTS.from_pretrained(device=device)
        model.prepare_conditionals(str(reference), exaggeration=0.75)
    emit({"type": "ready", "device": device, "model": model_name, "sample_rate": model.sr})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request["id"]
            text = str(request["text"]).strip()
            out_path = Path(request["out"]).resolve()
            out_path.parent.mkdir(parents=True, exist_ok=True)
            is_expressive = detect_expressive_mode(text)
            high_mode = detect_high_expressiveness(text)
            with open(os.devnull, "w", encoding="utf8") as devnull, redirect_stderr(devnull):
                if use_turbo:
                    wav = model.generate(
                        text,
                        repetition_penalty=float(request.get("repetition_penalty", 1.05)),
                        top_p=float(request.get("top_p", 0.88 if is_expressive else 0.90)),
                        temperature=float(request.get("temperature", 0.93 if high_mode else 0.92 if is_expressive else 0.88)),
                        top_k=int(request.get("top_k", 600)),
                        norm_loudness=True,
                    )
                elif use_multilingual:
                    wav = model.generate(
                        text,
                        "es",
                        audio_prompt_path=str(reference),
                        repetition_penalty=float(request.get("repetition_penalty", 1.18 if is_expressive else 1.22)),
                        min_p=float(request.get("min_p", 0.01 if is_expressive else 0.02)),
                        top_p=float(request.get("top_p", 0.92 if high_mode else 0.91 if is_expressive else 0.93)),
                        exaggeration=float(request.get("exaggeration", 0.98 if high_mode else 0.95 if is_expressive else 0.92)),
                        cfg_weight=float(request.get("cfg_weight", 0.75 if high_mode else 0.72 if is_expressive else 0.58)),
                        temperature=float(request.get("temperature", 0.99 if high_mode else 0.98 if is_expressive else 0.95)),
                    )
                else:
                    wav = model.generate(
                        text,
                        repetition_penalty=float(request.get("repetition_penalty", 1.10 if is_expressive else 1.12)),
                        min_p=float(request.get("min_p", 0.02 if is_expressive else 0.03)),
                        top_p=float(request.get("top_p", 0.93 if is_expressive else 0.94)),
                        exaggeration=float(request.get("exaggeration", 0.93 if high_mode else 0.92 if is_expressive else 0.85)),
                        cfg_weight=float(request.get("cfg_weight", 0.62 if high_mode else 0.58 if is_expressive else 0.48)),
                        temperature=float(request.get("temperature", 0.95 if high_mode else 0.94 if is_expressive else 0.88)),
                    )
            ta.save(str(out_path), wav, model.sr)
            emit({"type": "done", "id": request_id, "out": str(out_path)})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "id": request.get("id") if "request" in locals() else None, "error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "fatal", "error": str(error)})
        raise
