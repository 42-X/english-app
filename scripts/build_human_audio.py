"""
Human-voice HIW items from Spoken Wikipedia (CC BY-SA recordings of Wikipedia articles).

Stage 1 — candidates:
    .venv-tts/bin/python scripts/build_human_audio.py fetch
  Downloads the start of each recording, transcribes it with faster-whisper (word timestamps),
  and writes content/human/candidates.json: clean 18–45 s excerpts (sentence-aligned,
  high-confidence words only, spoken intro skipped).

  Re-run the excerpt picker on cached transcripts (no download / transcription):
    .venv-tts/bin/python scripts/build_human_audio.py rewindow

Stage 2 — build:
    .venv-tts/bin/python scripts/build_human_audio.py build
  Reads content/human/items.json (hand-written substitutions per excerpt), cuts the audio to
  public/audio/h-<id>.mp3 and merges exercises into public/content/library.json.

items.json entry:
  {"id": "h01", "candidate": "Oort_cloud#1", "kind": "realistic", "difficulty": 2,
   "range": [0, 60], "fix": {"13": "light-year"},
   "swaps": [{"at": 12, "from": "inner", "display": "outer", "cat": "semantic"}, ...]}
  `at` is the word index in the candidate excerpt and `from` the word expected there (checked);
  the spoken word stays in the audio and `display` replaces it on screen. `range` trims the
  excerpt (inclusive) and `fix` corrects transcription errors.
"""

import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
HUMAN = ROOT / "content" / "human"
CACHE = ROOT / ".cache" / "spoken"
CANDIDATES = HUMAN / "candidates.json"
# Exam-length excerpts (rewindow output, build input). Kept separate from fetch's working file.
EXAM_CANDIDATES = HUMAN / "candidates-exam.json"
ITEMS = HUMAN / "items.json"
LIBRARY = ROOT / "public" / "content" / "library.json"
AUDIO_DIR = ROOT / "public" / "audio"
UA = {"User-Agent": "hiw-trainer-content-builder/1.0 (github42x@gmail.com)"}

ARTICLES = [
    "Action potential", "Archaea", "Asteroid belt", "Antarctic krill", "Chemical synapse", "Climate change",
    "Cognitive dissonance", "Consciousness", "DNA", "Ediacaran biota", "Fermi paradox", "Gamma ray",
    "Helicobacter pylori", "Helium", "Hippocampus", "Introduction to evolution", "Oort cloud", "Open cluster",
    "Oxygen", "Planetary habitability", "Seawater", "Solar eclipse", "Sun", "Supermassive black hole",
    "Sustainable energy", "Universe", "Earth", "Saturn", "Mercury (planet)", "Light-year", "Salt dome",
    "Oil shale", "Crop yield", "Cane toad", "Blue whale", "Humpback whale", "Insect", "Bird",
    "Sexual dimorphism", "Territory (animal)", "Pair bond", "Dyslexia", "Stuttering", "Social anxiety",
    "Shyness", "False memory", "Curse of knowledge", "Big-fish–little-pond effect", "Self-handicapping",
    "Terror management theory", "Major depressive disorder", "Universal health care", "Hepatitis C",
    "Glucagon", "Bioinformatics", "Parallel computing", "Neural network (machine learning)",
    "Functional programming", "Sequence alignment", "Economics of coffee", "Economy of Africa",
    "Laissez-faire", "Gold standard", "Insider trading", "Post-scarcity", "Language", "Consonant", "Vowel",
    "Intonation (linguistics)", "Esperanto", "Transliteration", "Literary criticism", "Logic", "Humanism",
    "Han dynasty", "Antikythera mechanism", "Library of Ashurbanipal", "Nebra sky disc", "Pont du Gard",
    "Voynich manuscript", "Origins of the Cold War", "Council of Trent", "War elephant",
    "Natural history museum", "Investigative journalism", "Universal suffrage", "Habeas corpus", "Waterfall",
    "Antarctica", "Geography and ecology of the Everglades", "Fauna of Australia", "Tasmanian devil",
    "Iberian lynx", "Columbian mammoth", "Triceratops", "Theia (hypothetical planet)", "Space elevator",
    # Second batch: more academic topics so the library doesn't repeat within weeks.
    "Arctic tern", "American goldfinch", "Bobcat", "Cougar", "Eurasian beaver", "Orca", "Fin whale", "Tawny owl",
    "Poison dart frog", "Australian green tree frog", "Jaguar", "Island fox", "Cattle egret", "Black vulture",
    "Dusky dolphin", "Deinosuchus", "Climate", "Caesium", "Plutonium", "Yttrium", "Zinc", "Silver",
    "Hydrochloric acid", "Amethyst", "Joule", "Watt", "Arithmetic", "Parity of zero", "Pigeonhole principle",
    "Paradox", "Thought", "Connectionism", "Limerence", "Envy", "Hypochondria", "Asperger syndrome", "Disability",
    "Visual impairment", "Fluoxetine", "Fentanyl", "Balance disorder", "Vertigo", "Peyer's patch",
    "Behavioral neuroscience", "Quantum optics", "Fermion", "Titan (moon)", "Iapetus (moon)", "Mimas",
    "Comet Shoemaker–Levy 9", "Colonization of Mars", "Technological singularity", "Transhumanism",
    "Peter principle", "Ubuntu philosophy", "Politics and the English Language", "Split infinitive", "Synecdoche",
    "Gemination", "Roman dodecahedron", "Tower of London", "Sinking of the Titanic", "Andrée's Arctic balloon expedition",
    "Four-minute mile", "Daylight saving time", "Clock", "Bicycle", "Submarine", "Search engine optimization",
    "Markup language", "HTTP cookie", "Read-only memory", "Digital audio", "Microwave transmission", "Folding@home",
    "Silo", "Gas reinjection", "Monument to the Great Fire of London", "History of pizza", "Coffee",
]

