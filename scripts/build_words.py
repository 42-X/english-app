"""
Build public/content/words.json: the PTE study list for the word games and the Chinese gloss
used by the word sheet.

    .venv-tts/bin/python scripts/build_words.py          # after the library is built

Per study word: part of speech, Traditional Chinese meaning (ECDICT, converted with OpenCC
s2twp), a short English definition, phonetic, its pack (50 words, most useful first), look-alike
words (same ending or same start — the way HIW swaps words) and, when a passage in the library
says it, where (exercise id + token index) so the game can play it in a real sentence.

`gloss` maps every other non-basic word in the library to its meaning ("=lemma" for an inflected
form of a study word), so a word looked up anywhere has a Chinese meaning even offline.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from words import lexicon  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = ROOT / "public" / "content" / "library.json"
OUT = ROOT / "public" / "content" / "words.json"
PACK = 50

POS = {"n": "n.", "v": "v.", "vt": "v.", "vi": "v.", "a": "adj.", "adj": "adj.", "s": "adj.", "adv": "adv.", "r": "adv.", "prep": "prep.", "conj": "conj.", "pron": "pron.", "num": "num."}
# Derivational endings: words that differ only by one of these are the same family, not look-alikes.
FAMILY = re.compile(r"(s|es|ed|d|ing|ly|er|ers|est|ness|ment|ments|ity|ities|ion|ions|ation|al|ally|ive|ively|able|ably|ful|ism|ist|ize|ise|ization)$")


def converter():
    from opencc import OpenCC

    return OpenCC("s2twp")


def pos_split(text: str) -> list[tuple[str, str]]:
    """'n. 效率, 功效\\na. 有效的' → [('n.', '效率, 功效'), ('adj.', '有效的')]; domain-tagged lines dropped."""
    out = []
    for line in text.replace("\\n", "\n").split("\n"):
        line = line.strip()
        if not line or line.startswith("["):
            continue
        m = re.match(r"^([a-z]+)\.\s*(.*)$", line)
        if m and m.group(1) in POS:
            out.append((POS[m.group(1)], m.group(2)))
        elif not m:
            out.append(("", line))
    return out


def main_pos(row: dict) -> str:
    """Most frequent part of speech from ECDICT's 'n:2/a:98' field, when it has one."""
    shares = [(int(x.split(":")[1] or 0), x.split(":")[0]) for x in (row.get("pos") or "").split("/") if ":" in x]
    shares = [(k, POS[p]) for k, p in shares if p in POS and k > 0]
    if shares:
        return max(shares)[1]
    # No frequency data: guess from the ending (essential → adj., initiate → v.).
    w = row["word"]
    if re.search(r"(al|ive|ous|ful|able|ible|ic|ent|ant|ary|less)$", w):
        return "adj."
    if re.search(r"(ate|ize|ise|ify|en)$", w):
        return "v."
    return ""


def short_zh(text: str, cc, first: str = "") -> tuple[str, str]:
    """Two parts of speech (the main one first), three senses each, in Traditional Chinese; plus the main POS."""
    parts = pos_split(text)
    parts.sort(key=lambda p: p[0] != first)
    lines, seen = [], set()
    for pos, senses in parts:
        if pos in seen or len(lines) == 2:
            continue
        xs = [s.strip() for s in re.split(r"[,，;；]", re.sub(r"\([^)]*\)|（[^）]*）", "", senses)) if s.strip()]
        if xs:
            seen.add(pos)
            lines.append(f"{pos} {'；'.join(dict.fromkeys(xs[:3]))}".strip())
    return cc.convert(" ／ ".join(lines)), (parts[0][0] if parts else "")


WN_POS = {"n": "n.", "v": "v.", "a": "adj.", "s": "adj.", "r": "adv."}


def short_en(text: str, pos: str) -> str:
    """First WordNet definition for the main part of speech (any, if none matches)."""
    lines = []
    for line in text.replace("\\n", "\n").split("\n"):
        m = re.match(r"^([a-z]+)\.?\s+(.*)$", line.strip())
        if m:
            lines.append((WN_POS.get(m.group(1), ""), m.group(2)))
    lines.sort(key=lambda x: x[0] != pos)
    for _, line in lines:
        return line if len(line) <= 110 else line[:107].rsplit(" ", 1)[0] + "…"
    return ""


def ipa(p: str) -> str:
    return p.replace("ә", "ə").replace("ɒ:", "ɔː").replace(":", "ː").replace("'", "ˈ").replace(",", "ˌ").replace(".", "ˌ") if p else ""


def common_suffix(a: str, b: str) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def common_prefix(a: str, b: str) -> int:
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def same_family(a: str, b: str) -> bool:
    p = common_prefix(a, b)
    if p < 4:
        return False
    ra, rb = a[p:], b[p:]
    return all(not r or FAMILY.fullmatch(r) or len(r) <= 2 for r in (ra, rb))


