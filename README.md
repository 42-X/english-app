# HIW Trainer

A focused trainer for **PTE Academic – Highlight Incorrect Words**. It measures what actually loses
points in HIW (pointer/audio synchronization, late clicks, over-clicking, specific trap types) and adapts
daily practice to it.

- Installable PWA (desktop + phone), works offline, no login required
- Optional account (email + password) syncs history between devices via Supabase
- Traditional Chinese UI and coaching by default, English available
- All analytics are deterministic and run on-device — no AI service receives any data

## What's in it

| Area | Details |
|---|---|
| Modes | Guided tracking (with "tap the word you just heard" checks) · Fading guidance · HIW practice · Micro-drills (per trap type) · Recovery (text blackouts) · Over-clicking test (10 passages, 0–2 hidden mismatches, verdict) · Exam (no pause, no hints) · Stress (1.10–1.30×) · Mistake review. Practice speeds 0.8–1.3× |
| Exam-like flow | Every item: status box above the passage ("Beginning in 7 seconds" → Playing → Completed, progress, volume), recording starts by itself, Next under the passage. All HIW items 85–125 words / 32–50 s |
| Tracking | Desktop: mouse hover. Phone: slide a finger over the text to track (sliding never selects); a quick tap selects. Sampled every 100 ms against the spoken word |
| Scoring | Hit +1, false click −1, miss 0, floored at 0 — labelled as a simulation, not Pearson scaling. Precision, recall, false-positive rate |
| Diagnostics | ±1/±2 sync, lag, sync-loss events and recovery time, click latency buckets, per-mismatch "likely cause" (lost sync vs trap type vs late response vs position slip), timeline, snippet replay at 0.8/1.0/1.1× |
| Adaptive | Rolling weakness detection → ~15 min daily quest (warm-up → weak drill → realistic → FIB-L → WFD → review/exam), then unlimited "keep going" bonus rounds and three one-tap recommendations on Home. Difficulty levels (easier / exam standard / advanced) by speaking rate and length: drops while sync or precision is weak, rises after 20 stable passages. Speed rises only after stable quality and drops back if quality falls |
| Reports | End-of-day summary (what improved vs the previous 7 days, what cost the most points, tomorrow's focus) · rolling written diagnosis on Progress |
| Fill in the Blanks (FIB-L) | Same real-voice passages with 5–9 blanks (content words, spaced, never names/hyphenated, uniform gap width); type while it plays; strict exam scoring (1 point per exactly spelled word, British/American both accepted, no negative marking); each blank diagnosed as correct / wrong ending / misspelled / different word / missing |
| Write From Dictation (WFD) | 129 single sentences (8–15 words, 4–6.5 s) cut from the passages; plays once in exam mode, replays counted in practice; 1 point per correct word, order-insensitive; per-word feedback |
| Mistake bank | Every missed or wrongly-clicked HIW word (any mode with clickable words) plus FIB-L/WFD spelling slips (Quick review: hear it → type it), spaced review at 10 min → 1 day → 3 days → 7 days. Quick review flashcards replay each word's audio clip; full-passage review uses *different* passages with the same confusion |
| My words | Tap any word on a results page → definition (Free Dictionary API, Wiktionary fallback — only the word is sent), pronunciation, Cambridge 英漢（繁）link, add to a personal list with learned count and milestones; synced across devices |
| Content | **28 human-voice items**: excerpts of Spoken Wikipedia recordings (real readers, varied accents, CC BY-SA), word-timed with Whisper, swaps written by hand · plus 34 original passages voiced with Kokoro TTS. Mismatch counts vary 0–7 per item. No Pearson material |
| Custom | Paste displayed + spoken text → mismatches auto-detected and categorised; browser voice (approximate) or uploaded audio (+ optional timestamps) |

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: Supabase keys for sync
npm run dev                  # http://localhost:5173
```

Checks:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Deploy (Cloudflare)

Live: **https://hiw-trainer.hiw-trainer.workers.dev**

The app is a static site served by Cloudflare's static-assets hosting (the successor to Pages);
[`wrangler.jsonc`](wrangler.jsonc) points it at `dist/` with single-page-app fallback. There is no server code.

```bash
npx wrangler login   # once
npm run deploy       # build + upload
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are baked in at build time from `.env.local`, so deploy
from a machine that has it. Any static host works (Vercel, Netlify) with an SPA fallback to `/index.html`.

## Cloud sync (Supabase)

Schema: [`supabase/migrations/`](supabase/migrations/). Each synced table stores the client document as
`jsonb`, keyed by `(user_id, id)`, with row-level security restricting every row to its owner.
Conflict resolution is last-write-wins on the client's `updatedAt`; `server_updated_at` is the pull cursor.
The first sign-in on a device uploads everything practised anonymously, so no history is lost.

New project setup:

```bash
supabase link --project-ref <ref>
supabase db push
supabase config push      # email confirmations off (see supabase/config.toml)
```

Login is email + password with confirmation disabled: Supabase's built-in mailer only delivers to project
members unless custom SMTP is configured, so magic links would not reach learners.

Free-tier note: Supabase pauses projects after ~7 days without any requests. Daily practice keeps it awake;
if it pauses, restore it from the dashboard — local data on each device is unaffected.

## Human-voice items (Spoken Wikipedia)

Real HIW recordings are people reading academic text, so the realistic and exam slots prefer these.

```bash
.venv-tts/bin/pip install faster-whisper
npm run human:fetch   # download recordings (politely, one at a time), transcribe, propose excerpts
npm run human:rewindow # exam-length excerpts from cached transcripts
npm run human:items   # compile items.txt → items.json
npm run human:build   # cut clips → library.json (older items are archived, not deleted)
npm run human:verify  # re-transcribe clips and check alignment
```

`fetch` downloads and transcribes recordings; `rewindow` writes `content/human/candidates-exam.json`:
sentence-aligned exam-length excerpts (85–125 words, 32–50 s) with word timings, the spoken intro skipped,
low-confidence words flagged. Swaps are written by hand in [`content/human/items.txt`](content/human/items.txt)
(`spoken>display category`, compiled by `scripts/items_from_text.py`, which rejects ambiguous or missing
words). `verify` re-transcribes every finished clip and checks its words and timings against the tokens. Excerpts with transcription errors that couldn't be verified against
the article text were not used, since a mis-transcribed word would show the learner an accidental mismatch.

Licence: the recordings are CC BY-SA; each exercise carries its reader, licence and source link, shown on its
results page. The cut clips are adaptations and remain CC BY-SA.

## Content pipeline (synthetic passages)

Passages live in [`content/passages.json`](content/passages.json). Mismatches are written inline as
`[displayed|spoken:trap-category]`:

```
Governments often measure [economical|economic:word-family] progress …
```

The audio says the *spoken* word; the transcript shows the *displayed* one. Generate audio + timings:

```bash
python3 -m venv .venv-tts
.venv-tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv-tts/bin/pip install "kokoro>=0.9.4" soundfile lameenc
npm run audio            # only new/changed passages
npm run audio -- --force # everything
```

Output: `public/audio/<id>.mp3` and `public/content/library.json`. Kinds: `guided` (no mismatches),
`easy` (1–2 obvious), `realistic` (4–6 mixed), `drill` (one trap type), `overclick` (0–2), `recovery`
(longer, anchor-rich). Voices: `af_heart`, `af_bella`, `am_michael` (US), `bf_emma`, `bm_george`,
`bm_fable` (UK).

## Architecture

```
src/domain/     pure, tested logic: scoring, sync, latency, diagnosis, SRS, adaptive engine, plan, text diff
src/audio/      AudioEngine: recorded/timestamped audio (exact) + browser speech fallback (approximate)
src/data/       Dexie (IndexedDB) storage, repositories, backup, Supabase sync
src/features/   player, results, home (daily plan), practice, mistakes, progress, create, settings
src/i18n/       zh-TW + en dictionaries
```

## What is approximate

- Custom exercises using the browser voice or uploaded audio without timestamps: word timing is estimated,
  so sync/latency numbers are flagged as approximate in the UI.
- Human-voice word timings come from Whisper's alignment; synthetic ones from Kokoro's. Both are machine-checked for order and plausible durations, not hand-verified by ear.
- Kokoro word timestamps come from the TTS model's own alignment. They are machine-checked for order and plausible durations, but not hand-verified by ear.
- The exam layout approximates the test's density; it is not pixel-verified against Pearson's UI.
- "Likely cause" labels are heuristics from timing + trap type, never definitive claims.
- Uploaded audio for custom exercises stays on the device (only the exercise text syncs).

## Phase 2 ideas

- Admin area to edit tokens/timestamps of library passages; publish/unpublish
- More accents (Australian, Indian) and real recorded audio
- Generated passages targeting the learner's exact recurring confusions
- Guided speed-experiment flow (equivalent passages at 1.0/1.05/1.10/1.15/1.20)
- Optional AI-written coaching behind a service boundary (off by default)