INTRO_WORDS = re.compile(r"wikipedia|recording|recorded|licen[cs]e|creative commons|spoken|revision|article", re.I)
BAD_TEXT = re.compile(r"[()\[\]/@#&*]|pronounced|IPA|\bsee also\b", re.I)


def api(params: dict) -> dict:
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({**params, "format": "json"})
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30))


def find_recording(title: str):
    """First spoken-recording file for an article, with author + license metadata."""
    r = api({"action": "query", "titles": title, "prop": "images", "imlimit": 50, "redirects": 1})
    page = next(iter(r["query"]["pages"].values()))
    files = [i["title"] for i in page.get("images", []) if re.search(r"\.(ogg|oga|opus)$", i["title"], re.I)]
    if not files:
        return None
    # Prefer part 1 of multi-part recordings.
    files.sort(key=lambda f: (0 if re.search(r"(part|\b)0?1\b|-1\.", f, re.I) else 1, len(f)))
    info = api({"action": "query", "titles": files[0], "prop": "imageinfo", "iiprop": "url|size|extmetadata"})
    ii = next(iter(info["query"]["pages"].values())).get("imageinfo", [{}])[0]
    meta = ii.get("extmetadata", {})
    strip = lambda s: re.sub(r"<[^>]+>", "", s or "").strip()
    return {
        "file": files[0],
        "url": ii.get("url"),
        "page": ii.get("descriptionurl"),
        "artist": strip(meta.get("Artist", {}).get("value")) or "Wikimedia contributor",
        "license": strip(meta.get("LicenseShortName", {}).get("value")) or "CC BY-SA",
    }


def download_head(url: str, dest: Path, nbytes: int = 6_000_000) -> None:
    if dest.exists():
        return
    req = urllib.request.Request(url, headers={**UA, "Range": f"bytes=0-{nbytes - 1}"})
    dest.write_bytes(urllib.request.urlopen(req, timeout=120).read())


def decode(path: Path, rate: int) -> np.ndarray:
    """Decode (possibly truncated) audio to mono float32 at `rate`."""
    import av

    out = []
    try:
        with av.open(str(path)) as c:
            res = av.AudioResampler(format="flt", layout="mono", rate=rate)
            for frame in c.decode(audio=0):
                for f in res.resample(frame):
                    out.append(f.to_ndarray().reshape(-1))
    except Exception:
        pass  # truncated download: keep what decoded
    return np.concatenate(out) if out else np.zeros(0, np.float32)


