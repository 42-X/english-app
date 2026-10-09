"""
Authoring aid for content/human/items.txt: shows each excerpt with its current swaps rated
against the PTE word list, and suggests exam-style replacements for its words.

    .venv-tts/bin/python scripts/suggest_swaps.py w001 w002      # or no ids for all items

Real HIW swaps (as reported by test takers and prep material modelled on the exam) are whole-word
substitutions with common academic words: mostly look-alikes that keep the ending and change the
start (attention → retention, efficient → sufficient, contain → maintain), some that keep the start
(valid → vital, general → genuine), and some near-synonyms. Grammar-only changes (plural, tense)
are rare. Both the spoken and the displayed word should be PTE level (basic or pte), never jargon.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_words import common_prefix, common_suffix, same_family  # noqa: E402
from words import lexicon  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HUMAN = ROOT / "content" / "human"

# ECDICT exchange codes: p past, d past participle, i -ing, 3 third person, s plural, r comparative, t superlative
FORM_CODES = "pdi3srt"


def forms_of(lx, lemma: str) -> dict[str, str]:
    r = lx.rows.get(lemma)
    out = {}
    for part in ((r or {}).get("exchange") or "").split("/"):
        if len(part) > 2 and part[1] == ":" and part[0] in FORM_CODES:
            out[part[0]] = part[2:]
    return out


def form_code(lx, word: str, lemma: str) -> str | None:
    """'' for the base form, a code for an inflection, None if unknown."""
    if word == lemma:
        return ""
    for code, f in forms_of(lx, lemma).items():
        if f == word:
            return code
    return None


def inflect(lx, lemma: str, code: str) -> str | None:
    return lemma if code == "" else forms_of(lx, lemma).get(code)


def lookalikes(lx, pool: list[str], word: str) -> tuple[list[str], list[str]]:
    """(same ending, other near-sound) display candidates for a spoken word, inflected to match."""
    w = word.lower()
    lem = lx.lemma(w)
    code = form_code(lx, w, lem)
    if code is None:
        return [], []
    end, near = [], []
    for c in pool:
        if c == lem or abs(len(c) - len(lem)) > 3 or same_family(lem, c):
            continue
        suf, pre = common_suffix(lem, c), common_prefix(lem, c)
        surf = inflect(lx, c, code)
        if not surf or surf == w:
            continue
        if suf >= 3 and pre <= 2 and suf / max(len(lem), len(c)) >= 0.45:
            end.append((suf / max(len(lem), len(c)), surf))
        elif pre >= 2 and suf <= 2 and edit(lem, c) <= max(2, len(lem) // 3):
            near.append((-edit(lem, c), surf))
    end.sort(reverse=True)
    near.sort(reverse=True)
    return [s for _, s in end[:4]], [s for _, s in near[:3]]


def edit(a: str, b: str) -> int:
    dp = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, len(b) + 1):
            prev, dp[j] = dp[j], min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return dp[len(b)]


def main() -> None:
    lx = lexicon()
    pool = sorted(w for w in lx.study | lx.basic if w in lx.rows and len(w) >= 3)
    cands = {c["key"]: c for c in json.loads((HUMAN / "candidates-exam.json").read_text())}
    items = {i["id"]: i for i in json.loads((HUMAN / "items.json").read_text())}
    ids = sys.argv[1:] or list(items)
    for iid in ids:
        it = items[iid]
        c = cands[it["candidate"]]
        lo, hi = it.get("range", [0, len(c["words"]) - 1])
        fixes = {int(k): v for k, v in it.get("fix", {}).items()}
        words = [(i, fixes.get(i, w["w"])) for i, w in enumerate(c["words"]) if lo <= i <= hi]
        swaps = {s["at"]: s for s in it["swaps"]}
        print(f"\n=== {iid} {it['candidate']} {it['kind']} ({len(words)} words)")
        print(" ".join(f"[{w}>{swaps[i]['display']}]" if i in swaps else w for i, w in words))
        for s in it["swaps"]:
            print(f"  now: {s['from']}>{s['display']} {s['cat']}  ({lx.level(s['from'])}/{lx.level(s['display'])})")
        seen = set()
        for k, (i, raw) in enumerate(words):
            w = re.sub(r"^[^\w]+|[^\w]+$", "", raw)
            prev = words[k - 1][1] if k else "."
            if not re.fullmatch(r"[A-Za-z]+", w) or len(w) < 4 or (w[0].isupper() and not prev.endswith((".", "?", "!"))):
                continue
            lv = lx.level(w)
            if lv in ("rare", "ok") or (lv == "basic" and len(w) < 5) or w.lower() in seen:
                continue
            seen.add(w.lower())
            end, near = lookalikes(lx, pool, w)
            if end or near:
                dup = sum(1 for _, x in words if re.sub(r"^[^\w]+|[^\w]+$", "", x).lower() == w.lower())
                tag = f"{w}@?" if dup > 1 else w
                print(f"  {i:3} {tag:16} {lv:5} end: {', '.join(end) or '-'} | near: {', '.join(near) or '-'}")


if __name__ == "__main__":
    main()
