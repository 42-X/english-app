"""
Pronunciations for the word games: public/audio/words/<word>.mp3, one per study word.

    .venv-tts/bin/python scripts/build_word_audio.py           # only words without a file yet
    .venv-tts/bin/python scripts/build_word_audio.py --force   # all of them
    .venv-tts/bin/python scripts/build_word_audio.py --check   # re-voice short words Whisper doesn't recognise

Voiced offline with Kokoro, slightly slow so each syllable is clear, in a UK and a US voice (PTE
recordings vary). Only the two clearest voices for single words: checked by transcribing samples with
Whisper, the male voices (bm_george, am_michael) garbled short words (tech, pour, prior).
"""

import json
import re
import sys
import warnings
import zlib
from pathlib import Path

import lameenc
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
WORDS = ROOT / "public" / "content" / "words.json"
OUT = ROOT / "public" / "audio" / "words"
VOICES = [("b", "bf_emma"), ("a", "af_bella")]
# Tried by --check when neither main voice is recognised.
EXTRA = [("a", "af_heart")]
RATE = 24_000


def mp3(pcm: np.ndarray) -> bytes:
    enc = lameenc.Encoder()
    enc.set_bit_rate(40)
    enc.set_in_sample_rate(RATE)
    enc.set_channels(1)
    enc.set_quality(2)
    data = (np.clip(pcm, -1, 1) * 32767).astype(np.int16).tobytes()
    return enc.encode(data) + enc.flush()


def voice(pipes: dict, w: str, lang: str, name: str) -> bytes | None:
    from kokoro import KPipeline

    if lang not in pipes:
        pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
    chunks = [np.asarray(a) for _, _, a in pipes[lang](w, voice=name, speed=0.9)]
    if not chunks:
        return None
    pcm = np.concatenate(chunks)
    # Trim long silences, keeping a generous lead-in: quiet first consonants (f, t, p, s) are
    # far below the vowel's level and a tight cut makes "foster" sound like "oster".
    loud = np.where(np.abs(pcm) > 0.008)[0]
    if len(loud):
        pcm = pcm[max(0, loud[0] - int(0.15 * RATE)) : loud[-1] + int(0.25 * RATE)]
    return mp3(pcm * min(3.0, 0.89 / (float(np.max(np.abs(pcm))) or 1.0)))


def voices_for(w: str) -> list[tuple[str, str]]:
    first = VOICES[zlib.crc32(w.encode()) % len(VOICES)]
    return [first] + [v for v in VOICES + EXTRA if v != first]


def main() -> None:
    warnings.filterwarnings("ignore")
    OUT.mkdir(parents=True, exist_ok=True)
    words = [x["w"] for x in json.loads(WORDS.read_text())["words"]]
    if "--check" in sys.argv:
        # Garbled recordings were short words (pour, prior, neck); long ones come out clean.
        return check([w for w in words if len(w) <= 7])
    todo = words if "--force" in sys.argv else [w for w in words if not (OUT / f"{w}.mp3").exists()]
    pipes: dict = {}
    for n, w in enumerate(todo, 1):
        lang, name = voices_for(w)[0]
        data = voice(pipes, w, lang, name)
        if data is None:
            print(f"no audio for {w}", file=sys.stderr)
            continue
        (OUT / f"{w}.mp3").write_bytes(data)
        if n % 200 == 0:
            print(f"{n}/{len(todo)}", flush=True)
    print(f"{len(todo)} new word recordings; {len(list(OUT.glob('*.mp3')))} total")


def check(words: list[str]) -> None:
    """Transcribe each recording; for one Whisper hears as another word, try the other voices and keep the first
    it recognises. Single words are hard even for Whisper (homophones like cite/sight never match), so a word
    no voice fixes keeps its first recording."""
    import io

    from faster_whisper import WhisperModel

    model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=12)
    pipes: dict = {}

    def heard(data: bytes) -> str:
        from build_human_audio import decode

        tmp = OUT / ".check.mp3"
        tmp.write_bytes(data)
        pcm = decode(tmp, 16_000)
        pad = np.zeros(8000, dtype=pcm.dtype)
        segs, _ = model.transcribe(np.concatenate([pad, pcm, pad]), language="en", beam_size=2, without_timestamps=True)
        text = re.sub(r"[^a-z ]", "", " ".join(s.text for s in segs).lower()).strip()
        return re.sub(r"^(a|an|the|its) ", "", text)

    fixed, unsure = [], []
    for n, w in enumerate(words, 1):
        path = OUT / f"{w}.mp3"
        if heard(path.read_bytes()) != w:
            for lang, name in voices_for(w)[1:]:
                data = voice(pipes, w, lang, name)
                if data and heard(data) == w:
                    path.write_bytes(data)
                    fixed.append(f"{w}:{name}")
                    break
            else:
                unsure.append(w)
        if n % 250 == 0:
            print(f"{n}/{len(words)} checked, {len(fixed)} re-voiced", flush=True)
    (OUT / ".check.mp3").unlink(missing_ok=True)
    print(f"re-voiced {len(fixed)}: {' '.join(fixed)}")
    print(f"no voice recognised ({len(unsure)}, mostly homophones/spelling variants): {' '.join(unsure)}")


if __name__ == "__main__":
    main()
