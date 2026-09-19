"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { embedText } from "./gemini";

// NOTE: Convex actions run on Convex's own servers, not on your machine —
// they can't read a local data/controls.json off your disk. Instead, a local
// script (scripts/ingest.js) reads the file on YOUR machine and pushes the
// entries to this action over the network. Run ingestion with `npm run ingest`.
export const ingestBatch = action({
  args: {
    entries: v.array(
      v.object({
        controlId: v.string(),
        framework: v.string(),
        sourceDoc: v.string(),
        section: v.string(),
        text: v.string(),
      })
    ),
  },
  handler: async (ctx, { entries }) => {
    // Wipe the existing corpus first — data/controls.json is treated as the
    // full, current source of truth on every ingest, not an addition to it.
    const removed = await ctx.runMutation(internal.data.clearControls, {});

    let count = 0;
    for (const entry of entries) {
      const embedding = await embedText(entry.text, "RETRIEVAL_DOCUMENT");
      await ctx.runMutation(internal.data.insertControl, { ...entry, embedding });
      count++;
      // Small pacing delay — 174 back-to-back embed calls is enough to brush
      // up against free-tier rate limits; embedText already retries on 429s,
      // this just reduces how often that retry path gets hit in the first place.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { ingested: count, replaced: removed };
  },
});

// Programmatic version if you'd rather call this from a script instead of the CLI.
export const ingestOne = action({
  args: { controlId: v.string(), framework: v.string(), sourceDoc: v.string(), section: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const embedding = await embedText(args.text, "RETRIEVAL_DOCUMENT");
    await ctx.runMutation(internal.data.insertControl, { ...args, embedding });
  },
});