def _prepare(title: str):
    """Resolve + download one recording (network only), backing off politely on HTTP 429."""
    import time
    import urllib.error

    for attempt in range(4):
        try:
            return _prepare_once(title)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                return title, None, str(e)
            time.sleep(10 * (attempt + 1))
    return title, None, "rate limited"


def _prepare_once(title: str):
    import time

    time.sleep(1.5)  # Wikimedia etiquette: one request at a time, with a pause
    rec = find_recording(title)
    if not rec or not rec["url"]:
        return title, None, "no recording"
    slug = re.sub(r"\W+", "_", title).strip("_")
    src = CACHE / f"{slug}{Path(urllib.parse.urlparse(rec['url']).path).suffix}"
    download_head(rec["url"], src)
    return title, {"rec": rec, "slug": slug, "src": src}, None


_model = None


def _transcribe(src: str):
    global _model
    from faster_whisper import WhisperModel

    if _model is None:
        _model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=4)
    cached = Path(src).with_suffix(".words360.json")
    if cached.exists():
        return src, json.loads(cached.read_text())
    pcm = decode(Path(src), 16_000)
    if len(pcm) < 16_000 * 60:
        return src, None
    segs, _ = _model.transcribe(pcm[: 16_000 * 240], language="en", word_timestamps=True, beam_size=1, condition_on_previous_text=False)
    words = [
        {"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)}
        for s in segs
        for w in (s.words or [])
    ]
    cached.write_text(json.dumps(words))
    return src, words


def fetch():
    from concurrent.futures import ThreadPoolExecutor
    from multiprocessing import Pool

    CACHE.mkdir(parents=True, exist_ok=True)
    HUMAN.mkdir(parents=True, exist_ok=True)
    candidates = json.loads(CANDIDATES.read_text()) if CANDIDATES.exists() else []
    done = {c["article"] for c in candidates}
    todo = [t for t in ARTICLES if t not in done]

    with ThreadPoolExecutor(1) as ex:
        prepared = {}
        for title, info, err in ex.map(_prepare, todo):
            if err:
                print(f"skip {title}: {err}", flush=True)
            else:
                prepared[str(info["src"])] = (title, info)

    with Pool(4) as pool:
        for src, words in pool.imap_unordered(_transcribe, list(prepared)):
            title, info = prepared[src]
            if not words:
                print(f"skip {title}: too short", flush=True)
                continue
            found = windows(words)
            for k, win in enumerate(found[:4]):
                candidates.append({"key": f"{info['slug']}#{k + 1}", "article": title, "source": info["rec"], "cache": Path(src).name, **win})
            print(f"{title}: {len(words)} words → {len(found)} windows", flush=True)
            CANDIDATES.write_text(json.dumps(candidates, ensure_ascii=False, indent=1))


def merge_fragments(words: list[dict]) -> list[dict]:
    """Whisper splits '10,000' into '10' + ',000' and 'shrimp-like' into 'shrimp' + '-like'; rejoin them."""
    out: list[dict] = []
    for w in words:
        joins = re.match(r"^[,.\-'’][\w]", w["w"]) and re.search(r"\w$", out[-1]["w"]) if out else False
        bare = out and not re.search(r"\w", w["w"])  # e.g. a lone "%" → "29%"
        if joins or bare:
            prev = out[-1]
            glue = "" if joins or w["w"] in "%" else " "
            out[-1] = {"w": prev["w"] + glue + w["w"], "s": prev["s"], "e": w["e"], "p": min(prev["p"], w["p"])}
        else:
            out.append(dict(w))
    return out


# Real HIW recordings run up to ~50 s; practice items match that so training transfers.
MIN_WORDS, MAX_WORDS = 85, 125
MIN_SECONDS, MAX_SECONDS = 32, 50


def windows(words: list[dict]) -> list[dict]:
    """Sentence-aligned exam-length excerpts. Low-confidence words are flagged for review."""
    words = merge_fragments(words)
    # Skip the spoken intro ("This is a recording of the Wikipedia article ...").
    start = 0
    for i, w in enumerate(words):
        if w["s"] > 40:
            break
        if INTRO_WORDS.search(w["w"]):
            start = i + 1
    sentence_starts = [i for i in range(start, len(words)) if i == 0 or words[i - 1]["w"].endswith((".", "?", "!"))]
    out, used_until = [], -1
    for i in sentence_starts:
        if i <= used_until:
            continue
        best = None
        for j in range(i + MIN_WORDS - 1, min(len(words), i + MAX_WORDS)):
            if not words[j]["w"].endswith((".", "?", "!")):
                continue
            dur = words[j]["e"] - words[i]["s"]
            if MIN_SECONDS <= dur <= MAX_SECONDS:
                best = j
        if best is None:
            continue
        span = words[i : best + 1]
        text = " ".join(w["w"] for w in span)
        gaps = [span[k + 1]["s"] - span[k]["e"] for k in range(len(span) - 1)]
        low = [k for k, w in enumerate(span) if w["p"] < 0.6]
        if len(low) > 4 or min(w["p"] for w in span) < 0.3 or BAD_TEXT.search(text) or INTRO_WORDS.search(text) or max(gaps) > 2.5:
            continue
        out.append({"start": span[0]["s"], "end": span[-1]["e"], "words": span, "text": text, "lowConfidence": low})
        used_until = best
    return out


# ── Stage 2 ──────────────────────────────────────────────────────────────

LEAD = re.compile(r"^[^\w]+")
TRAIL = re.compile(r"[^\w%]+$")


def split(word: str):
    lead = (LEAD.match(word) or [""])[0]
    rest = word[len(lead):]
    m = TRAIL.search(rest)
    trail = m.group(0) if m else ""
    core = rest[: len(rest) - len(trail)] if trail else rest
    return lead, core, trail


def to_mp3(pcm: np.ndarray, rate: int) -> bytes:
    import lameenc

    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    return enc.encode((np.clip(pcm, -1, 1) * 32767).astype(np.int16).tobytes()) + enc.flush()


def build():
    cands = {c["key"]: c for c in json.loads(EXAM_CANDIDATES.read_text())}
    items = json.loads(ITEMS.read_text())
    new_ids = {it["id"] for it in items}
    # Older items (short human excerpts, synthetic passages) stay resolvable for past attempts
    # but are archived: never offered for practice again.
    library = [{**e, "archived": True} for e in json.loads(LIBRARY.read_text()) if e["id"] not in new_ids]
    rate = 44_100
    pcm_cache: dict[str, np.ndarray] = {}
    for it in items:
        c = dict(cands[it["candidate"]])
        # Optional trim (inclusive word range, candidate indexes) and transcription fixes.
        a, b = it.get("range", [0, len(c["words"]) - 1])
        fixes = {int(k): v for k, v in it.get("fix", {}).items()}
        c["words"] = [
            {**w, "w": fixes.get(i, w["w"]), "orig": i} for i, w in enumerate(c["words"]) if a <= i <= b
        ]
        c["start"], c["end"] = c["words"][0]["s"], c["words"][-1]["e"]
        if c["cache"] not in pcm_cache:
            pcm_cache[c["cache"]] = decode(CACHE / c["cache"], rate)
        full = pcm_cache[c["cache"]]
        pad = 0.45
        t0 = max(0.0, c["start"] - pad)
        t1 = c["end"] + 0.6
        clip = full[int(t0 * rate) : int(t1 * rate)]
        peak = float(np.max(np.abs(clip))) or 1.0
        clip = clip * min(4.0, 0.89 / peak)  # normalise loudness across speakers
        fade = int(0.08 * rate)
        clip[:fade] *= np.linspace(0, 1, fade)
        clip[-fade:] *= np.linspace(1, 0, fade)
        (AUDIO_DIR / f"{it['id']}.mp3").write_bytes(to_mp3(clip, rate))

        swaps = {s["at"]: s for s in it.get("swaps", [])}
        tokens = []
        for w in c["words"]:
            lead, core, trail = split(w["w"])
            if not core and tokens:  # punctuation-only token (e.g. "%"): attach to the previous word
                tokens[-1]["trailing"] += lead + trail
                tokens[-1]["endMs"] = round((w["e"] - t0) * 1000)
                continue
            i = len(tokens)
            sw = swaps.get(w["orig"])
            if sw and sw.get("from") is not None and sw["from"] != core:
                raise SystemExit(f"{it['id']}: swap at {w['orig']} expects '{sw['from']}' but the word is '{core}'")
            if sw and sw["display"].lower() == core.lower():
                raise SystemExit(f"{it['id']}: swap at {i} does not change '{core}'")
            tokens.append(
                {
                    "index": i,
                    "displayText": sw["display"] if sw else core,
                    "spokenText": core,
                    "startMs": round((w["s"] - t0) * 1000),
                    "endMs": round((w["e"] - t0) * 1000),
                    "isIncorrect": bool(sw),
                    **({"trapCategory": sw["cat"]} if sw else {}),
                    "leading": lead,
                    "trailing": trail,
                }
            )
        words_n = len(tokens)
        wpm = words_n / (max(1.0, c["end"] - c["start"]) / 60)
        # 1 easier (slower/shorter) · 2 exam standard · 3 harder (fast or long)
        auto_level = 1 if wpm < 128 or (wpm < 138 and words_n < 95) else 3 if wpm >= 170 else 2
        src = dict(c["source"])
        artist = re.sub(r"^(Speaker:|The original uploader was)\s*", "", src["artist"]).split("\n")[0].strip()
        src["artist"] = re.sub(r"\s+at English Wikipedia.*$", "", artist) or "Wikimedia contributor"
        library.append(
            {
                "id": it["id"],
                "title": it.get("title") or c["article"],
                "topic": it.get("topic", "general"),
                "kind": it.get("kind", "realistic"),
                "difficulty": it.get("difficulty", auto_level),
                "source": "recorded",
                "audioUrl": f"/audio/{it['id']}.mp3",
                "durationMs": round((t1 - t0) * 1000),
                "accent": it.get("accent", "other"),
                "voice": f"{src['artist']} (Spoken Wikipedia)",
                "timing": "exact",
                "tokens": tokens,
                "tags": ["human-audio", "spoken-wikipedia"],
                "credit": {
                    "work": f"Spoken Wikipedia recording of “{c['article']}”",
                    "author": src["artist"],
                    "license": src["license"],
                    "url": src["page"],
                    "note": "Excerpt cut, loudness-normalised; on-screen words altered for HIW practice.",
                },
            }
        )
        # Whisper occasionally returns zero-length words; give them a short span before the next word.
        for k, tok in enumerate(tokens):
            if tok["endMs"] <= tok["startMs"]:
                nxt = tokens[k + 1]["startMs"] if k + 1 < len(tokens) else tok["startMs"] + 150
                tok["endMs"] = max(tok["startMs"] + 1, min(tok["startMs"] + 150, nxt))
        missing = set(swaps) - {w["orig"] for w in c["words"]}
        if missing:
            raise SystemExit(f"{it['id']}: swaps outside range: {sorted(missing)}")
        print(f"{it['id']:5} {c['article'][:34]:34} {len(tokens):3} words {len(swaps)} swaps {(t1 - t0):4.1f}s")
    LIBRARY.write_text(json.dumps(library, ensure_ascii=False, separators=(",", ":")))
    print(f"library: {len(library)} exercises")


def rewindow():
    """Recompute candidates from cached transcripts with the current window settings."""
    import time

    old = {c["article"]: c for c in json.loads(CANDIDATES.read_text())} if CANDIDATES.exists() else {}
    by_slug = {re.sub(r"\W+", "_", t).strip("_"): t for t in ARTICLES}
    sources = {}
    for f in sorted(CACHE.glob("*.words360.json")):
        slug = f.name.split(".")[0]
        cache = next((p.name for p in CACHE.glob(f"{slug}.*") if not p.name.endswith(".json")), None)
        meta_file = CACHE / f"{slug}.meta.json"
        meta = next((c for c in old.values() if c["cache"].split(".")[0] == slug), None)
        if meta:
            sources[slug] = (meta["article"], meta["source"], meta["cache"], f)
        elif meta_file.exists():
            m = json.loads(meta_file.read_text())
            sources[slug] = (m["article"], m["source"], cache, f)
        elif slug in by_slug and cache:
            time.sleep(1.5)  # polite: one metadata lookup at a time
            rec = find_recording(by_slug[slug])
            if rec:
                meta_file.write_text(json.dumps({"article": by_slug[slug], "source": rec}))
                sources[slug] = (by_slug[slug], rec, cache, f)
    out = []
    for slug, (article, source, cache, f) in sources.items():
        found = windows(json.loads(f.read_text()))
        for k, win in enumerate(found[:4]):
            out.append({"key": f"{slug}#{k + 1}", "article": article, "source": source, "cache": cache, **win})
    EXAM_CANDIDATES.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(out)} candidates from {len({c['article'] for c in out})} articles")


