require("dotenv").config({ path: ".env.local" });
const fs = require("fs");
const path = require("path");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const PACING_MS = 13000;
const csvEscape = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calcRate = (subset, total) => (total > 0 ? (subset.length / total) * 100 : null);
const fmtPct = (val) => (val === null ? "n/a" : `${val.toFixed(0)}%`);

async function main() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not set in .env.local — run `npx convex dev` first.");

  const filePath = path.join(__dirname, "..", "data", "eval-set.json");
  if (!fs.existsSync(filePath)) throw new Error(`${filePath} not found. Run: cp data/eval-set.example.json data/eval-set.json`);

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
      const expectedSet = new Set(expectedControlIds);

      const truePositives = result.retrievedControlIds.filter((id) => expectedSet.has(id)).length;
      const contextPrecision = result.retrievedControlIds.length ? truePositives / result.retrievedControlIds.length : null;
      const contextRecall = expectedControlIds.length ? truePositives / expectedControlIds.length : null;
      const retrievalHit = expectedControlIds.some((id) => retrievedSet.has(id));
      const citationHit = expectedControlIds.some((id) => citedSet.has(id));
      const missedExpected = expectedControlIds.filter((id) => !retrievedSet.has(id));

      const retrievedControlScores = (result.controlScores ?? []).map((cs) => ({
        controlId: cs.controlId,
        score: Number(cs.score.toFixed(4)),
        relevant: expectedSet.has(cs.controlId),
      }));

      const scores = retrievedControlScores.map((cs) => cs.score);
      const scoreMin = scores.length ? Math.min(...scores) : null;
      const scoreMax = scores.length ? Math.max(...scores) : null;
      const scoreAvg = scores.length ? scores.reduce((sum, s) => sum + s, 0) / scores.length : null;

      const row = {
        sNo: i + 1, findingText,
        expectedControlIds: expectedControlIds.join("; "),
        citedControls: result.citedControls.join("; "),
        retrievalHit, contextPrecision, contextRecall, citationHit,
        missedExpected: missedExpected.join("; "),
        invalidCitations: result.invalidCitations.join("; "),
        verified: result.verified, lowConfidence: result.lowConfidence,
        retrievedCount: retrievedControlScores.length,
        relevantRetrievedCount: retrievedControlScores.filter((cs) => cs.relevant).length,
        irrelevantRetrievedCount: retrievedControlScores.filter((cs) => !cs.relevant).length,
        retrievedControlScores: JSON.stringify(retrievedControlScores),
        scoreMin, scoreMax, scoreAvg, error: null,
      };
      rows.push(row);

      const pStr = contextPrecision === null ? "n/a" : `${(contextPrecision * 100).toFixed(0)}%`;
      const rStr = contextRecall === null ? "n/a" : `${(contextRecall * 100).toFixed(0)}%`;
      console.log(`${i + 1}/${evalSet.length} — retrieval ${retrievalHit ? "✅" : "❌"}  recall ${rStr}  precision ${pStr}  citation ${citationHit ? "✅" : "❌"}  ${result.verified ? "verified" : "⚠️ invalid citation"}`);
      console.log(`    retrieved: ${row.retrievedCount} | relevant: ${row.relevantRetrievedCount} | irrelevant: ${row.irrelevantRetrievedCount} | score range: ${scoreMin === null ? "n/a" : `${scoreMin.toFixed(2)} -${scoreMax.toFixed(2)}`}`);
    } 
    catch (err) {
      rows.push({
        sNo: i + 1, findingText, expectedControlIds: expectedControlIds.join("; "),
        citedControls: "", retrievalHit: false, contextPrecision: null, contextRecall: null, citationHit: false,
        missedExpected: "", invalidCitations: "", verified: false, lowConfidence: false,
        retrievedCount: 0, relevantRetrievedCount: 0, irrelevantRetrievedCount: 0,
        retrievedControlScores: "", scoreMin: null, scoreMax: null, scoreAvg: null,
        error: err.message ?? String(err),
      });
      console.log(`${i + 1}/${evalSet.length} — ❌ ERROR: ${err.message ?? err}`);
    }

    if (i < evalSet.length - 1) await sleep(PACING_MS);
  }

  // Aggregate metrics
  const okRows = rows.filter((r) => r.error === null);
  const nOk = okRows.length;
  const precRows = okRows.filter((r) => r.contextPrecision !== null);
  const recRows = okRows.filter((r) => r.contextRecall !== null);

  const retrievalHitRate = calcRate(okRows.filter((r) => r.retrievalHit), nOk);
  const citationHitRate = calcRate(okRows.filter((r) => r.citationHit), nOk);
  const citationValidityRate = calcRate(okRows.filter((r) => r.verified), nOk);
  const lowConfidenceRate = calcRate(okRows.filter((r) => r.lowConfidence), nOk);
  const avgPrecision = precRows.length ? (precRows.reduce((acc, r) => acc + r.contextPrecision, 0) / precRows.length) * 100 : null;
  const avgRecall = recRows.length ? (recRows.reduce((acc, r) => acc + r.contextRecall, 0) / recRows.length) * 100 : null;

  console.log("\n--- Summary ---");
  if (rows.length - nOk > 0) console.log(`Errored:                 ${rows.length - nOk}/${rows.length} (excluded from rates below)`);
  console.log(`Retrieval hit rate:      ${retrievalHitRate === null ? "n/a" : `${retrievalHitRate.toFixed(1)}% (${okRows.filter((r) => r.retrievalHit).length}/${nOk})`}`);
  console.log(`Context recall:          ${avgRecall === null ? "n/a" : `${avgRecall.toFixed(1)}% avg (over ${recRows.length}/${nOk})`}`);
  console.log(`Context precision:       ${avgPrecision === null ? "n/a" : `${avgPrecision.toFixed(1)}% avg (over ${precRows.length}/${nOk})`}`);
  console.log(`Citation hit rate:       ${citationHitRate === null ? "n/a" : `${citationHitRate.toFixed(1)}% (${okRows.filter((r) => r.citationHit).length}/${nOk})`}`);
  console.log(`Citation validity rate:  ${citationValidityRate === null ? "n/a" : `${citationValidityRate.toFixed(1)}% (${okRows.filter((r) => r.verified).length}/${nOk})`}`);
  console.log(`Low-confidence rate:     ${lowConfidenceRate === null ? "n/a" : `${lowConfidenceRate.toFixed(1)}% (${okRows.filter((r) => r.lowConfidence).length}/${nOk})`}`);

  // Write CSV
  const headers = ["S.No.", "Finding", "Expected Controls", "Cited Controls", "Retrieval Hit", "Context Recall", "Context Precision", "Citation Hit", "Missed Expected", "Invalid Citations", "Verified", "Low Confidence", "Retrieved Count", "Relevant Retrieved Count", "Irrelevant Retrieved Count", "Retrieved Control Scores", "Score Min", "Score Max", "Score Average", "Error"];
  const csvData = [
    headers,
    ...rows.map((r) => [
      r.sNo, r.findingText, r.expectedControlIds, r.citedControls, r.retrievalHit,
      fmtPct(r.contextRecall !== null ? r.contextRecall * 100 : null),
      fmtPct(r.contextPrecision !== null ? r.contextPrecision * 100 : null),
      r.citationHit, r.missedExpected, r.invalidCitations, r.verified, r.lowConfidence,
      r.retrievedCount, r.relevantRetrievedCount, r.irrelevantRetrievedCount,
      r.retrievedControlScores, r.scoreMin, r.scoreMax, r.scoreAvg, r.error ?? "",
    ]),
  ];

  const outPath = path.join(__dirname, "..", "eval-report.csv");
  fs.writeFileSync(outPath, csvData.map((row) => row.map(csvEscape).join(",")).join("\n"));
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => {
  console.error("Eval run failed:", err.message);
  process.exit(1);
});