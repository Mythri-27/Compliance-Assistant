// Runs a hand-labeled test set through the real pipeline (over the network,
// same as scripts/ingest.js) and reports retrieval/citation metrics against
// your expected control IDs. Usage: npm run eval
//
// Input shape (data/eval-set.json — copy data/eval-set.example.json and fill
// in real findings): [{ findingText, expectedControlIds: [...] }, ...]
//
// Metrics reported (see README for exact definitions):
// - Retrieval hit rate: did the retrieval candidate set (pre-generation)
//   contain at least one expected control? A coarse yes/no per finding —
//   kept alongside Context Recall below since it's easier to eyeball live.
// - Context recall: of ALL the controls you expected for a finding, what
//   fraction actually got retrieved? Unlike hit rate, a finding with 3
//   expected controls where only 1 was retrieved scores 33%, not a clean
//   "hit" — this is what catches partial misses that hit rate hides.
// - Context precision: of the controls that were actually retrieved
//   (post-threshold, pre-generation) for a finding, what fraction were in
//   your expected set? Low precision = the retriever is pulling in noise
//   alongside the real matches (directly answers whether uncapping
//   PER_FRAMEWORK_K introduced noise). Undefined (excluded from the
//   average) for findings where nothing was retrieved at all — 0 candidates
//   can't be "imprecise," that's a recall problem, not a precision one.
// - Citation hit rate: did the model actually CITE at least one expected
//   control in its remediation?
// - Citation validity rate: across the whole set, what fraction of analyses
//   had zero hallucinated (invalid) citations?

require("dotenv").config({ path: ".env.local" });
const fs = require("fs");
const path = require("path");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

