# Compliance RAG Assistant

Matches a security/vulnerability finding to relevant OWASP / SOC 2 / ISO 27001
controls (web app, LLM app, SOC 2, and ISO 27001 Annex A — 4 frameworks) and
generates a remediation grounded in (and citing) those controls.

Stack: **Next.js (JavaScript) + Convex (DB + vector search) + Gemini API.**

**Live demo:** 

## Problem statement

Security teams generate findings (from scanners, pentests, manual review) but
translating a raw finding into "which compliance control does this violate,
and what's the fix" is manual and inconsistent. This tool automates that
lookup with a RAG pipeline, and — critically — verifies its own citations
against the indexed corpus so it doesn't silently invent control IDs.

## Scope (deliberately limited)

- **Input:** text paste-in only for v1. PDF upload is a possible next step
  (via `pdf-parse`, treating extracted text like the paste case). Images/OCR
  and structured JSON (Snyk-style) input are out of scope.
- **No second LLM-as-judge fact-check pass** — considered overkill for this
  project; verification is a plain corpus lookup instead (cheap, deterministic,
  explainable).

## Stack details

- **Next.js** (App Router, JavaScript) — single codebase, no separate backend
- **Convex** — database + native vector search (`vectorIndex` with
  `filterFields`, queried from a Convex action) + serverless functions
- **Gemini API** (free tier) — `gemini-embedding-001` (scaled down to 768
  dims) for embeddings, `gemini-3.5-flash-lite` for generation. Model names
  and endpoint paths change over time; check
  https://ai.google.dev/gemini-api/docs/models if a call 404s.

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

