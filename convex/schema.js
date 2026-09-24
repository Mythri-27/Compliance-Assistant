import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Pre-indexed compliance corpus: chunks from OWASP / SOC 2 / ISO 27001,
  // each tagged with the metadata needed for citation verification.
  controls: defineTable({
    controlId: v.string(), // e.g. "SOC2-CC6.1", "A03:2025", "LLM01:2025"
    framework: v.string(), // "OWASP_WEB" | "OWASP_LLM" | "SOC2" | "ISO27001"
    sourceDoc: v.string(), // e.g. "SOC2 Trust Services Criteria"
    section: v.string(), // e.g. "Logical Access Controls"
    text: v.string(), // the actual control text, chunked
    embedding: v.array(v.float64()),

  })
    .index("by_controlId", ["controlId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768, // matches Gemini text-embedding-004
      filterFields: ["framework"], // lets vectorSearch scope to one framework at a time
    }),

  // One row per analyzed finding — this is what the eval scripts read from.
  analyses: defineTable({
    findingText: v.string(),
    retrievedControlIds: v.array(v.string()),
    controlScores: v.optional(v.array(v.object({ controlId: v.string(), score: v.number() }))),
    topScore: v.number(),
    lowConfidence: v.boolean(), // true if retrieval similarity was below threshold
    remediation: v.string(),
    citedControls: v.array(v.string()),
    invalidCitations: v.array(v.string()), // cited IDs that failed corpus lookup
    verified: v.boolean(), // true iff invalidCitations is empty
    createdAt: v.number(),
    rerankedControlIds: v.optional(v.array(v.string())),
    invalidReranked: v.optional(v.array(v.string())),
  }),
});