def alike(word: str, pool: dict[str, list[str]], by_end: dict[str, list[str]], by_start: dict[str, list[str]]) -> list[str]:
    """Look-alikes in HIW style: same ending, different start (attention/retention), or same start (valid/vital)."""
    cands = set(by_end.get(word[-3:], [])) | set(by_start.get(word[:3], []))
    scored = []
    for c in cands:
        if c == word or abs(len(c) - len(word)) > 3 or same_family(word, c) or c.startswith(word) and len(c) - len(word) <= 2:
            continue
        suf, pre = common_suffix(word, c), common_prefix(word, c)
        if suf + pre >= max(len(word), len(c)):  # one is contained in the other (prove/improve) — still a classic pair
            score = 0.8
        elif suf >= 3 and pre <= 2:
            score = suf / max(len(word), len(c))
        elif pre >= 3 and suf <= 2:
            score = 0.85 * pre / max(len(word), len(c))
        else:
            continue
        if score >= 0.45:
            scored.append((score + (0.05 if pool[c] == pool[word] else 0), c))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [c for _, c in scored[:6]]


def main() -> None:
    lx = lexicon()
    cc = converter()
    library = [e for e in json.loads(LIBRARY.read_text()) if not e.get("archived") and "human-audio" in e.get("tags", [])]

    # Where each lemma is spoken in the library: unchanged on screen, in the plainest sentence
    # (fewest specialist terms), so the example teaches the word rather than more jargon.
    heard: dict[str, tuple[int, str, int]] = {}
    in_library: set[str] = set()
    surfaces: set[str] = set()
    for e in library:
        toks = e["tokens"]
        starts = [0] + [k + 1 for k, t in enumerate(toks) if re.search(r"[.!?]", t["trailing"])]
        sentence_of = {}
        for a, b in zip(starts, starts[1:] + [len(toks)]):
            for k in range(a, b):
                sentence_of[k] = (a, b)
        for t in toks:
            w = t["spokenText"].lower()
            if not re.fullmatch(r"[a-z]+", w):
                continue
            surfaces.add(w)
            lem = lx.lemma(w)
            in_library.add(lem)
            if t["isIncorrect"] or t["index"] <= 2:
                continue
            a, b = sentence_of[t["index"]]
            span = toks[a:b]
            jargon = sum(x.get("vocab") == "rare" for x in span)
            if jargon >= 2:
                continue
            uncommon = sum(x.get("vocab") == "ok" or (x["spokenText"][:1].isupper() and x is not span[0]) for x in span)
            cost = jargon * 10 + uncommon * 3 + abs(len(span) - 14)
            if lem not in heard or cost < heard[lem][0]:
                heard[lem] = (cost, e["id"], t["index"])

    entries = []
    for w in lx.study:
        r = lx.rows[w]
        zh, pos = short_zh(r["translation"], cc, main_pos(r))
        if not zh:
            continue
        academic = w in lx.nawl or w in lx.extra
        # Most useful first: frequent words, academic ones and words she meets in the passages sooner;
        # everyday Oxford-3000 words (likely known already) later.
        score = lx.rank(w) * (0.45 if academic else 1) * (0.7 if w in in_library else 1) * (1.6 if r["oxford"] == "1" and not academic else 1)
        entries.append({"w": w, "p": pos, "zh": zh, "en": short_en(r["definition"], pos), "ipa": ipa(r["phonetic"]), "_s": score})
    entries.sort(key=lambda x: (x["_s"], x["w"]))

    # Look-alikes can be any study or everyday word (attention → retention).
    pool = {w: short_zh(lx.rows[w]["translation"], cc, main_pos(lx.rows[w]))[1] for w in lx.basic if w in lx.rows and len(w) >= 3}
    pool.update({x["w"]: x["p"] for x in entries})
    by_end: dict[str, list[str]] = defaultdict(list)
    by_start: dict[str, list[str]] = defaultdict(list)
    for w in pool:
        by_end[w[-3:]].append(w)
        by_start[w[:3]].append(w)
    for k, x in enumerate(entries):
        x["pack"] = k // PACK + 1
        al = alike(x["w"], pool, by_end, by_start)
        if al:
            x["alike"] = al
        if x["w"] in heard:
            x["ex"] = list(heard[x["w"]][1:])
        del x["_s"]

    study = {x["w"] for x in entries}
    gloss: dict[str, str] = {}
    for w in sorted(surfaces):
        lem = lx.lemma(w)
        if w in study or lx.level(w) == "basic":
            continue
        if lem in study:
            gloss[w] = f"={lem}"
        elif w in lx.rows and lx.rows[w]["translation"]:
            gloss[w] = short_zh(lx.rows[w]["translation"], cc, main_pos(lx.rows[w]))[0]
        elif lem in lx.rows and lx.rows[lem]["translation"]:
            gloss[w] = short_zh(lx.rows[lem]["translation"], cc, main_pos(lx.rows[lem]))[0]
        if not gloss.get(w):
            gloss.pop(w, None)

    OUT.write_text(json.dumps({"v": 1, "words": entries, "gloss": gloss}, ensure_ascii=False, separators=(",", ":")))
    packs = entries[-1]["pack"] if entries else 0
    print(f"{len(entries)} study words in {packs} packs, {sum('ex' in x for x in entries)} heard in passages, "
          f"{sum('alike' in x for x in entries)} with look-alikes, {len(gloss)} gloss entries → {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
