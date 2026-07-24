/**
 * Count The Cost -- self-hosted social scheduler (Instagram + Facebook + YouTube)
 * -----------------------------------------------------------------------------
 * Runs on a schedule (GitHub Actions cron). On each run it:
 *   1. Reads queue.json
 *   2. Finds posts whose publish_at is due and status === "pending"
 *   3. Publishes each to Instagram / Facebook (Meta Graph API) and/or
 *      YouTube (YouTube Data API v3)
 *   4. Writes the new status ("posted" / "failed") back to queue.json
 *
 * Secrets come ONLY from environment variables (GitHub Actions Secrets).
 * Nothing sensitive is ever hard-coded in this file.
 *
 *   -- Instagram + Facebook --
 *   META_PAGE_TOKEN  -- long-lived Facebook Page access token
 *   FB_PAGE_ID       -- Facebook Page ID
 *   IG_BUSINESS_ID   -- Instagram Business Account ID
 *   IMAGE_BASE_URL   -- public base URL where the /images files are served
 *                      (e.g. https://raw.githubusercontent.com/<you>/ctc-scheduler/main/images)
 *
 *   -- YouTube --
 *   YT_CLIENT_ID     -- OAuth client ID for the "CTC Scheduler" Google Cloud app
 *   YT_CLIENT_SECRET -- OAuth client secret
 *   YT_REFRESH_TOKEN -- long-lived refresh token (channel: Count The Cost Bookkeeping)
 *   VIDEO_BASE_URL   -- (optional) public base URL for /videos files, if you host
 *                      videos outside the repo. If omitted, videos are read from
 *                      the local ./videos folder (checked out by the Action).
 *
 * Node 18+ (uses built-in fetch). No external dependencies.
 */

const fs = require("fs");
const path = require("path");

const GRAPH = "https://graph.facebook.com/v21.0";
const QUEUE_PATH = path.join(__dirname, "queue.json");
const VIDEO_DIR = path.join(__dirname, "videos");

const {
  META_PAGE_TOKEN,
  FB_PAGE_ID,
  IG_BUSINESS_ID,
  IMAGE_BASE_URL,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
  VIDEO_BASE_URL,
} = process.env;

// Safety valve: if DRY_RUN=1, log what WOULD post but call no publishing APIs.
const DRY_RUN = process.env.DRY_RUN === "1";

function log(...args) {
  console.log(`[ctc-scheduler]`, ...args);
}

// Normalize a queue item's target platforms into an array of "ig" | "fb" | "yt".
function platformsFor(item) {
  if (Array.isArray(item.platforms)) return item.platforms;
  if (item.platform === "both") return ["ig", "fb"];
  if (item.platform) return [item.platform];
  return [];
}

// Only require the secrets the DUE posts actually need. A YouTube-only run
// shouldn't fail for missing Meta secrets, and vice-versa.
function requireEnv(due) {
  if (DRY_RUN) return;
  const needed = new Set(due.flatMap(platformsFor));
  const missing = [];
  if (needed.has("ig") || needed.has("fb")) {
    if (!META_PAGE_TOKEN) missing.push("META_PAGE_TOKEN");
    if (needed.has("fb") && !FB_PAGE_ID) missing.push("FB_PAGE_ID");
    if (needed.has("ig") && !IG_BUSINESS_ID) missing.push("IG_BUSINESS_ID");
    if (!IMAGE_BASE_URL) missing.push("IMAGE_BASE_URL");
  }
  if (needed.has("yt")) {
    if (!YT_CLIENT_ID) missing.push("YT_CLIENT_ID");
    if (!YT_CLIENT_SECRET) missing.push("YT_CLIENT_SECRET");
    if (!YT_REFRESH_TOKEN) missing.push("YT_REFRESH_TOKEN");
  }
  if (missing.length) {
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

// ---- YouTube helpers ----

// Exchange the long-lived refresh token for a short-lived access token.
async function youtubeAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `YouTube token refresh ${res.status}: ${body.error_description || body.error || "no access_token"}`
    );
  }
  return body.access_token;
}

const VIDEO_CONTENT_TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

function videoContentType(name) {
  return VIDEO_CONTENT_TYPES[path.extname(name || "").toLowerCase()] || "video/*";
}

