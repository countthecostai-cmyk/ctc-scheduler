# Count The Cost — Social Scheduler

A tiny, self-hosted, **hands-off** scheduler that posts to **Instagram + Facebook** on a timetable — no Buffer, no Metricool, $0 to run. It uses GitHub Actions as the "clock" and the Meta Graph API to publish.

Once it's wired up, you drop posts into `queue.json`, set a date/time, and they go out on their own. You approve what's in the queue; the robot just presses "post" at the right moment.

---

## How it works (30-second version)

- **`queue.json`** — your posts: caption, image, date/time, and status.
- **`publish.js`** — the publisher. Wakes up, finds posts that are due, sends them to Instagram/Facebook, marks them `posted`.
- **`.github/workflows/scheduler.yml`** — the clock. Runs `publish.js` every 15 minutes.
- **`images/`** — the graphics, served publicly so Instagram can fetch them.

Nothing posts until you complete setup below. No secrets = nothing happens.

---

## One-time setup

### 1. Create the repository
- If you don't have a GitHub account yet, create a free one at github.com.
- Create a **new repository** named `ctc-scheduler`. It can be **public** (that's fine — your secrets are stored separately and are never exposed; the captions here are things you're about to post publicly anyway).
- Upload all the files in this folder (or `git push` them).

### 2. Add your secrets (this is the vault)
In the repo: **Settings → Secrets and variables → Actions → New repository secret.** Add these four. Paste them here and **nowhere else** — never in chat, never in the code:

| Secret name | What it is |
|---|---|
| `META_PAGE_TOKEN` | Your long-lived Facebook Page access token |
| `FB_PAGE_ID` | Your Facebook Page ID |
| `IG_BUSINESS_ID` | Your Instagram Business Account ID |
| `IMAGE_BASE_URL` | `https://raw.githubusercontent.com/<your-username>/ctc-scheduler/main/images` |

(Andre gets the first three during the token step — Claude will walk you through it live. The fourth is just the line above with your GitHub username filled in.)

### 3. Turn on the clock
- Go to the **Actions** tab and enable workflows if prompted.
- That's it. Every 15 minutes it checks the queue.

### 4. Test before trusting it
- Actions tab → **CTC Scheduler → Run workflow → check "Dry run" → Run.**
- A dry run logs what *would* post but sends nothing. When the log looks right, you're live.

---

## Adding a post

Add an object to `queue.json`:

```json
{
  "id": "unique-name",
  "platforms": ["ig", "fb"],
  "image": "my-graphic.png",
  "publish_at": "2026-07-25T13:00:00Z",
  "status": "pending",
  "caption": "Your caption here.\n\nWith line breaks and #hashtags."
}
```

- Put the image file in `images/`.
- `publish_at` is **UTC**. (9:00 AM US Eastern = `13:00Z` in summer / `14:00Z` in winter.)
- `platforms` can be `["ig"]`, `["fb"]`, or both.
- Want different wording per platform? Use `caption_ig` and `caption_fb` instead of `caption`.
- Leave `status` as `"pending"`. The robot flips it to `posted` or `failed`.

---

## Notes
- **This posts to your real accounts.** Test with a dry run first.
- Instagram requires a public image URL — that's why images live in this repo.
- If a post fails, its status becomes `failed` with an `error` note; fix and set it back to `pending`.
- The Page token lasts a long time but not forever; Claude will note when to refresh it.
