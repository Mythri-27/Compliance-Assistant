"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";

// Failure-mode guardrail: a very large paste run synchronously, one finding
// at a time, against a rate-limited free-tier API would take a long time and
// risk exhausting quota mid-batch. Cap it and tell the user, rather than
// silently truncating or hanging.
const MAX_FINDINGS_PER_BATCH = 50;

// Below this length a remediation reads as one short paragraph anyway —
// no point offering a "Show more" toggle for a sentence that isn't clamped.
const REMEDIATION_PREVIEW_CHARS = 160;

function statusFor(r) {
  if (r.lowConfidence) return "Low confidence";
  if (r.citedControls.length === 0) return "No relevant match";
  if (!r.verified) return "Unverified";
  return "Verified";
}

function statusClass(r) {
  if (r.error) return "status-error";
  if (r.lowConfidence) return "status-low";
  if (r.citedControls.length === 0) return "status-nomatch";
  if (!r.verified) return "status-unverified";
  return "status-verified";
}

// A cited control's score comes from controlScores (the retrieval candidate
// list) — invalid citations (hallucinated IDs) won't have one, hence the
// fallback.
function scoreFor(r, controlId) {
  return r.controlScores.find((cs) => cs.controlId === controlId)?.score;
}

// The reranked list (rerankedControlIds) is the model's relevance-filtered
// superset of what it ended up citing. Showing the whole list next to the
// cited one would mostly repeat itself — the actually new signal is what the
// model flagged as relevant but didn't cite in the final remediation.
function alsoRelevantFor(r) {
  const reranked = r.rerankedControlIds ?? [];
  return reranked.filter((id) => !r.citedControls.includes(id));
}

// Convex action failures often surface as a multi-line message with a raw
// server stack trace attached — never something to show a user directly.
// Keep only the first clean line, strip any leaked file:line reference or
// trailing "at ..." frame, and fall back to a generic message if nothing
// usable survives.
function friendlyErrorMessage(err) {
  const raw = err?.message ?? String(err);
  const firstLine = raw.split("\n")[0].trim();
  const cleaned = firstLine
    .replace(/\s+at\s.+$/, "")
    .replace(/\([^)]*:\d+:\d+\)/, "")
    .trim();
  if (!cleaned || /^(uncaught\s+)?(error|typeerror|referenceerror)\s*:?\s*$/i.test(cleaned)) {
    return "Something went wrong analyzing this finding. Try again.";
  }
  return cleaned.length > 160 ? `${cleaned.slice(0, 160)}…` : cleaned;
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
  const [expandedRows, setExpandedRows] = useState(() => new Set());

  const analyzeFinding = useAction(api.analyze.analyzeFinding);

  function toggleRow(sNo) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(sNo)) next.delete(sNo);
      else next.add(sNo);
      return next;
    });
  }

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
    setExpandedRows(new Set()); // sNo restarts at 1 each run — don't carry over stale expand state
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
        // Full error stays in the console for debugging; the UI only ever
        // shows a sanitized, user-facing message (see friendlyErrorMessage).
        console.error(`Analysis failed for finding ${i + 1}:`, err);
        setResults((prev) => [
          ...prev,
          {
            sNo: i + 1,
            findingText,
            error: friendlyErrorMessage(err),
            lowConfidence: false,
            verified: false,
            retrievedControlIds: [],
            controlScores: [],
            remediation: "",
            citedControls: [],
            invalidCitations: [],
            rerankedControlIds: [],
            invalidReranked: [],
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
      [
        "S.No.",
        "Finding",
        "Matched Controls",
        "Confidence",
        "Also Relevant Controls",
        "Status",
        "Remediation",
      ],
      ...results.map((r) => [
        r.sNo,
        r.findingText,
        r.citedControls.join("\n"),
        r.citedControls.map((id) => scoreFor(r, id)?.toFixed(2) ?? "—").join("\n"),
        alsoRelevantFor(r).join("\n"),
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
        <section>
          <h2>Results</h2>
          <div className="table-scroll">
            <table className="results-table">
              <thead>
                <tr>
                  <th>S.No.</th>
                  <th>Finding</th>
                  <th>Matched Controls</th>
                  <th>Also Relevant</th>
                  <th>Status</th>
                  <th>Remediation</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const alsoRelevant = alsoRelevantFor(r);
                  return (
                    <tr key={r.sNo}>
                      <td className="col-num">{r.sNo}</td>
                      <td className="col-finding">{r.findingText}</td>
                      <td className="col-controls">
                        {r.citedControls.length === 0 ? (
                          <span className="cell-empty">—</span>
                        ) : (
                          r.citedControls.map((id) => {
                            const invalid = r.invalidCitations.includes(id);
                            const score = scoreFor(r, id);
                            return (
                              <span
                                key={id}
                                className={`chip ${invalid ? "chip-invalid" : "chip-cited"}`}
                              >
                                <span className="chip-id">{id}</span>
                                {score !== undefined && (
                                  <span className="chip-score">{score.toFixed(2)}</span>
                                )}
                                {invalid && (
                                  <span className="chip-flag" title="Not found in corpus">
                                    ⚠
                                  </span>
                                )}
                              </span>
                            );
                          })
                        )}
                      </td>
                      <td className="col-controls">
                        {alsoRelevant.length === 0 ? (
                          <span className="cell-empty">—</span>
                        ) : (
                          alsoRelevant.map((id) => {
                            const invalid = (r.invalidReranked ?? []).includes(id);
                            return (
                              <span key={id} className={`chip ${invalid ? "chip-invalid" : "chip-relevant"}`}>
                                <span className="chip-id">{id}</span>
                                {invalid && (
                                  <span className="chip-flag" title="Not found in corpus">⚠</span>
                                )}
                              </span>
                            );
                          })
                        )}
                      </td>
                      <td>
                        <span className={`status-pill ${statusClass(r)}`}>
                          {r.error ? "Error" : statusFor(r)}
                        </span>
                      </td>
                      <td className="col-remediation">
                        {r.error ? (
                          r.error
                        ) : (
                          <>
                            <p
                              className={`remediation-text${expandedRows.has(r.sNo) ? " expanded" : ""
                                }`}
                            >
                              {r.remediation}
                            </p>
                            {r.remediation.length > REMEDIATION_PREVIEW_CHARS && (
                              <button
                                type="button"
                                className="row-toggle"
                                onClick={() => toggleRow(r.sNo)}
                              >
                                {expandedRows.has(r.sNo) ? "Show less" : "Show more"}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button className="export-btn" onClick={handleExportCsv} disabled={processing}>
            Download as CSV
          </button>
        </section>
      )}
    </main>
  );
}