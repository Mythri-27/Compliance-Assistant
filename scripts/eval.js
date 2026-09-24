require("dotenv").config({ path: ".env.local" });
const fs = require("fs");
const path = require("path");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const PACING_MS = 13000;
const RANK_N_VALUES = [1, 2, 3, 4, 5, 7, 10, 15, 20];

const csvEscape = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calcRate = (subset, total) => (total > 0 ? (subset.length / total) * 100 : null);
const fmtPct = (val) => (val === null ? "n/a" : `${val.toFixed(0)}%`);

// Framework is fully determined by the controlId's own shape — no lookup needed.
function inferFramework(controlId) {
  if (/^LLM\d{2}:2025$/.test(controlId)) return "OWASP_LLM";
  if (/^A\d{2}:2025$/.test(controlId)) return "OWASP_WEB";
  if (controlId.startsWith("SOC2-")) return "SOC2";
  if (controlId.startsWith("ISO27001-")) return "ISO27001";
  return "UNKNOWN";
}

// For each expected control, find where it ranks (1-based) within its OWN
// framework's candidate list, sorted by score descending. controlScores
// already covers ~the whole framework at threshold 0.4, so "not found" means
// the control scored below 0.4 entirely (fell out of retrieval, not just
// ranked low).
function rankExpectedControls(expectedControlIds, controlScores) {
  const byFramework = {};
  for (const cs of controlScores) {
    const fw = inferFramework(cs.controlId);
    (byFramework[fw] ??= []).push(cs);
  }
  for (const fw in byFramework) {
    byFramework[fw].sort((a, b) => b.score - a.score);
  }

  return expectedControlIds.map((controlId) => {
    const fw = inferFramework(controlId);
    const list = byFramework[fw] ?? [];
    const idx = list.findIndex((cs) => cs.controlId === controlId);
    return {
      controlId,
      framework: fw,
      rank: idx === -1 ? null : idx,
      totalInFramework: list.length,
      found: idx !== -1,
    };
  });
}

