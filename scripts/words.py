"""
PTE word levels, shared by the content scripts.

Built from open word lists (downloaded once into .cache/words/):
  - ECDICT (MIT, github.com/skywind3000/ECDICT): Chinese meanings, phonetics, exam tags
    (IELTS / TOEFL / CET-6 / postgraduate), corpus frequency ranks and inflections
  - NAWL 1.2 (CC BY-SA 4.0, newgeneralservicelist.com): the New Academic Word List
  - NGSL 1.2 (CC BY-SA 4.0): the New General Service List with frequency ranks
  - content/words/pte-extra.txt: words seen in exam-style HIW pairs (one per line)

Levels of a word as it appears in a passage:
  basic  everyday English she already knows (NGSL top 1,200)
  pte    the PTE study list (academic + upper-intermediate words the exam uses)
  ok     other exam-level or common words — fine in a passage, not worth studying
  rare   jargon and specialist terms — never a blank, a swap or a study word
"""

import csv
import re
import urllib.request
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "words"
EXTRA = ROOT / "content" / "words" / "pte-extra.txt"

SOURCES = {
    "ecdict.csv": "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
    "NAWL_12_lemmatized_for_teaching.csv": "https://www.newgeneralservicelist.com/s/NAWL_12_lemmatized_for_teaching.csv",
    "NGSL_12_stats.csv": "https://www.newgeneralservicelist.com/s/NGSL_12_stats.csv",
    "NGSL_12_lemmatized_for_teaching.csv": "https://www.newgeneralservicelist.com/s/NGSL_12_lemmatized_for_teaching.csv",
}

EXAM_TAGS = {"ielts", "toefl", "cet6", "ky"}
BASIC_RANK = 1200


def source(name: str) -> Path:
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        print(f"downloading {name}…")
        req = urllib.request.Request(SOURCES[name], headers={"User-Agent": "Mozilla/5.0 (hiw-trainer content builder)"})
        path.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    return path


def rank_of(row: dict) -> int:
    """Corpus frequency rank (COCA or BNC, whichever is more frequent); 999999 when unknown."""
    xs = [int(x) for x in (row.get("frq"), row.get("bnc")) if x and int(x) > 0]
    return min(xs) if xs else 999_999


class Lexicon:
    def __init__(self) -> None:
        csv.field_size_limit(10**9)
        self.rows: dict[str, dict] = {}
        with open(source("ecdict.csv"), encoding="utf-8") as f:
            for r in csv.DictReader(f):
                w = r["word"]
                if w.isalpha() and w.islower():
                    self.rows[w] = r
        self.lemmas: dict[str, str] = {}
        for w, r in self.rows.items():
            for part in (r["exchange"] or "").split("/"):
                if part.startswith("0:") and part[2:] in self.rows and part[2:] != w:
                    self.lemmas[w] = part[2:]
        self.ngsl: dict[str, int] = {}
        with open(source("NGSL_12_stats.csv"), encoding="utf-8-sig") as f:
            for i, row in enumerate(csv.reader(f)):
                if i and row and row[0]:
                    self.ngsl[row[0].lower()] = int(row[1])
        self.nawl: set[str] = set()
        # NGSL's forms override ECDICT's (does → do, not doe); NAWL only fills gaps.
        for name, target in (("NGSL_12_lemmatized_for_teaching.csv", None), ("NAWL_12_lemmatized_for_teaching.csv", self.nawl)):
            with open(source(name), encoding="latin-1") as f:
                for row in csv.reader(f):
                    if not row or not row[0]:
                        continue
                    head = row[0].strip().lower()
                    if target is not None:
                        target.add(head)
                    for form in row[1:]:
                        form = form.strip().lower()
                        if form and form != head:
                            if target is None:
                                self.lemmas[form] = head
                            else:
                                self.lemmas.setdefault(form, head)
        self.extra = {w.strip().lower() for w in EXTRA.read_text().split() if w.strip()} if EXTRA.exists() else set()
        self.basic = {w for w, k in self.ngsl.items() if k <= BASIC_RANK}
        self.study = self._study_list()

    def tagged(self, w: str) -> bool:
        r = self.rows.get(w)
        return bool(r and set(r["tag"].split()) & EXAM_TAGS)

    def rank(self, w: str) -> int:
        r = self.rows.get(w)
        return rank_of(r) if r else 999_999

    def lemma(self, w: str) -> str:
        """Dictionary form: ECDICT / NGSL inflections first, then simple suffix rules."""
        w = w.lower()
        if w in self.lemmas:
            return self.lemmas[w]
        if w in self.ngsl or w in self.nawl:
            return w
        # Plurals and verb forms ECDICT lists as their own entries (millions, thousands).
        for suf, rep in (("ies", "y"), ("ied", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("ing", ""), ("ing", "e")):
            if w.endswith(suf) and len(w) - len(suf) >= 3:
                base = w[: len(w) - len(suf)] + rep
                if base in self.ngsl or base in self.nawl or (base in self.rows and (w not in self.rows or self.rank(base) < self.rank(w))):
                    return self.lemmas.get(base, base)
        return w

    def _study_list(self) -> set[str]:
        # Upper NGSL words only when an exam list has them too (keeps out orange, chess, kitchen…).
        general = {w for w, k in self.ngsl.items() if k > BASIC_RANK and self.tagged(w)}
        core = set(self.nawl) | general | {self.lemma(w) for w in self.extra}
        broad = {
            w
            for w, r in self.rows.items()
            if w not in self.lemmas
            and len(w) >= 4
            and "ielts" in r["tag"]
            and ("toefl" in r["tag"] or "cet6" in r["tag"])
            and 2500 <= rank_of(r) <= 9000
        }
        return {w for w in core | broad if w not in self.basic and len(w) >= 3 and w in self.rows and self.rows[w]["translation"]}

    def level(self, word: str) -> str:
        w = word.lower()
        if not re.fullmatch(r"[a-z]+(?:'[a-z]+)?", w):
            return "ok"
        w = w.split("'")[0]
        lem = self.lemma(w)
        forms = {w, lem}
        # Derived adverbs and comparatives take the level of their base (significantly → significant).
        for suf, rep in (("ally", "al"), ("ily", "y"), ("ly", ""), ("ly", "le"), ("er", ""), ("est", "")):
            if w.endswith(suf) and len(w) - len(suf) >= 3:
                forms.add(self.lemma(w[: len(w) - len(suf)] + rep))
        if forms & self.basic:
            return "basic"
        if forms & self.study:
            return "pte"
        if any((self.tagged(f) and self.rank(f) <= 15000) or self.rank(f) <= 8000 or f in self.ngsl for f in forms):
            return "ok"
        return "rare"


@lru_cache(maxsize=1)
def lexicon() -> Lexicon:
    return Lexicon()