For a public/production deployment (not just local dev), see
[Deployment](#deployment).

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

## Retrieval: per-framework top-K, not one global top-k

`convex/analyze.js` runs a separate `ctx.vectorSearch` per framework (via
Convex's `filterFields` on the vector index), each capped at
`PER_FRAMEWORK_K` (15), then merges everything and filters by
`LOW_CONFIDENCE_THRESHOLD` (0.4) within that merged set. This guarantees
every framework gets a chance to surface a match, instead of one
framework's denser/more verbose controls crowding out the others in a
single global search — which matters here since one weakness (e.g. a
crypto failure) often legitimately maps to SOC2, ISO27001, and OWASP
simultaneously.

`PER_FRAMEWORK_K = 15` has no effect on OWASP_WEB / OWASP_LLM (10 controls
each — everything is always retrieved), and cuts SOC2 (61 controls) and
ISO27001 (93 controls) down to their 15 strongest candidates each. So each
finding sends at most 50 candidate controls to the generation step instead
of the full 174-control corpus.

That cap was chosen from `eval/rank-analysis.csv`: Recall@15-per-framework
sits around 90–93%, versus retrieving everything (effectively K=100+, i.e.
the whole corpus), which only buys another ~5–7 points of recall for 3–4x
more (mostly irrelevant) text sent to the LLM per finding.
`threshold-analysis.csv` shows why the cutoff is a fixed top-K rather than a
tighter similarity threshold: relevant and irrelevant controls' raw cosine
scores overlap heavily in the 0.55–0.65 range, so no single threshold value
cleanly separates them.

Nothing outside the per-framework top-K (or below the 0.4 threshold) is ever
surfaced — a finding with no confident match in any framework returns a
clean "no match" row (status **Low confidence**), never a forced guess or a
placeholder full of weak matches.

## Results UI

One row per finding: **S.No. / Finding / Matched Controls / Also Relevant /
Status / Remediation**.

The generation step (`convex/gemini.js`) asks the model for two lists:
`relevant_controls` (every retrieved control it judges genuinely relevant,
most to least relevant) and `cited_controls` (the subset it actually used
when writing the remediation — always a subset of `relevant_controls` by
prompt construction).

- **Matched Controls** shows `cited_controls`, each paired with its
  retrieval similarity score — this is what the remediation is grounded in.
- **Also Relevant** shows the rest of `relevant_controls` — the controls
  the model flagged as pertinent but didn't end up citing.

Both lists are checked against the corpus: any ID that doesn't exist gets a
red chip with a ⚠. Cited controls were kept as the primary "Matched
Controls" column rather than switching to the (larger) reranked list — see
"Cited vs. reranked" under Evaluation below for why.

Status is one of:
- **Verified** — controls matched, remediation generated, every returned
  citation (cited *and* reranked) checked out against the corpus
- **Unverified** — at least one returned control ID (cited or reranked)
  didn't exist in the corpus — a real hallucination worth investigating,
  distinct from Low confidence since retrieval succeeded here
- **Low confidence** — nothing cleared retrieval/threshold in any
  framework; no remediation was generated

A **Download as CSV** button exports the full results table (all findings
from the current batch) — opens fine in Excel or Google Sheets.

## Evaluation

`data/eval-set.json` holds 17 hand-labeled findings (`findingText` +
`expectedControlIds`). `npm run eval` runs each through the real pipeline
and reports, per finding and in aggregate:

- **Retrieval hit / context recall / context precision** — against the raw
  per-framework top-K candidate set, before the LLM touches anything.
- **Reranked recall / precision** — against `relevant_controls` (the
  model's full relevance-filtered list).
- **Cited recall / precision** — against `cited_controls` (what actually
  ends up in "Matched Controls").
- **Citation hit rate / citation validity rate** — whether at least one
  expected control was cited, and whether every returned ID actually
  exists in the corpus.
- **Reranked-only additions** — of the extra IDs `relevant_controls` adds
  on top of `cited_controls`, how many are actually correct.

**Cited vs. reranked:** across several eval runs, cited and reranked land
in the same range (roughly 55–65% precision / 68–80% recall for both), with
cited consistently the better tradeoff — reranked's extra recall comes with
markedly lower precision, and its reranked-only additions are correct only
about 15–25% of the time. That's why "Matched Controls" shows cited, not
reranked; "Also Relevant" is where the reranked-only extras live, flagged
and corpus-verified rather than hidden.

`scripts/analyze-thresholds.js` reads `eval-report.csv`'s raw retrieval
scores and reports precision/recall at a sweep of similarity thresholds
(`threshold-analysis.csv`) — this is what showed the threshold-alone
approach doesn't cleanly separate relevant from irrelevant controls, which
is why the pipeline leans on a fixed per-framework top-K instead (see
Retrieval above).

Numbers move a few points between runs even at `temperature: 0` — Gemini's
selection isn't fully deterministic — so treat single-run differences under
~5 points as noise and average a few runs before comparing configurations.

## Hallucination mitigation (implemented)

1. Prompt-level constraint: model is told to only cite from the retrieved
   controls and to say so explicitly if none apply.
2. Structured JSON output: `cited_controls` (and `relevant_controls`) are
   separate fields, not buried in prose — makes verification mechanical.
3. Post-generation verification: every ID the model returns — cited *and*
   reranked — is looked up against the `controls` table; failures are
   flagged (`invalidCitations` / `invalidReranked`), not hidden, and
   `verified` is false if either list contains a bad ID.
4. Low-confidence fallback: if nothing clears the per-framework retrieval
   cutoff and similarity threshold, the pipeline returns "no matching
   control found" instead of forcing an answer.
5. Show your work: control IDs and per-control confidence scores are always
   shown alongside the remediation, not just the final citation decision —
   this is what let us actually diagnose retrieval/precision issues instead
   of just guessing at a new threshold.
6. Retry-with-backoff on transient Gemini errors (429/503), both for
   embedding and generation calls.

## Next steps (not yet built)

- PDF upload for findings → `pdf-parse` → boundary-based chunking (one
  finding = one chunk), not fixed-size splitting
- Retry-on-transient-network-error wrapper in `scripts/eval.js` — an
  occasional `fetch failed` currently drops a finding from that eval run
  rather than retrying it
- A few `data/eval-set.json` labels are debatable on manual review (e.g.
  whether an auth-bypass finding maps to access-control or authentication
  controls) — worth a deliberate labeling pass, kept separate from any
  pipeline-tuning change so the two don't get conflated

## Deployment

Both pieces have a free tier and deploy from this same repo with no code
changes.

**1. Convex (backend + database) — production deployment**

```bash
npx convex deploy
```

This pushes your functions and schema to a **production** Convex
deployment (separate from the `dev` one `npx convex dev` uses locally) and
prints its URL. Then set the API key on that deployment too:

```bash
npx convex env set GEMINI_API_KEY your_actual_key_here --prod
```

Re-run ingestion against production once, from your machine, using the
production deployment's URL:

```bash
NEXT_PUBLIC_CONVEX_URL=<your-prod-.convex.cloud-url> npm run ingest
```

**2. Vercel (frontend) — free tier**

1. Push this repo to GitHub.
2. Import it at https://vercel.com/new (framework preset: Next.js — no
   build settings need to change).
3. Add one environment variable in the Vercel project settings:
   `NEXT_PUBLIC_CONVEX_URL` = the production Convex URL from step 1.
4. Deploy. Vercel gives you a `*.vercel.app` URL immediately.

After that, any `npx convex deploy` (backend) or `git push` to your default
branch (frontend, if auto-deploy is on) updates the live site — no
redeploy of the other half needed unless both changed.

## Security note before deploying

`package-lock.json` pins `next@14.2.5`, which npm flags as having a known
vulnerability. Before deploying publicly, bump to a patched 14.2.x release
(`npm install next@14.2.35` or later) and re-run `npm run build` to confirm
nothing broke