# Compliance RAG Assistant

Matches a security/vulnerability finding to relevant OWASP / SOC 2 / ISO 27001
controls (web app, LLM app, SOC 2, and ISO 27001 Annex A — 4 frameworks) and
generates a remediation grounded in (and citing) those controls.

Stack: **Next.js (JavaScript) + Convex (DB + vector search) + Gemini API.**

## Problem statement

Security teams generate findings (from scanners, pentests, manual review) but
translating a raw finding into "which compliance control does this violate,
and what's the fix" is manual and inconsistent. This tool automates that
lookup with a RAG pipeline, and — critically — verifies its own citations
against the indexed corpus so it doesn't silently invent control IDs.

## Scope (deliberately limited)

- **Input:** text paste-in only for v1. PDF upload is the planned next step
  (via `pdf-parse`, treating extracted text like the paste case). Images/OCR
  and structured JSON (Snyk-style) input are out of scope.
- **No second LLM-as-judge fact-check pass** — considered overkill for this
  project; verification is a plain corpus lookup instead (cheap, deterministic,
  explainable).

## Stack details

- **Next.js** (App Router, JavaScript) — single codebase, no separate backend
- **Convex** — database + native vector search (`vectorIndex` with
  `filterFields`, queried from a Convex action) + serverless functions
- **Gemini API** (free tier) — `gemini-embedding-001` (scaled to 768 dims)
  for embeddings, `gemini-3.6-flash` for generation. Model names change over
  time; check https://ai.google.dev/gemini-api/docs/models if a call 404s.

## Setup

```bash
npm install
cp .env.example .env.local   # add your GEMINI_API_KEY (from aistudio.google.com/apikey)
npx convex dev                # first run: log in, creates a Convex project,
                               # fills in CONVEX_DEPLOYMENT / NEXT_PUBLIC_CONVEX_URL
```

**Also set the same key on Convex's side** (Convex actions run on Convex's
own servers, not your machine, so `.env.local` alone doesn't reach them):

```bash
npx convex env set GEMINI_API_KEY your_actual_key_here
```

In a second terminal:

```bash
npm run dev
```

## Corpus: 4 frameworks, 174 controls

`data/controls.json` ships with 174 real, pre-chunked control entries across
four frameworks, one control/clause per entry:

| Framework | `framework` value | Controls |
|---|---|---|
| OWASP Top 10:2025 (Web) | `OWASP_WEB` | 10 |
| OWASP Top 10 for LLM Applications 2025 | `OWASP_LLM` | 10 |
| AICPA SOC 2 Trust Services Criteria | `SOC2` | 61 |
| ISO/IEC 27001:2022 Annex A | `ISO27001` | 93 |

OWASP entries are CC BY-SA 4.0 licensed. SOC 2 and ISO 27001 text is
proprietary/paywalled, so those entries are original paraphrased summaries
(not verbatim reproductions) — control IDs, section titles, and control
boundaries are kept accurate to the real source, only the wording is rewritten.

```bash
npm run ingest
```

This embeds all 174 entries (takes a couple of minutes — there's a small
pacing delay between calls to stay under free-tier rate limits) and
**replaces** the whole corpus each run — old rows are cleared first, so
editing `data/controls.json` and re-running `npm run ingest` is the normal
workflow, not something that needs manual cleanup.

Note: ingestion works via `scripts/ingest.js`, a plain Node script that runs
on **your machine** — it reads `data/controls.json` locally, then pushes the
entries to Convex's `corpus:ingestBatch` action over the network, since
Convex actions can't read a file straight off your disk.

## Findings input: one line = one finding

Paste any number of findings into the textarea, one per line. On "Analyze
All", the input is split on newlines, blank lines are dropped, and each
remaining line is treated as one independent finding — no boundary
detection or LLM segmentation needed, since the line break *is* the
boundary. A batch is capped at `MAX_FINDINGS_PER_BATCH` (50, in
`app/page.js`) — larger pastes are truncated to the first 50 with a visible
warning, rather than silently running an unbounded number of sequential API
calls. Split bigger batches into multiple runs.

Findings are processed **sequentially, not in parallel** — a free-tier
Gemini key has a shared rate limit across all calls, and running 50 findings
concurrently would blow through it immediately. Sequential processing also
means the results table renders progressively, one row per completed
finding, instead of all-or-nothing.