async function main() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not set in .env.local — run `npx convex dev` first.");

  const filePath = path.join(__dirname, "..", "data", "eval-set.json");
  if (!fs.existsSync(filePath)) throw new Error(`${filePath} not found. Run: cp data/eval-set.example.json data/eval-set.json`);

  const evalSet = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`Loaded ${evalSet.length} labeled findings. Running each through the pipeline...\n`);

  const client = new ConvexHttpClient(url);
  const rows = [];
  const allRankRecords = []; // flat list across every finding, for the aggregate table

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

      // --- Reranked precision/recall — uses the model's own relevance-
      // filtered/ordered subset (rerankedControlIds) instead of the raw
      // vector-search output, at zero extra API cost. ---
      const rerankedIds = result.rerankedControlIds ?? [];
      const rerankedTruePositives = rerankedIds.filter((id) => expectedSet.has(id)).length;
      const rerankedPrecision = rerankedIds.length ? rerankedTruePositives / rerankedIds.length : null;
      const rerankedRecall = expectedControlIds.length ? rerankedTruePositives / expectedControlIds.length : null;

      // Cited precision/recall: same math, applied to what the remediation actually cites
      const citedIds = result.citedControls ?? [];
      const citedTP = citedIds.filter((id) => expectedSet.has(id)).length;
      const citedPrecision = citedIds.length ? citedTP / citedIds.length : null;
      const citedRecall = expectedControlIds.length ? citedTP / expectedControlIds.length : null;

      // What reranked adds on top of cited, and how much of it is right
      const rerankedOnly = rerankedIds.filter((id) => !citedSet.has(id));
      const rerankedOnlyHits = rerankedOnly.filter((id) => expectedSet.has(id)).length;

      const retrievedControlScores = (result.controlScores ?? []).map((cs) => ({
        controlId: cs.controlId,
        score: Number(cs.score.toFixed(4)),
        relevant: expectedSet.has(cs.controlId),
      }));

      const scores = retrievedControlScores.map((cs) => cs.score);
      const scoreMin = scores.length ? Math.min(...scores) : null;
      const scoreMax = scores.length ? Math.max(...scores) : null;
      const scoreAvg = scores.length ? scores.reduce((sum, s) => sum + s, 0) / scores.length : null;

      // --- Rank each expected control within its own framework ---
      const rankRecords = rankExpectedControls(expectedControlIds, retrievedControlScores);
      allRankRecords.push(...rankRecords);
      const foundRanks = rankRecords.filter((r) => r.found).map((r) => r.rank + 1); // display as 1-based
      const worstRank = rankRecords.some((r) => !r.found)
        ? "below threshold" // at least one expected control didn't even clear 0.4
        : (foundRanks.length ? Math.max(...foundRanks) : null);

      const row = {
        sNo: i + 1, findingText,
        expectedControlIds: expectedControlIds.join("; "),
        citedControls: result.citedControls.join("; "),
        remediation: result.remediation,
        rerankedControlIds: rerankedIds.join("; "),
        retrievalHit, contextRecall, contextPrecision, citationHit,
        rerankedRecall, rerankedPrecision,
        missedExpected: missedExpected.join("; "),
        invalidCitations: result.invalidCitations.join("; "),
        verified: result.verified, lowConfidence: result.lowConfidence,
        retrievedCount: retrievedControlScores.length,
        relevantRetrievedCount: retrievedControlScores.filter((cs) => cs.relevant).length,
        irrelevantRetrievedCount: retrievedControlScores.filter((cs) => !cs.relevant).length,
        retrievedControlScores: JSON.stringify(retrievedControlScores),
        scoreMin, scoreMax, scoreAvg, error: null,
        expectedControlRanks: JSON.stringify(
          rankRecords.map((r) => ({
            controlId: r.controlId,
            framework: r.framework,
            rank: r.found ? r.rank + 1 : null, // 1-based, or null if below threshold
            totalInFramework: r.totalInFramework,
          }))
        ),
        worstRankInFramework: worstRank,
        citedPrecision, citedRecall,
        rerankedOnlyCount: rerankedOnly.length, rerankedOnlyHits,
        invalidReranked: (result.invalidReranked ?? []).join("; "),
      };
      rows.push(row);

      const pStr = contextPrecision === null ? "n/a" : `${(contextPrecision * 100).toFixed(0)}%`;
      const rStr = contextRecall === null ? "n/a" : `${(contextRecall * 100).toFixed(0)}%`;
      const rpStr = rerankedPrecision === null ? "n/a" : `${(rerankedPrecision * 100).toFixed(0)}%`;
      const rrStr = rerankedRecall === null ? "n/a" : `${(rerankedRecall * 100).toFixed(0)}%`;
      console.log(`${i + 1}/${evalSet.length} — retrieval ${retrievalHit ? "✅" : "❌"}  recall ${rStr}  precision ${pStr}  |  reranked recall ${rrStr}  reranked precision ${rpStr}  citation ${citationHit ? "✅" : "❌"}  ${result.verified ? "verified" : "⚠️ invalid citation"}`);
      console.log(`    retrieved: ${row.retrievedCount} | relevant: ${row.relevantRetrievedCount} | irrelevant: ${row.irrelevantRetrievedCount} | score range: ${scoreMin === null ? "n/a" : `${scoreMin.toFixed(2)} -${scoreMax.toFixed(2)}`}`);
      console.log(`    reranked (${rerankedIds.length}): ${rerankedIds.join(", ") || "none"}`);
      const cpStr = citedPrecision === null ? "n/a" : `${(citedPrecision * 100).toFixed(0)}%`;
      const crStr = citedRecall === null ? "n/a" : `${(citedRecall * 100).toFixed(0)}%`;
      console.log(`    cited recall ${crStr} cited precision ${cpStr} | reranked adds ${rerankedOnly.length} (${rerankedOnlyHits} correct)`);

      console.log(`    ranks (within own framework): ${rankRecords.map((r) => `${r.controlId}=${r.found ? `#${r.rank + 1}` : "BELOW-THRESHOLD"}`).join(", ")}`);
    }
    catch (err) {
      rows.push({
        sNo: i + 1, findingText, expectedControlIds: expectedControlIds.join("; "),
        citedControls: "", remediation: "", rerankedControlIds: "",
        retrievalHit: false, contextRecall: null, contextPrecision: null, citationHit: false,
        rerankedRecall: null, rerankedPrecision: null,
        missedExpected: "", invalidCitations: "", verified: false, lowConfidence: false,
        retrievedCount: 0, relevantRetrievedCount: 0, irrelevantRetrievedCount: 0,
        retrievedControlScores: "", scoreMin: null, scoreMax: null, scoreAvg: null,
        expectedControlRanks: "", worstRankInFramework: null,
        error: err.message ?? String(err),
        citedPrecision: null, citedRecall: null, rerankedOnlyCount: 0, rerankedOnlyHits: 0, invalidReranked: "",
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
  const rerankedPrecRows = okRows.filter((r) => r.rerankedPrecision !== null);
  const rerankedRecRows = okRows.filter((r) => r.rerankedRecall !== null);

  const retrievalHitRate = calcRate(okRows.filter((r) => r.retrievalHit), nOk);
  const citationHitRate = calcRate(okRows.filter((r) => r.citationHit), nOk);
  const citationValidityRate = calcRate(okRows.filter((r) => r.verified), nOk);
  const lowConfidenceRate = calcRate(okRows.filter((r) => r.lowConfidence), nOk);
  const avgPrecision = precRows.length ? (precRows.reduce((acc, r) => acc + r.contextPrecision, 0) / precRows.length) * 100 : null;
  const avgRecall = recRows.length ? (recRows.reduce((acc, r) => acc + r.contextRecall, 0) / recRows.length) * 100 : null;
  const avgRerankedPrecision = rerankedPrecRows.length ? (rerankedPrecRows.reduce((acc, r) => acc + r.rerankedPrecision, 0) / rerankedPrecRows.length) * 100 : null;
  const avgRerankedRecall = rerankedRecRows.length ? (rerankedRecRows.reduce((acc, r) => acc + r.rerankedRecall, 0) / rerankedRecRows.length) * 100 : null;
  const citedPrecRows = okRows.filter((r) => r.citedPrecision !== null);
  const citedRecRows = okRows.filter((r) => r.citedRecall !== null);
  const avgCitedPrecision = citedPrecRows.length ? (citedPrecRows.reduce((a, r) => a + r.citedPrecision, 0) / citedPrecRows.length) * 100 : null;
  const avgCitedRecall = citedRecRows.length ? (citedRecRows.reduce((a, r) => a + r.citedRecall, 0) / citedRecRows.length) * 100 : null;
  const extraTotal = okRows.reduce((s, r) => s + r.rerankedOnlyCount, 0);
  const extraHits = okRows.reduce((s, r) => s + r.rerankedOnlyHits, 0);

  console.log("\n--- Summary ---");
  if (rows.length - nOk > 0) console.log(`Errored:                 ${rows.length - nOk}/${rows.length} (excluded from rates below)`);
  console.log(`Retrieval hit rate:      ${retrievalHitRate === null ? "n/a" : `${retrievalHitRate.toFixed(1)}% (${okRows.filter((r) => r.retrievalHit).length}/${nOk})`}`);
  console.log(`Context recall:          ${avgRecall === null ? "n/a" : `${avgRecall.toFixed(1)}% avg (over ${recRows.length}/${nOk})`}`);
  console.log(`Context precision:       ${avgPrecision === null ? "n/a" : `${avgPrecision.toFixed(1)}% avg (over ${precRows.length}/${nOk})`}`);
  console.log(`Reranked recall:         ${avgRerankedRecall === null ? "n/a" : `${avgRerankedRecall.toFixed(1)}% avg (over ${rerankedRecRows.length}/${nOk})`}`);
  console.log(`Reranked precision:      ${avgRerankedPrecision === null ? "n/a" : `${avgRerankedPrecision.toFixed(1)}% avg (over ${rerankedPrecRows.length}/${nOk})`}`);
  console.log(`Citation hit rate:       ${citationHitRate === null ? "n/a" : `${citationHitRate.toFixed(1)}% (${okRows.filter((r) => r.citationHit).length}/${nOk})`}`);
  console.log(`Citation validity rate:  ${citationValidityRate === null ? "n/a" : `${citationValidityRate.toFixed(1)}% (${okRows.filter((r) => r.verified).length}/${nOk})`}`);
  console.log(`Low-confidence rate:     ${lowConfidenceRate === null ? "n/a" : `${lowConfidenceRate.toFixed(1)}% (${okRows.filter((r) => r.lowConfidence).length}/${nOk})`}`);
  console.log(`Cited recall:           ${avgCitedRecall === null ? "n/a" : `${avgCitedRecall.toFixed(1)}% avg`}`);
  console.log(`Cited precision:        ${avgCitedPrecision === null ? "n/a" : `${avgCitedPrecision.toFixed(1)}% avg`}`);
  console.log(`Reranked-only additions: ${extraHits}/${extraTotal} correct`);

  // Rank-based recall table — "if we only kept top-N per framework instead
  // of score-thresholding, what fraction of expected controls would we
  // still have?"
  console.log("\n--- Recall@N-per-framework (would replacing the threshold with a fixed top-N cutoff work?) ---");
  const totalExpected = allRankRecords.length;
  const belowThreshold = allRankRecords.filter((r) => !r.found).length;
  console.log(`Total expected-control instances across eval set: ${totalExpected} (${belowThreshold} never cleared the 0.4 threshold at all — no N can recover those)\n`);
  console.log("N".padEnd(6) + "Recall@N".padEnd(12) + "Caught/Total");
  console.log("-".repeat(30));
  const rankTableRows = RANK_N_VALUES.map((n) => {
    const caught = allRankRecords.filter((r) => r.found && r.rank < n).length; // r.rank is 0-based
    const recallAtN = totalExpected ? (caught / totalExpected) * 100 : 0;
    console.log(`${String(n).padEnd(6)}${`${recallAtN.toFixed(1)}%`.padEnd(12)}${caught}/${totalExpected}`);
    return { n, recallAtN, caught, total: totalExpected };
  });

  // Write CSVs
  const headers = ["S.No.", "Finding", "Expected Controls", "Cited Controls", "Remediation", "Reranked Controls", "Retrieval Hit", "Context Recall", "Context Precision", "Reranked Recall", "Reranked Precision", "Citation Hit", "Missed Expected", "Invalid Citations", "Verified", "Low Confidence", "Retrieved Count", "Relevant Retrieved Count", "Irrelevant Retrieved Count", "Retrieved Control Scores", "Score Min", "Score Max", "Score Average", "Expected Control Ranks", "Worst Rank In Framework", "Cited Recall", "Cited Precision", "Reranked-Only Count", "Reranked-Only Hits", "Invalid Reranked", "Error"];
  const csvData = [
    headers,
    ...rows.map((r) => [
      r.sNo, r.findingText, r.expectedControlIds, r.citedControls, r.remediation, r.rerankedControlIds, r.retrievalHit,
      fmtPct(r.contextRecall !== null ? r.contextRecall * 100 : null),
      fmtPct(r.contextPrecision !== null ? r.contextPrecision * 100 : null),
      fmtPct(r.rerankedRecall !== null ? r.rerankedRecall * 100 : null),
      fmtPct(r.rerankedPrecision !== null ? r.rerankedPrecision * 100 : null),
      r.citationHit, r.missedExpected, r.invalidCitations, r.verified, r.lowConfidence,
      r.retrievedCount, r.relevantRetrievedCount, r.irrelevantRetrievedCount,
      r.retrievedControlScores, r.scoreMin, r.scoreMax, r.scoreAvg,
      r.expectedControlRanks, r.worstRankInFramework,
      fmtPct(r.citedRecall !== null ? r.citedRecall * 100 : null),
      fmtPct(r.citedPrecision !== null ? r.citedPrecision * 100 : null),
      r.rerankedOnlyCount, r.rerankedOnlyHits, r.invalidReranked,
      r.error ?? "",
    ]),
  ];

  const outPath = path.join(__dirname, "..", "eval-report.csv");
  fs.writeFileSync(outPath, csvData.map((row) => row.map(csvEscape).join(",")).join("\n"));
  console.log(`\nFull report written to ${outPath}`);

  const rankOutPath = path.join(__dirname, "..", "rank-analysis.csv");
  const rankCsv = [
    "N,RecallAtN,Caught,Total",
    ...rankTableRows.map((r) => `${r.n},${r.recallAtN.toFixed(2)},${r.caught},${r.total}`),
  ].join("\n");
  fs.writeFileSync(rankOutPath, rankCsv);
  console.log(`Rank analysis written to ${rankOutPath}`);
}

main().catch((err) => {
  console.error("Eval run failed:", err.message);
  process.exit(1);
});