def verify():
    """Re-transcribe every active clip and compare with its tokens (catches bad cuts or misalignment)."""
    from difflib import SequenceMatcher

    lib = [e for e in json.loads(LIBRARY.read_text()) if "human-audio" in e.get("tags", []) and not e.get("archived")]
    norm = lambda w: re.sub(r"[^a-z0-9]", "", w.lower())
    cache_dir = CACHE / "verify"
    cache_dir.mkdir(parents=True, exist_ok=True)
    model = None
    report = []
    for e in lib:
        cached = cache_dir / f"{e['id']}.json"
        if cached.exists():
            heard_raw = json.loads(cached.read_text())
        else:
            if model is None:
                from faster_whisper import WhisperModel

                model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=16)
            pcm = decode(AUDIO_DIR / f"{e['id']}.mp3", 16_000)
            segs, _ = model.transcribe(pcm, language="en", word_timestamps=True, beam_size=2, condition_on_previous_text=False)
            heard_raw = [[w.word, round(w.start * 1000)] for s in segs for w in (s.words or [])]
            cached.write_text(json.dumps(heard_raw))
        heard = [(norm(w), t) for w, t in heard_raw if norm(w)]
        expected = [(norm(t["spokenText"]), t["startMs"]) for t in e["tokens"]]
        sm = SequenceMatcher(a=[w for w, _ in expected], b=[w for w, _ in heard], autojunk=False)
        offsets = []
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                offsets.append(abs(expected[blk.a + k][1] - heard[blk.b + k][1]))
        offsets.sort()
        med = offsets[len(offsets) // 2] if offsets else 9999
        p90 = offsets[int(len(offsets) * 0.9)] if offsets else 9999
        rate = len(offsets) / max(1, len(expected))
        # Words that differ between screen-spoken text and a fresh transcription (possible mis-transcription).
        diffs = [
            (" ".join(w for w, _ in expected[i1:i2]), " ".join(w for w, _ in heard[j1:j2]))
            for tag, i1, i2, j1, j2 in sm.get_opcodes()
            if tag != "equal"
        ]
        ok = rate >= 0.9 and med <= 250 and p90 <= 600
        report.append({"id": e["id"], "match": round(rate, 3), "medianOffsetMs": med, "p90OffsetMs": p90, "ok": ok, "diffs": diffs})
        print(f"{e['id']:5} match {rate:5.1%} offset median {med:4.0f} ms p90 {p90:4.0f} ms {'OK' if ok else 'CHECK'}", flush=True)
    (HUMAN / "verify.json").write_text(json.dumps(report, indent=1, ensure_ascii=False))
    bad = [r["id"] for r in report if not r["ok"]]
    print(f"{len(report) - len(bad)}/{len(report)} clips verified; needs attention: {bad}")

if __name__ == "__main__":
    {"fetch": fetch, "rewindow": rewindow, "build": build, "verify": verify}[sys.argv[1]]()