## Retrieval: per-framework, not one global top-k

`convex/analyze.js` runs a separate `ctx.vectorSearch` per framework (via
Convex's `filterFields` on the vector index), each capped at `PER_FRAMEWORK_K`
(2), then merges everything and filters by `LOW_CONFIDENCE_THRESHOLD` (0.4,
a placeholder — tune against a real eval set). This guarantees every
framework gets a chance to surface a match, instead of one framework's
denser/more verbose controls crowding out the others in a single global
search — which matters here since one weakness (e.g. a crypto failure) often
legitimately maps to SOC2, ISO27001, and OWASP simultaneously.

Nothing below the threshold is ever surfaced — a finding with no confident
match in any framework returns a clean "no match" row (status **Low
confidence**), never a forced guess or a placeholder full of weak matches.

## Results UI

One row per finding: **S.No. / Finding / Matched Controls / Confidence /
Status / Remediation**. Matched Controls and Confidence are paired lists —
each control ID lines up with its similarity score, so you can see directly
*why* something did or didn't get cited, instead of only seeing the final
citation decision.

Status is one of:
- **Verified** — controls matched, remediation generated, every citation
  checked out against the corpus
- **Unverified** — controls matched and a remediation was generated, but at
  least one cited control ID didn't exist in the corpus (a real hallucination
  worth investigating — this is a separate state from Low confidence because
  retrieval succeeded here; it's citation generation that went wrong)
- **Low confidence** — nothing cleared the similarity threshold in any
  framework; no remediation was generated

A **Download as CSV** button exports the full results table (all findings
from the current batch) — opens fine in Excel or Google Sheets.

## Evaluation

Three checks, as scoped — no automated LLM-graded framework, hand-labeling is
standard practice for a project this size:

1. **Retrieval precision@3** — hand-pick 15-20 findings, decide the correct
   control(s) for each yourself, check whether the top-3 retrieved results
   include it. Report as a %.
2. **Citation validity rate** — already computed automatically per-analysis
   (the `verified` / `invalidCitations` fields on each row in the `analyses`
   table). Aggregate across your test set: `% verified`.
3. **Manual quality spot-check** — read 10-15 generated remediations, rate
   good / partially useful / wrong.

Query `analyses` via the Convex dashboard or `npx convex run data:listAnalyses`
to pull results for the write-up.

## Hallucination mitigation (implemented)

1. Prompt-level constraint: model is told to only cite from the retrieved
   controls and to say so explicitly if none apply.
2. Structured JSON output: `cited_controls` is a separate field, not buried
   in prose — makes verification mechanical.
3. Post-generation verification: every cited ID is looked up against the
   `controls` table; failures are flagged (`invalidCitations`), not hidden.
4. Low-confidence fallback: if the top retrieval score is below
   `LOW_CONFIDENCE_THRESHOLD`, the pipeline returns "no matching control
   found" instead of forcing an answer.
5. Show your work: control IDs and per-control confidence scores are always
   shown alongside the remediation, not just the final citation decision —
   this is what let us actually diagnose and fix the "irrelevant OWASP_LLM
   controls showing up" issue instead of just guessing at a new threshold.
   Trade-off: the batch table shows IDs, not full control text (unlike an
   earlier single-finding version) — full text per control would be a
   reasonable follow-up (e.g. an expandable row) if needed for review.
6. Retry-with-backoff on transient Gemini errors (429/503), both for
   embedding and generation calls — `gemini-3.6-flash` has a known elevated
   503 rate on `generateContent` as of this writing.

## Next steps (not yet built)

- Eval harness: hand-label 15-20 findings with correct control mappings,
  measure precision@k and citation validity rate, then use that data to
  tune `LOW_CONFIDENCE_THRESHOLD` (currently 0.4, still a placeholder) —
  now practical to do since per-control confidence scores are visible
- Optional LangGraph grading/re-retrieval loop, built alongside the eval
  harness above so its impact can be measured (before/after precision@k),
  not just asserted
- PDF upload for findings → `pdf-parse` → boundary-based chunking (one
  finding = one chunk), not fixed-size splitting
- README paragraphs on why RAG / why Convex / why Gemini (architecture
  justification for the writeup)
