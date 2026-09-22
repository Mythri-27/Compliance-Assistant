"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { embedText, generateRemediation } from "./gemini";

const FRAMEWORKS = ["OWASP_WEB", "OWASP_LLM", "SOC2", "ISO27001"];
const PER_FRAMEWORK_K = 4; // top-k *within each framework*, not overall
// Below this cosine similarity, we don't trust the match — surface "no
// relevant control found" instead of letting the model force an answer.
// This threshold is a starting guess; tune it against a real eval set
// (see README) once you've hand-labeled some test findings.
const LOW_CONFIDENCE_THRESHOLD = 0.4;

export const analyzeFinding = action({
  args: { findingText: v.string() },
  handler: async (ctx, { findingText }) => {
    // 1. Embed the finding
    const queryEmbedding = await embedText(findingText, "RETRIEVAL_QUERY");

    // 2. Retrieve top-k *per framework*, not one global top-k. A single
    // global search lets one framework's denser/more verbose controls
    // crowd out the others — a finding that legitimately maps to SOC2,
    // ISO27001, and OWASP at once should surface candidates from all three,
    // not just whichever framework embeds "closest" on average.
    const perFrameworkResults = await Promise.all(
      FRAMEWORKS.map((framework) =>
        ctx.vectorSearch("controls", "by_embedding", {
          vector: queryEmbedding,
          limit: PER_FRAMEWORK_K,
          filter: (q) => q.eq("framework", framework),
        })
      )
    );
    const allResults = perFrameworkResults.flat();

    if (allResults.length === 0) {
      const id = await ctx.runMutation(internal.data.saveAnalysis, {
        findingText,
        retrievedControlIds: [],
        controlScores: [],
        topScore: 0,
        lowConfidence: true,
        remediation: "No controls are indexed yet — ingest the corpus first.",
        citedControls: [],
        invalidCitations: [],
        verified: true,
      });
      return {
        _id: id,
        findingText,
        retrievedControlIds: [],
        controlScores: [],
        topScore: 0,
        lowConfidence: true,
        remediation: "No controls are indexed yet — ingest the corpus first.",
        citedControls: [],
        invalidCitations: [],
        verified: true,
      };
    }

    const topScore = Math.max(...allResults.map((r) => r._score));

    // 3. Threshold cutoff *within* the merged set, instead of always taking
    // a fixed k. A finding with 3 clearly-relevant controls returns 3; a
    // finding with only 1 clear match returns 1, rather than padding out
    // to a fixed count with weak matches. Nothing below the threshold is
    // surfaced anywhere — no near-miss placeholders, clean "no match" instead.
    const relevant = allResults.filter((r) => r._score >= LOW_CONFIDENCE_THRESHOLD);

    if (relevant.length === 0) {
      const id = await ctx.runMutation(internal.data.saveAnalysis, {
        findingText,
        retrievedControlIds: [],
        controlScores: [],
        topScore,
        lowConfidence: true,
        remediation: "No matching control found for this finding with sufficient confidence.",
        citedControls: [],
        invalidCitations: [],
        verified: true,
      });
      return {
        _id: id,
        findingText,
        retrievedControlIds: [],
        controlScores: [],
        topScore,
        lowConfidence: true,
        remediation: "No matching control found for this finding with sufficient confidence.",
        citedControls: [],
        invalidCitations: [],
        verified: true,
      };
    }

    const matchedControls = await ctx.runQuery(internal.data.getControlsByIds, {
      ids: relevant.map((r) => r._id),
    });
    // relevant and matchedControls are the same order (Promise.all preserves
    // it), so zip them together for the per-control confidence score.
    const controlScores = matchedControls.map((c, i) => ({
      controlId: c.controlId,
      score: relevant[i]._score,
    }));

    // 4. Generate a remediation grounded in the retrieved controls
    const generated = await generateRemediation(
      findingText,
      matchedControls.map((c) => ({ controlId: c.controlId, sourceDoc: c.sourceDoc, text: c.text }))
    );

    // 5. Verify every cited control ID actually exists in the corpus
    const checks = await Promise.all(
      generated.cited_controls.map(async (id) => ({
        id,
        exists: await ctx.runQuery(internal.data.controlExists, { controlId: id }),
      }))
    );
    const invalidCitations = checks.filter((c) => !c.exists).map((c) => c.id);

    // 6. Store + return
    const result = {
      findingText,
      retrievedControlIds: matchedControls.map((c) => c.controlId),
      controlScores,
      topScore,
      lowConfidence: false,
      remediation: generated.remediation,
      citedControls: generated.cited_controls,
      invalidCitations,
      verified: invalidCitations.length === 0,
    };
    const id = await ctx.runMutation(internal.data.saveAnalysis, result);
    return { _id: id, ...result };
  },
});
