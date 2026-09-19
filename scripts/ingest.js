// Runs on YOUR machine (not on Convex's servers) — reads data/controls.json
// locally, then calls the corpus:ingestBatch action over the network.
// Usage: npm run ingest

require("dotenv").config({ path: ".env.local" });
const fs = require("fs");
const path = require("path");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

async function main() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is not set in .env.local — make sure `npx convex dev` has run at least once."
    );
  }

  const filePath = path.join(__dirname, "..", "data", "controls.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${filePath} not found. Run: cp data/sample-controls.json data/controls.json (then fill it with your real corpus).`
    );
  }

  const entries = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`Read ${entries.length} entries from data/controls.json — embedding and uploading...`);

  const client = new ConvexHttpClient(url);
  const result = await client.action(anyApi.corpus.ingestBatch, { entries });

  console.log(`Done. Replaced old corpus (${result.replaced} rows removed) with ${result.ingested} new controls.`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err.message);
  process.exit(1);
});
