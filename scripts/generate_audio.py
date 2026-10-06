"""
Build the seed exercise library.

Reads content/passages.json, where mismatches are marked as [displayed|spoken:trap-category],
synthesises the *spoken* version with Kokoro (open-source neural TTS, run locally),
and writes:
  public/audio/<id>.mp3          the audio learners hear
  public/content/library.json    tokens with exact per-word timestamps

Usage:  npm run audio            (all passages, skipping ones already generated)
        npm run audio -- --force (regenerate everything)
        npm run audio -- r01 d03 (only these ids)

Setup:  python3 -m venv .venv-tts
        .venv-tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
        .venv-tts/bin/pip install "kokoro>=0.9.4" soundfile lameenc
"""

import json
import re
import sys
import warnings
from pathlib import Path

import lameenc
import numpy as np

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "content" / "passages.json"
AUDIO_DIR = ROOT / "public" / "audio"
OUT = ROOT / "public" / "content" / "library.json"
SAMPLE_RATE = 24_000

VOICES = {
    # voice: (lang_code, accent, speaker label)
    "af_heart": ("a", "US", "US female (Heart)"),
    "af_bella": ("a", "US", "US female (Bella)"),
    "am_michael": ("a", "US", "US male (Michael)"),
    "bf_emma": ("b", "UK", "UK female (Emma)"),
    "bm_george": ("b", "UK", "UK male (George)"),
    "bm_fable": ("b", "UK", "UK male (Fable)"),
}

MARK = re.compile(r"^(?P<lead>[^\w\[]*)\[(?P<display>[^|\]]+)\|(?P<spoken>[^:\]]+):(?P<cat>[a-z-]+)\](?P<trail>\W*)$")
LEAD = re.compile(r"^[^\w]+")
TRAIL = re.compile(r"[^\w%]+$")


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.lower())


def parse(text: str):
    words = []
    for chunk in text.split():
        m = MARK.match(chunk)
        if m:
            words.append(dict(lead=m["lead"], display=m["display"], spoken=m["spoken"], cat=m["cat"], trail=m["trail"]))
            continue
        lead = (LEAD.match(chunk) or [""])[0]
        rest = chunk[len(lead):]
        trail_m = TRAIL.search(rest)
        trail = trail_m.group(0) if trail_m else ""
        core = rest[: len(rest) - len(trail)] if trail else rest
        if not core:
            words[-1]["trail"] += " " + chunk
            continue
        words.append(dict(lead=lead, display=core, spoken=core, cat=None, trail=trail))
    return words


def synth(pipelines, voice: str, text: str):
    lang = VOICES[voice][0]
    if lang not in pipelines:
        from kokoro import KPipeline

        pipelines[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
    audio_parts, ktokens, offset = [], [], 0.0
    for r in pipelines[lang](text, voice=voice, speed=1.0):
        audio = r.audio.numpy() if hasattr(r.audio, "numpy") else np.asarray(r.audio)
        for t in r.tokens or []:
            ktokens.append((t.text, None if t.start_ts is None else t.start_ts + offset, None if t.end_ts is None else t.end_ts + offset))
        audio_parts.append(audio)
        offset += len(audio) / SAMPLE_RATE
    return np.concatenate(audio_parts), ktokens, offset


def align(words, ktokens, pid):
    """Map Kokoro tokens onto our spoken words (merging when Kokoro splits a word)."""
    kwords = [(norm(t), s, e) for t, s, e in ktokens if norm(t)]
    timings, k = [], 0
    for w in words:
        target = norm(w["spoken"])
        acc, start, end = "", None, None
        while k < len(kwords) and len(acc) < len(target):
            text, s, e = kwords[k]
            acc += text
            start = s if start is None else start
            end = e if e is not None else end
            k += 1
        if acc != target:
            raise SystemExit(f"[{pid}] alignment failed at '{w['spoken']}' (got '{acc}')")
        timings.append([start, end])
    # Fill any missing timestamps by interpolation.
    for i, (s, e) in enumerate(timings):
        if s is None:
            timings[i][0] = timings[i - 1][1] if i else 0.0
        if e is None:
            nxt = next((t[0] for t in timings[i + 1:] if t[0] is not None), None)
            timings[i][1] = nxt if nxt is not None else timings[i][0] + 0.3
    return timings


def to_mp3(audio) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    enc = lameenc.Encoder()
    enc.set_bit_rate(56)
    enc.set_in_sample_rate(SAMPLE_RATE)
    enc.set_channels(1)
    enc.set_quality(2)
    return enc.encode(pcm.tobytes()) + enc.flush()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    passages = json.loads(SRC.read_text())
    existing = {e["id"]: e for e in json.loads(OUT.read_text())} if OUT.exists() else {}
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pipelines = {}
    library = []
    for p in passages:
        pid = p["id"]
        mp3 = AUDIO_DIR / f"{pid}.mp3"
        prev = existing.get(pid)
        up_to_date = prev and mp3.exists() and prev.get("sourceText") == p["text"]
        if up_to_date and not force and pid not in args:
            library.append(prev)
            continue
        words = parse(p["text"])
        spoken_text = " ".join(w["lead"] + w["spoken"] + w["trail"] for w in words)
        audio, ktokens, duration = synth(pipelines, p["voice"], spoken_text)
        timings = align(words, ktokens, pid)
        mp3.write_bytes(to_mp3(audio))
        _, accent, speaker = VOICES[p["voice"]]
        tokens = [
            {
                "index": i,
                "displayText": w["display"],
                "spokenText": w["spoken"],
                "startMs": round(s * 1000),
                "endMs": round(e * 1000),
                "isIncorrect": w["display"] != w["spoken"],
                **({"trapCategory": w["cat"]} if w["cat"] else {}),
                "leading": w["lead"],
                "trailing": w["trail"],
            }
            for i, (w, (s, e)) in enumerate(zip(words, timings))
        ]
        library.append(
            {
                "id": pid,
                "title": p["title"],
                "topic": p["topic"],
                "kind": p["kind"],
                "difficulty": p["difficulty"],
                "source": "tts-timestamped",
                "audioUrl": f"/audio/{pid}.mp3",
                "durationMs": round(duration * 1000),
                "accent": accent,
                "voice": speaker,
                "timing": "exact",
                "tokens": tokens,
                "tags": ["synthetic-audio", "kokoro"],
                "sourceText": p["text"],
            }
        )
        n_bad = sum(t["isIncorrect"] for t in tokens)
        print(f"{pid:5} {p['voice']:11} {duration:5.1f}s {len(tokens):3} words {n_bad} mismatches")
    # Keep human-voice items built by build_human_audio.py.
    library += [e for e in existing.values() if "human-audio" in e.get("tags", []) or e.get("archived")]
    OUT.write_text(json.dumps(library, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {len(library)} exercises → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