// Resolve the video bytes for a queue item into a Buffer.
// Priority: item.video_url (download) -> VIDEO_BASE_URL + item.video (download)
//           -> local ./videos/<item.video> (read from disk).
async function resolveVideoBytes(item) {
  if (item.video_url) {
    const r = await fetch(item.video_url);
    if (!r.ok) throw new Error(`Fetch video_url ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  if (!item.video) throw new Error("no video / video_url");
  if (VIDEO_BASE_URL) {
    const url = `${VIDEO_BASE_URL.replace(/\/$/, "")}/${item.video}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Fetch ${url} -> ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const p = path.join(VIDEO_DIR, item.video);
  if (!fs.existsSync(p)) throw new Error(`video file not found: videos/${item.video}`);
  return fs.readFileSync(p);
}

// Pull #hashtags out of a caption -> ["bookkeeping", "smallbusiness", ...]
function tagsFromCaption(caption) {
  const matches = (caption || "").match(/#(\w+)/g) || [];
  return matches.map((t) => t.slice(1));
}

function firstLine(text) {
  return (text || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
}

// Build the snippet + status metadata for a YouTube upload.
function youtubeMetadata(item) {
  const caption = item.caption_yt || item.caption || item.description || "";
  const title = (item.title || firstLine(caption) || item.id).slice(0, 100);
  const description = item.description_yt || item.caption_yt || item.caption || "";
  const tags = Array.isArray(item.tags) ? item.tags : tagsFromCaption(caption);
  const categoryId = String(item.category_id || "27"); // 27 = Education

  const status = {
    privacyStatus: item.privacy || "public",
    selfDeclaredMadeForKids: item.made_for_kids === true,
  };

  // Native YouTube scheduling: upload now as private, let YouTube flip it public
  // at publish_at. Only valid for a future time.
  if (item.schedule_native && item.publish_at) {
    const when = new Date(item.publish_at).getTime();
    if (when > Date.now()) {
      status.privacyStatus = "private";
      status.publishAt = new Date(item.publish_at).toISOString();
    }
  }

  return {
    snippet: { title, description, tags, categoryId },
    status,
  };
}

// ---- YouTube: resumable upload (videos.insert) ----
async function postYouTube(item) {
  const accessToken = await youtubeAccessToken();
  const bytes = await resolveVideoBytes(item);
  const meta = youtubeMetadata(item);
  const contentType = videoContentType(item.video || item.video_url);

  // 1. Start a resumable session -- returns an upload URL in the Location header.
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(bytes.length),
        "X-Upload-Content-Type": contentType,
      },
      body: JSON.stringify(meta),
    }
  );
  if (!initRes.ok) {
    const t = await initRes.text();
    throw new Error(`YouTube init ${initRes.status}: ${t}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube: no resumable upload URL returned");

  // 2. Upload the actual bytes.
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  const upBody = await upRes.json().catch(() => ({}));
  if (!upRes.ok || !upBody.id) {
    throw new Error(
      `YouTube upload ${upRes.status}: ${upBody?.error?.message || "no video id"}`
    );
  }
  return {
    videoId: upBody.id,
    url: `https://youtu.be/${upBody.id}`,
    privacy: meta.status.privacyStatus,
    publishAt: meta.status.publishAt || null,
  };
}

// Validate a YouTube item WITHOUT calling any network APIs (used by DRY_RUN).
function dryCheckYouTube(item) {
  const problems = [];
  const meta = youtubeMetadata(item);
  if (!meta.snippet.title) problems.push("missing title");
  if (item.video_url) {
    // remote -- can't verify offline; assume ok
  } else if (item.video) {
    if (!VIDEO_BASE_URL && !fs.existsSync(path.join(VIDEO_DIR, item.video))) {
      problems.push(`video file not found: videos/${item.video}`);
    }
  } else {
    problems.push("no video / video_url");
  }
  if (problems.length) throw new Error(problems.join("; "));
  return { DRY_RUN: true, title: meta.snippet.title, privacy: meta.status.privacyStatus };
}

async function publishItem(item) {
  const platforms = platformsFor(item);
  if (!platforms.length) throw new Error(`Item ${item.id}: no platforms`);

  // Image URL is only needed for ig/fb.
  const needsImage = platforms.includes("ig") || platforms.includes("fb");
  const imageUrl = needsImage ? imageUrlFor(item) : null;
  if (needsImage && !imageUrl) throw new Error(`Item ${item.id}: no image / image_url`);

  const results = {};
  for (const p of platforms) {
    if (DRY_RUN) {
      results[p] = p === "yt" ? dryCheckYouTube(item) : "DRY_RUN";
      continue;
    }
    if (p === "ig") results.ig = await postInstagram(item, imageUrl);
    else if (p === "fb") results.fb = await postFacebook(item, imageUrl);
    else if (p === "yt") results.yt = await postYouTube(item);
    else throw new Error(`Unknown platform "${p}"`);
  }
  return results;
}

async function main() {
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

  requireEnv(due);
  log(`${due.length} post(s) due${DRY_RUN ? " [DRY RUN]" : ""}.`);

  for (const item of due) {
    try {
      const result = await publishItem(item);
      item.status = DRY_RUN ? "pending" : "posted";
      item.posted_at = new Date(now).toISOString();
      item.result = result;
      changed = true;
      log(`[ok] ${item.id} -> ${JSON.stringify(result)}`);
    } catch (err) {
      item.status = DRY_RUN ? "pending" : "failed";
      item.error = String(err.message || err);
      item.failed_at = new Date(now).toISOString();
      changed = true;
      log(`[x] ${item.id} ${DRY_RUN ? "WOULD FAIL" : "FAILED"}: ${item.error}`);
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
