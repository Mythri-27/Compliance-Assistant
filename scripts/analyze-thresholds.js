const fs = require("fs");
const path = require("path");

const CSV_PATH = path.resolve(process.cwd(), "eval-report.csv");
const THRESHOLDS = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
const sep = (char = "=", len = 90) => console.log(char.repeat(len));

function parseCSVLine(line) {
  const values = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      values.push(cur); cur = "";
    } else cur += c;
  }
  return [...values, cur];
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("CSV file is empty or has no data rows.");
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCSVLine(line);
    return headers.reduce((acc, h, idx) => ({ ...acc, [h]: vals[idx] ?? "" }), {});
  });
}

function parseControlScores(val) {
  if (!val?.trim()) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i.controlId === "string" && typeof i.score === "number")
      .map((i) => ({ controlId: i.controlId, score: i.score, relevant: Boolean(i.relevant) })) : [];
  } catch { return []; }
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`File not found: ${CSV_PATH}`);
  process.exit(1);
}

const rows = parseCSV(fs.readFileSync(CSV_PATH, "utf8"));
console.log(`Loaded ${rows.length} evaluation findings.\nAnalyzing thresholds using existing retrieval scores...\n`);

const findings = rows.map((r, i) => ({ number: i + 1, finding: r["Finding"] || `Finding ${i + 1}`, scores: parseControlScores(r["Retrieved Control Scores"]) }));
const totalScores = findings.reduce((sum, f) => sum + f.scores.length, 0);

if (totalScores === 0) {
  console.error('No control scores found in "Retrieved Control Scores". Check eval.js output.');
  process.exit(1);
}
console.log(`Found ${totalScores} retrieved control scores.\n`);

// Threshold Evaluation
sep(); console.log("THRESHOLD ANALYSIS"); sep();
console.log("Threshold".padEnd(12) + "Precision".padEnd(15) + "Recall".padEnd(15) + "Avg Retrieved".padEnd(18) + "Relevant".padEnd(15) + "Irrelevant");
sep("-");

const results = THRESHOLDS.map((th) => {
  let [ret, relRet, irrRet, expRel] = [0, 0, 0, 0];
  for (const { scores } of findings) {
    expRel += scores.filter((c) => c.relevant).length;
    const filtered = scores.filter((c) => c.score >= th);
    const rel = filtered.filter((c) => c.relevant).length;
    ret += filtered.length;
    relRet += rel;
    irrRet += filtered.length - rel;
  }
  const precision = ret ? relRet / ret : 0;
  const recall = expRel ? relRet / expRel : 0;
  const avgRet = findings.length ? ret / findings.length : 0;

  console.log(`${th.toFixed(2).padEnd(12)}${`${(precision * 100).toFixed(2)}%`.padEnd(15)}${`${(recall * 100).toFixed(2)}%`.padEnd(15)}${avgRet.toFixed(1).padEnd(18)}${relRet.toString().padEnd(15)}${irrRet}`);
  return { threshold: th, precision, recall, avgRetrieved: avgRet, relevant: relRet, irrelevant: irrRet };
});
sep();

// Per-Finding Breakdown
console.log("\n"); sep(); console.log("PER-FINDING SCORE DISTRIBUTION"); sep();
for (const f of findings) {
  const rel = f.scores.filter((c) => c.relevant).sort((a, b) => b.score - a.score);
  const irr = f.scores.filter((c) => !c.relevant).sort((a, b) => b.score - a.score);
  console.log(`\nFinding ${f.number}\nRelevant controls (${rel.length}):`);
  if (!rel.length) console.log("  none");
  else rel.forEach((c) => console.log(`  ${c.controlId.padEnd(30)} ${c.score.toFixed(4)}`));

  console.log(`Highest irrelevant controls (${Math.min(10, irr.length)}):`);
  if (!irr.length) console.log("  none");
  else irr.slice(0, 10).forEach((c) => console.log(`  ${c.controlId.padEnd(30)} ${c.score.toFixed(4)}`));
}

// Candidates & Score Overlap
console.log("\n"); sep(); console.log("THRESHOLDS WITH RECALL >= 90%"); sep();
const highRecall = results.filter((r) => r.recall >= 0.90);
if (!highRecall.length) console.log("No tested threshold maintained at least 90% recall.");
else highRecall.forEach((r) => console.log(`Threshold ${r.threshold.toFixed(2)} → Precision ${(r.precision * 100).toFixed(2)}%, Recall ${(r.recall * 100).toFixed(2)}%, Avg Retrieved ${r.avgRetrieved.toFixed(1)}`));

console.log("\n"); sep(); console.log("RELEVANT vs IRRELEVANT SCORE OVERLAP"); sep();
const relScores = findings.flatMap((f) => f.scores.filter((c) => c.relevant).map((c) => c.score));
const irrScores = findings.flatMap((f) => f.scores.filter((c) => !c.relevant).map((c) => c.score));
const [minRel, maxRel] = [Math.min(...relScores), Math.max(...relScores)];
const [minIrr, maxIrr] = [Math.min(...irrScores), Math.max(...irrScores)];

console.log(`Relevant controls:   ${minRel.toFixed(4)} - ${maxRel.toFixed(4)}\nIrrelevant controls: ${minIrr.toFixed(4)} - ${maxIrr.toFixed(4)}`);
console.log(minIrr < maxRel ? "\nSignificant score overlap exists between relevant and irrelevant controls.\nA threshold alone may not cleanly separate them." : "\nLittle/no score overlap detected.\nA score threshold may be effective for filtering.");

// Write CSV
const outPath = path.resolve(process.cwd(), "threshold-analysis.csv");
const csvLines = [
  "Threshold,Precision,Recall,AvgRetrieved,Relevant,Irrelevant",
  ...results.map((r) => `${r.threshold.toFixed(2)},${r.precision.toFixed(4)},${r.recall.toFixed(4)},${r.avgRetrieved.toFixed(2)},${r.relevant},${r.irrelevant}`),
];
fs.writeFileSync(outPath, csvLines.join("\n"), "utf8");
console.log(`\n Summary written to: ${outPath}`);