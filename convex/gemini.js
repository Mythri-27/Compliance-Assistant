"use node";

// Thin wrapper around the Gemini API. Kept dependency-free (plain fetch) so
// it works inside a Convex action without extra SDK setup.
//
// NOTE: model names and endpoint paths on Google's side change over time —
// if a call starts 404ing, check https://ai.google.dev/gemini-api/docs/models
// and swap the model string below. gemini-embedding-001 (free tier, scaled to
// 768 dims) and gemini-3.6-flash (free tier, GA/stable) are current as of
// this writing — text-embedding-004 was deprecated Jan 14, 2026, and
// gemini-2.5-flash was sunset for new API keys.

const EMBED_MODEL = "gemini-embedding-001";
const GEN_MODEL = "gemini-3.5-flash-lite";
const BASE = "https://generativelanguage.googleapis.com/v1beta";
// gemini-embedding-001 defaults to 3072-dim vectors; scale down to 768 so it
// matches the `dimensions: 768` set on the vector index in convex/schema.js.
const EMBED_DIMENSIONS = 768;

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set (see .env.example)");
  return key;
}

export async function embedText(text, taskType) {
  // Corpus ingestion fires this many times in a row (174 controls) — retry
  // on rate-limit (429) and transient-overload (503) responses instead of
  // letting one blip fail the whole batch partway through.
  const MAX_ATTEMPTS = 5;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE}/models/${EMBED_MODEL}:embedContent?key=${apiKey()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBED_DIMENSIONS,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.embedding.values;
    }
    lastError = new Error(`Gemini embed failed: ${res.status} ${await res.text()}`);
    if ((res.status !== 429 && res.status !== 503) || attempt === MAX_ATTEMPTS) throw lastError;
    const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw lastError;
}

export async function generateRemediation(findingText, retrievedControls) {
  const controlsBlock = retrievedControls
    .map((c) => `[${c.controlId}] (${c.sourceDoc})\n${c.text}`)
    .join("\n\n");

  const prompt = `You are a security compliance assistant. A vulnerability finding is given below, along with the only compliance controls you are allowed to reference.

FINDING:
${findingText}

RETRIEVED CONTROLS (only cite from these — do not invent or reference any control not listed here):
${controlsBlock}

Instructions:
- If none of the retrieved controls are actually relevant to this finding, say so explicitly in "remediation" and return an empty cited_controls array. Do not force a match.
- Otherwise, write a concise, actionable remediation grounded ONLY in the controls above.
- Every control you reference must appear in "cited_controls" using its exact ID as shown above (e.g. "SOC2-CC6.1").
- Respond with ONLY a JSON object, no markdown fences, no preamble, in this exact shape:
{"remediation": "...", "cited_controls": ["..."]}`;

  // gemini-3.6-flash has a known, ongoing elevated 503 (high-demand) rate on
  // generateContent as of this writing — retry with backoff instead of
  // failing the whole analysis on a transient blip.
  const MAX_ATTEMPTS = 4;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE}/models/${GEN_MODEL}:generateContent?key=${apiKey()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      const cleaned = raw.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(cleaned);
        return {
          remediation: parsed.remediation ?? "",
          cited_controls: Array.isArray(parsed.cited_controls) ? parsed.cited_controls : [],
        };
      } catch {
        return { remediation: raw, cited_controls: [] };
      }
    }

    lastError = new Error(`Gemini generate failed: ${res.status} ${await res.text()}`);
    if (res.status !== 503 || attempt === MAX_ATTEMPTS) throw lastError;

    const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw lastError;
}
