/**
 * Count The Cost — self-hosted social scheduler (Instagram + Facebook)
 * ---------------------------------------------------------------------
 * Runs on a schedule (GitHub Actions cron). On each run it:
 *   1. Reads queue.json
 *   2. Finds posts whose publish_at is due and status === "pending"
 *   3. Publishes each to Instagram and/or Facebook via the Meta Graph API
 *   4. Writes the new status ("posted" / "failed") back to queue.json
 *
 * Secrets come ONLY from environment variables (GitHub Actions Secrets).
 * Nothing sensitive is ever hard-coded in this file.
 *
 *   META_PAGE_TOKEN  — long-lived Facebook Page access token
 *   FB_PAGE_ID       — Facebook Page ID
 *   IG_BUSINESS_ID   — Instagram Business Account ID
 *   IMAGE_BASE_URL   — public base URL where the /images files are served
 *                      (e.g. https://raw.githubusercontent.com/<you>/ctc-scheduler/main/images)
 *
 * Node 18+ (uses built-in fetch). No external dependencies.
 */

const fs = require("fs");
const path = require("path");

const GRAPH = "https://graph.facebook.com/v21.0";
const QUEUE_PATH = path.join(__dirname, "queue.json");

const {
  META_PAGE_TOKEN,
  FB_PAGE_ID,
  IG_BUSINESS_ID,
  IMAGE_BASE_URL,
} = process.env;

// Safety valve: if DRY_RUN=1, log what WOULD post but call no APIs.
const DRY_RUN = process.env.DRY_RUN === "1";

function log(...args) {
  console.log(`[ctc-scheduler]`, ...args);
}

function requireEnv() {
  const missing = [];
  if (!META_PAGE_TOKEN) missing.push("META_PAGE_TOKEN");
  if (!FB_PAGE_ID) missing.push("FB_PAGE_ID");
  if (!IG_BUSINESS_ID) missing.push("IG_BUSINESS_ID");
  if (!IMAGE_BASE_URL) missing.push("IMAGE_BASE_URL");
  if (missing.length && !DRY_RUN) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}

function imageUrlFor(item) {
  if (item.image_url) return item.image_url; // allow full override
  if (!item.image) return null;
  return `${(IMAGE_BASE_URL || "").replace(/\/$/, "")}/${item.image}`;
}

async function graph(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error?.message || text;
    throw new Error(`Graph API ${res.status}: ${msg}`);
  }
  return body;
}

// ---- Instagram: two-step (create container, then publish) ----
async function postInstagram(item, imageUrl) {
  const caption = item.caption_ig || item.caption || "";
  // 1. Create media container
  const createUrl =
    `${GRAPH}/${IG_BUSINESS_ID}/media` +
    `?image_url=${encodeURIComponent(imageUrl)}` +
    `&caption=${encodeURIComponent(caption)}` +
    `&access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;
  const created = await graph(createUrl, { method: "POST" });
  const creationId = created.id;
  if (!creationId) throw new Error("Instagram: no creation id returned");

  // 2. Publish the container
  const publishUrl =
    `${GRAPH}/${IG_BUSINESS_ID}/media_publish` +
    `?creation_id=${encodeURIComponent(creationId)}` +
    `&access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;
  const published = await graph(publishUrl, { method: "POST" });
  return { creationId, mediaId: published.id };
}

// ---- Facebook Page: single-step photo post with caption ----
async function postFacebook(item, imageUrl) {
  const caption = item.caption_fb || item.caption || "";
  const url =
    `${GRAPH}/${FB_PAGE_ID}/photos` +
    `?url=${encodeURIComponent(imageUrl)}` +
    `&caption=${encodeURIComponent(caption)}` +
    `&access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;
  const res = await graph(url, { method: "POST" });
  return { postId: res.post_id || res.id };
}

async function publishItem(item) {
  const imageUrl = imageUrlFor(item);
  if (!imageUrl) throw new Error(`Item ${item.id}: no image / image_url`);

  const platforms = item.platforms || (item.platform === "both"
    ? ["ig", "fb"]
    : [item.platform]);

  const results = {};
  for (const p of platforms) {
    if (DRY_RUN) { results[p] = "DRY_RUN"; continue; }
    if (p === "ig") results.ig = await postInstagram(item, imageUrl);
    else if (p === "fb") results.fb = await postFacebook(item, imageUrl);
  }
  return results;
}

async function main() {
  requireEnv();

  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  const now = Date.now();
  let changed = false;

  const due = queue.filter(
    (i) => i.status === "pending" && new Date(i.publish_at).getTime() <= now
  );

  if (!due.length) {
    log(`Nothing due. (${queue.filter(i => i.status === "pending").length} still scheduled.)`);
    return;
  }

  log(`${due.length} post(s) due${DRY_RUN ? " [DRY RUN]" : ""}.`);

  for (const item of due) {
    try {
      const result = await publishItem(item);
      item.status = DRY_RUN ? "pending" : "posted";
      item.posted_at = new Date(now).toISOString();
      item.result = result;
      changed = true;
      log(`✓ ${item.id} → ${JSON.stringify(result)}`);
    } catch (err) {
      item.status = "failed";
      item.error = String(err.message || err);
      item.failed_at = new Date(now).toISOString();
      changed = true;
      log(`✗ ${item.id} FAILED: ${item.error}`);
    }
  }

  if (changed && !DRY_RUN) {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
    log("queue.json updated.");
  }
}

main().catch((err) => {
  console.error(`[ctc-scheduler] Fatal:`, err);
  process.exit(1);
});
