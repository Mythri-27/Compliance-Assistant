import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";

export const insertControl = internalMutation({
  args: {
    controlId: v.string(),
    framework: v.string(),
    sourceDoc: v.string(),
    section: v.string(),
    text: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("controls", args);
  },
});

// Wipes the corpus before a fresh ingest, so re-running `npm run ingest`
// replaces the controls table instead of appending duplicate rows.
export const clearControls = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("controls").collect();
    await Promise.all(existing.map((c) => ctx.db.delete(c._id)));
    return existing.length;
  },
});

// Used by the verification step: does this control ID actually exist in the corpus?
export const controlExists = internalQuery({
  args: { controlId: v.string() },
  handler: async (ctx, { controlId }) => {
    const found = await ctx.db
      .query("controls")
      .withIndex("by_controlId", (q) => q.eq("controlId", controlId))
      .first();
    return found !== null;
  },
});

export const getControlsByIds = internalQuery({
  args: { ids: v.array(v.id("controls")) },
  handler: async (ctx, { ids }) => {
    const results = await Promise.all(ids.map((id) => ctx.db.get(id)));
    return results.filter((r) => r !== null);
  },
});

// Public — used by the UI to render full control text/section/framework
// alongside a saved analysis, which only stores the controlId strings.
export const getControlsByControlIds = query({
  args: { controlIds: v.array(v.string()) },
  handler: async (ctx, { controlIds }) => {
    const results = await Promise.all(
      controlIds.map((controlId) =>
        ctx.db
          .query("controls")
          .withIndex("by_controlId", (q) => q.eq("controlId", controlId))
          .first()
      )
    );
    return results.filter((r) => r !== null);
  },
});

export const saveAnalysis = internalMutation({
  args: {
    findingText: v.string(),
    retrievedControlIds: v.array(v.string()),
    controlScores: v.optional(v.array(v.object({ controlId: v.string(), score: v.number() }))),
    topScore: v.number(),
    lowConfidence: v.boolean(),
    remediation: v.string(),
    citedControls: v.array(v.string()),
    invalidCitations: v.array(v.string()),
    verified: v.boolean(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("analyses", { ...args, createdAt: Date.now() });
  },
});

export const listAnalyses = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("analyses").order("desc").take(50);
  },
});

export const controlCount = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("controls").collect();
    return all.length;
  },
});