// gemini-3.6-flash's free tier allows only 5 generateContent calls per
// minute — the retry-with-backoff inside convex/gemini.js (max ~7s total)
// isn't nearly enough to ride that out. Space calls out instead of hoping
// retries absorb a hard per-minute quota. 13s keeps us under 5/min with
// margin; a 19-finding run takes ~4-5 minutes as a result — fine for a
// script you run occasionally, not on every keystroke.
const PACING_MS = 13000;

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is not set in .env.local — make sure `npx convex dev` has run at least once."
    );
  }

  const filePath = path.join(__dirname, "..", "data", "eval-set.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${filePath} not found. Run: cp data/eval-set.example.json data/eval-set.json (then fill it with your real 15-20 labeled findings).`
    );
  }

  const evalSet = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`Loaded ${evalSet.length} labeled findings. Running each through the pipeline...\n`);

  const client = new ConvexHttpClient(url);
  const rows = [];

  for (let i = 0; i < evalSet.length; i++) {
    const { findingText, expectedControlIds } = evalSet[i];

    try {
      const result = await client.action(anyApi.analyze.analyzeFinding, { findingText });

      const retrievedSet = new Set(result.retrievedControlIds);
      const citedSet = new Set(result.citedControls);

      const retrievalHit = expectedControlIds.some((id) => retrievedSet.has(id));
      const citationHit = expectedControlIds.some((id) => citedSet.has(id));
      const missedExpected = expectedControlIds.filter((id) => !retrievedSet.has(id));

      // Context precision: of what was actually retrieved, how much was
      // correct? null (not 0) when nothing was retrieved — an empty set has
      // no precision to speak of, that's purely a recall failure.
      const expectedSet = new Set(expectedControlIds);
      const truePositives = result.retrievedControlIds.filter((id) => expectedSet.has(id)).length;
      const contextPrecision =
        result.retrievedControlIds.length > 0 ? truePositives / result.retrievedControlIds.length : null;

      // Context recall: of everything you expected, how much did retrieval
      // actually find? null only if a finding was mislabeled with zero
      // expected controls — otherwise always a real number, since the
      // denominator (expectedControlIds) is never empty for a normal case.
      const contextRecall =
        expectedControlIds.length > 0 ? truePositives / expectedControlIds.length : null;

      const expectedScores = expectedControlIds
        .map((id) => result.controlScores.find((cs) => cs.controlId === id)?.score)
        .filter((s) => s !== undefined);

      rows.push({
        sNo: i + 1,
        findingText,
        expectedControlIds: expectedControlIds.join("; "),
        citedControls: result.citedControls.join("; "),
        retrievalHit,
        contextPrecision,
        contextRecall,
        citationHit,
        missedExpected: missedExpected.join("; "),
        invalidCitations: result.invalidCitations.join("; "),
        verified: result.verified,
        lowConfidence: result.lowConfidence,
        expectedScores: expectedScores.map((s) => s.toFixed(2)).join("; "),
        error: null,
      });

      const precisionStr = contextPrecision === null ? "n/a" : `${(contextPrecision * 100).toFixed(0)}%`;
      const recallStr = contextRecall === null ? "n/a" : `${(contextRecall * 100).toFixed(0)}%`;
      console.log(
        `${i + 1}/${evalSet.length} — retrieval ${retrievalHit ? "✅" : "❌"}  recall ${recallStr}  precision ${precisionStr}  citation ${citationHit ? "✅" : "❌"}  ${result.verified ? "verified" : "⚠️ invalid citation"}`
      );
    } catch (err) {
      // One finding failing (rate limit, transient network blip) shouldn't
      // lose the results already collected for every finding before it —
      // record it as an error row and keep going.
      rows.push({
        sNo: i + 1,
        findingText,
        expectedControlIds: expectedControlIds.join("; "),
        citedControls: "",
        retrievalHit: false,
        contextPrecision: null,
        contextRecall: null,
        citationHit: false,
        missedExpected: "",
        invalidCitations: "",
        verified: false,
        lowConfidence: false,
        expectedScores: "",
        error: err.message ?? String(err),
      });
      console.log(`${i + 1}/${evalSet.length} — ❌ ERROR: ${err.message ?? err}`);
    }

    if (i < evalSet.length - 1) await sleep(PACING_MS);
  }

  // Aggregate metrics — computed over successful rows only. Errors are a
  // separate, explicit line, not silently folded into "low confidence" or
  // any other rate (an API hiccup isn't the same failure as a bad match).
  const n = rows.length;
  const errorRows = rows.filter((r) => r.error !== null);
  const okRows = rows.filter((r) => r.error === null);
  const nOk = okRows.length;

  const retrievalHitRate = nOk > 0 ? (okRows.filter((r) => r.retrievalHit).length / nOk) * 100 : null;
  const citationHitRate = nOk > 0 ? (okRows.filter((r) => r.citationHit).length / nOk) * 100 : null;
  const citationValidityRate = nOk > 0 ? (okRows.filter((r) => r.verified).length / nOk) * 100 : null;
  const lowConfidenceRate = nOk > 0 ? (okRows.filter((r) => r.lowConfidence).length / nOk) * 100 : null;

  const precisionRows = okRows.filter((r) => r.contextPrecision !== null);
  const avgContextPrecision =
    precisionRows.length > 0
      ? (precisionRows.reduce((sum, r) => sum + r.contextPrecision, 0) / precisionRows.length) * 100
      : null;

  const recallRows = okRows.filter((r) => r.contextRecall !== null);
  const avgContextRecall =
    recallRows.length > 0
      ? (recallRows.reduce((sum, r) => sum + r.contextRecall, 0) / recallRows.length) * 100
      : null;

  console.log("\n--- Summary ---");
  if (errorRows.length > 0) {
    console.log(`Errored:                 ${errorRows.length}/${n} (excluded from the rates below)`);
  }
  console.log(
    retrievalHitRate === null
      ? "Retrieval hit rate:     n/a (no successful runs)"
      : `Retrieval hit rate:      ${retrievalHitRate.toFixed(1)}% (${okRows.filter((r) => r.retrievalHit).length}/${nOk})`
  );
  console.log(
    avgContextRecall === null
      ? "Context recall:         n/a"
      : `Context recall:          ${avgContextRecall.toFixed(1)}% avg (over ${recallRows.length}/${nOk})`
  );
  console.log(
    avgContextPrecision === null
      ? "Context precision:      n/a (nothing was ever retrieved)"
      : `Context precision:      ${avgContextPrecision.toFixed(1)}% avg (over ${precisionRows.length}/${nOk} findings that retrieved anything)`
  );
  console.log(
    citationHitRate === null
      ? "Citation hit rate:      n/a"
      : `Citation hit rate:       ${citationHitRate.toFixed(1)}% (${okRows.filter((r) => r.citationHit).length}/${nOk})`
  );
  console.log(
    citationValidityRate === null
      ? "Citation validity rate: n/a"
      : `Citation validity rate:  ${citationValidityRate.toFixed(1)}% (${okRows.filter((r) => r.verified).length}/${nOk})`
  );
  console.log(
    lowConfidenceRate === null
      ? "Low-confidence rate:    n/a"
      : `Low-confidence rate:     ${lowConfidenceRate.toFixed(1)}% (${okRows.filter((r) => r.lowConfidence).length}/${nOk})`
  );

  // CSV report for the writeup
  const csvRows = [
    ["S.No.", "Finding", "Expected Controls", "Cited Controls", "Retrieval Hit", "Context Recall", "Context Precision", "Citation Hit", "Missed Expected", "Invalid Citations", "Verified", "Low Confidence", "Expected Control Scores", "Error"],
    ...rows.map((r) => [
      r.sNo, r.findingText, r.expectedControlIds, r.citedControls, r.retrievalHit,
      r.contextRecall === null ? "n/a" : (r.contextRecall * 100).toFixed(0) + "%",
      r.contextPrecision === null ? "n/a" : (r.contextPrecision * 100).toFixed(0) + "%",
      r.citationHit, r.missedExpected, r.invalidCitations, r.verified, r.lowConfidence, r.expectedScores,
      r.error ?? "",
    ]),
  ];
  const outPath = path.join(__dirname, "..", "eval-report.csv");
  fs.writeFileSync(outPath, csvRows.map((row) => row.map(csvEscape).join(",")).join("\n"));
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => {
  console.error("Eval run failed:", err.message);
  process.exit(1);
});