"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

// Failure-mode guardrail: a very large paste run synchronously, one finding
// at a time, against a rate-limited free-tier API would take a long time and
// risk exhausting quota mid-batch. Cap it and tell the user, rather than
// silently truncating or hanging.
const MAX_FINDINGS_PER_BATCH = 50;

function statusFor(r) {
  if (r.lowConfidence) return "Low confidence";
  if (r.citedControls.length === 0) return "No relevant match";
  if (!r.verified) return "Unverified";
  return "Verified";
}

// A cited control's score comes from controlScores (the retrieval candidate
// list) — invalid citations (hallucinated IDs) won't have one, hence the
// fallback.
function scoreFor(r, controlId) {
  return r.controlScores.find((cs) => cs.controlId === controlId)?.score;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [inputText, setInputText] = useState("");
  const [results, setResults] = useState([]); // one entry per finding, in order
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [inputWarning, setInputWarning] = useState("");

  const analyzeFinding = useAction(api.analyze.analyzeFinding);

  async function handleAnalyzeAll() {
    const rawLines = inputText.split("\n").map((l) => l.trim());
    const lines = rawLines.filter((l) => l.length > 0);

    // Empty input / all-blank-lines paste → clear message, no crash, no call.
    if (lines.length === 0) {
      setInputWarning("Paste at least one non-empty line before analyzing.");
      setResults([]);
      return;
    }

    let toProcess = lines;
    if (lines.length > MAX_FINDINGS_PER_BATCH) {
      toProcess = lines.slice(0, MAX_FINDINGS_PER_BATCH);
      setInputWarning(
        `Pasted ${lines.length} findings — only analyzing the first ${MAX_FINDINGS_PER_BATCH} in this run. Split larger batches into multiple runs.`
      );
    } else {
      setInputWarning("");
    }

    setResults([]);
    setProcessing(true);
    setProgress({ done: 0, total: toProcess.length });

    // Sequential, not Promise.all — a free-tier API key has a shared rate
    // limit across all calls; running 50 findings concurrently would hit it
    // immediately. Sequential also lets the table render progressively,
    // one row per completed finding, instead of all-or-nothing.
    for (let i = 0; i < toProcess.length; i++) {
      const findingText = toProcess[i];
      try {
        const result = await analyzeFinding({ findingText });
        setResults((prev) => [...prev, { sNo: i + 1, findingText, ...result }]);
      } catch (err) {
        setResults((prev) => [
          ...prev,
          {
            sNo: i + 1,
            findingText,
            error: err.message ?? String(err),
            lowConfidence: false,
            verified: false,
            retrievedControlIds: [],
            controlScores: [],
            remediation: "",
            citedControls: [],
            invalidCitations: [],
          },
        ]);
      }
      setProgress({ done: i + 1, total: toProcess.length });
    }

    setProcessing(false);
  }

  function handleExportCsv() {
    if (results.length === 0) return;
    const rows = [
      ["S.No.", "Finding", "Matched Controls", "Confidence", "Status", "Remediation"],
      ...results.map((r) => [
        r.sNo,
        r.findingText,
        r.citedControls.join("\n"),
        r.citedControls.map((id) => scoreFor(r, id)?.toFixed(2) ?? "—").join("\n"),
        r.error ? `Error: ${r.error}` : statusFor(r),
        r.remediation,
      ]),
    ];
    downloadCsv("compliance-analysis-batch.csv", rows);
  }

  return (
    <main>
      <h1>Compliance RAG Assistant</h1>
      <p>
        Paste one finding per line. Each line is matched independently against OWASP, SOC 2, and ISO 27001
        controls.
      </p>

      <textarea
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        placeholder={
          "e.g.\nLogin endpoint concatenates user input directly into SQL query, allowing injection.\nSession cookies are transmitted over unencrypted HTTP.\nAdmin dashboard has no authentication required."
        }
      />
      <br />
      <button onClick={handleAnalyzeAll} disabled={processing}>
        {processing ? `Analyzing ${progress.done}/${progress.total}...` : "Analyze All"}
      </button>

      {inputWarning && <p className="warning">⚠️ {inputWarning}</p>}

      {results.length > 0 && (
        <section style={{ marginTop: 30 }}>
          <h2>Results</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>S.No.</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Finding</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Matched Controls</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Confidence</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Status</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Remediation</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.sNo}>
                  <td style={{ verticalAlign: "top", padding: 6, borderBottom: "1px solid #eee" }}>{r.sNo}</td>
                  <td style={{ verticalAlign: "top", padding: 6, borderBottom: "1px solid #eee", maxWidth: 220 }}>
                    {r.findingText}
                  </td>
                  <td style={{ verticalAlign: "top", padding: 6, borderBottom: "1px solid #eee", whiteSpace: "nowrap" }}>
                    {r.citedControls.length === 0
                      ? "—"
                      : r.citedControls.map((id) => (
                          <div key={id} className={r.invalidCitations.includes(id) ? "invalid" : ""}>
                            {id}
                            {r.invalidCitations.includes(id) && " ⚠️"}
                          </div>
                        ))}
                  </td>
                  <td style={{ verticalAlign: "top", padding: 6, borderBottom: "1px solid #eee" }}>
                    {r.citedControls.length === 0
                      ? "—"
                      : r.citedControls.map((id) => (
                          <div key={id}>{scoreFor(r, id)?.toFixed(2) ?? "—"}</div>
                        ))}
                  </td>
                  <td
                    style={{ verticalAlign: "top", padding: 6, borderBottom: "1px solid #eee" }}
                    className={r.error || (!r.lowConfidence && r.citedControls.length > 0 && !r.verified) ? "invalid" : ""}
                  >
                    {r.error ? "Error" : statusFor(r)}
                  </td>
                  <td style={{ verticalAlign: "top", padding: 6, borderBottom: "1px solid #eee", maxWidth: 320 }}>
                    {r.error ? r.error : r.remediation}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button onClick={handleExportCsv} disabled={processing}>
            Download as CSV
          </button>
        </section>
      )}
    </main>
  );
}