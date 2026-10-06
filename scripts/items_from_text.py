"""
Compile content/human/items.txt (hand-written swaps) into content/human/items.json.

One item per line:
    id | candidate key | kind | spoken>display category; spoken>display category; ...
Options after the swaps, separated by " | ":
    range=12-104        keep only these candidate word indexes (inclusive)
    fix=13:light-year   correct a mis-transcribed word (index:text), comma-separated
    title=...           override the title

`spoken` is the word as heard (matched case-insensitively, ignoring punctuation). If it occurs more
than once in the excerpt, write word@2 for the second occurrence; ambiguous matches are rejected.
Lines starting with # are comments. Kinds: realistic | overclick | easy.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "content" / "human" / "items.txt"
OUT = ROOT / "content" / "human" / "items.json"
CANDS = ROOT / "content" / "human" / "candidates-exam.json"
CATEGORIES = {
    "singular-plural", "verb-tense", "ed-ending", "ing-ending", "function-word", "preposition", "number", "date",
    "near-sound", "academic-vocab", "word-family", "noun-adjective", "verb-noun", "prefix", "suffix", "semantic",
    "connected-speech",
}


def core(w: str) -> str:
    return re.sub(r"^[^\w]+|[^\w%]+$", "", w)


def main() -> None:
    cands = {c["key"]: c for c in json.loads(CANDS.read_text())}
    items, errors = [], []
    for n, line in enumerate(SRC.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 4:
            errors.append(f"line {n}: expected 'id | key | kind | swaps'")
            continue
        iid, key, kind, swaps_txt, *opts = parts
        c = cands.get(key)
        if not c:
            errors.append(f"line {n} {iid}: unknown candidate {key}")
            continue
        item = {"id": iid, "candidate": key, "kind": kind, "swaps": []}
        for o in opts:
            k, _, v = o.partition("=")
            if k == "range":
                a, b = v.split("-")
                item["range"] = [int(a), int(b)]
            elif k == "fix":
                item["fix"] = {i: t for i, t in (x.split(":", 1) for x in re.split(r",(?=\d+:)", v))}
            elif k == "title":
                item["title"] = v
        lo, hi = item.get("range", [0, len(c["words"]) - 1])
        words = [(i, core(item.get("fix", {}).get(str(i), w["w"]))) for i, w in enumerate(c["words"]) if lo <= i <= hi]
        seen = set()
        for sw in filter(None, (s.strip() for s in swaps_txt.split(";"))):
            m = re.fullmatch(r"(.+?)(?:@(\d+))?>(\S+)\s+([a-z-]+)", sw)
            if not m:
                errors.append(f"line {n} {iid}: can't parse swap '{sw}'")
                continue
            spoken, occ, display, cat = m.group(1), m.group(2), m.group(3), m.group(4)
            if cat not in CATEGORIES:
                errors.append(f"line {n} {iid}: unknown category '{cat}'")
            hits = [i for i, w in words if w.lower() == spoken.lower()]
            if not hits:
                errors.append(f"line {n} {iid}: '{spoken}' not in excerpt")
                continue
            if len(hits) > 1 and not occ:
                errors.append(f"line {n} {iid}: '{spoken}' occurs {len(hits)}× — use {spoken}@N")
                continue
            idx = hits[int(occ) - 1] if occ else hits[0]
            if idx in seen:
                errors.append(f"line {n} {iid}: '{spoken}' swapped twice")
            seen.add(idx)
            frm = dict(words)[idx]
            if display.lower() == frm.lower():
                errors.append(f"line {n} {iid}: '{display}' doesn't change '{frm}'")
            item["swaps"].append({"at": idx, "from": frm, "display": display, "cat": cat})
        items.append(item)
    ids = [i["id"] for i in items]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        errors.append(f"duplicate ids: {sorted(dupes)}")
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    OUT.write_text("[\n" + ",\n".join("  " + json.dumps(i, ensure_ascii=False) for i in items) + "\n]\n")
    print(f"{len(items)} items, {sum(len(i['swaps']) for i in items)} swaps → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
