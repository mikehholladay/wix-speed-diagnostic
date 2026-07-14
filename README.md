# Wix Speed Self-Diagnostic

A single-page web app that measures a website's real performance with the Google
**PageSpeed Insights (PSI)** API, then turns the results into a **prioritized,
specific, Wix-aware action list** — with a per-fix estimated point impact, a
mark-complete → **re-run to measure the actual improvement** feedback loop,
**progress tracking over time**, and a **downloadable PDF report** + email-ready
summary.

No backend required. Everything runs in the browser; history is stored locally.

---

## Live app

**https://mikehholladay.github.io/wix-speed-diagnostic/**

Open it, paste your PageSpeed Insights API key once (stored only in your browser —
never uploaded or committed), and enter a website URL. Nothing to install.

## Quick start (local)

1. Copy `config.example.js` → `config.js` and paste your key (optional — you can also
   just paste it into the app UI). `config.js` is gitignored.
2. Serve the folder over HTTP (PSI + PDF need a real origin, not `file://`). On Windows
   you can use the included `serve.ps1` (`powershell -File serve.ps1`), or:

   ```bash
   # any of these, from this folder:
   npx serve .              # Node
   python -m http.server 8080   # Python 3
   ```

3. Open the printed URL, enter a website URL, and click **Run diagnostic**.

## How it works

- **Scan**: calls PSI for both **mobile** and **desktop** (`strategy`), pulling the
  performance score, **Core Web Vitals** (lab + real-user CrUX field data when
  available), and the underlying Lighthouse audits.
- **Prioritize**: maps audits to plain-language action items grouped by
  *Images / Apps / Third-party scripts / Server response / Custom code*, each with
  a specific, quantified sentence and an **estimated point impact**.
- **Attribute cost per app & per image**: PSI's `third-party-summary` gives
  per-entity blocking time + bytes ("this app costs you ~X ms / Y KB"), and the
  image audits give per-image savings ("this image is X MB; optimizing saves ~Y").
- **Feedback loop**: mark an action complete, make the change in Wix, republish,
  then **Re-run** — the tool records a new snapshot and shows the *actual* delta.
- **Progress**: every scan is a timestamped snapshot; a score-over-time chart shows
  momentum.
- **Report**: export a PDF breakdown, or generate an email-ready summary.

## About the point-impact numbers

Lighthouse does not hand out "points saved per fix," so those figures are
**transparent estimates** derived from each audit's reported time/byte savings and
the performance-score metric weights. They're for prioritization and motivation —
the **Re-run** delta is the source of truth.

## Wix reality check

Some generic PageSpeed advice isn't directly actionable on Wix (you don't control
the server/TTFB, bundling, or how the platform injects app scripts). The action
list flags what **you can actually change** (images you upload, apps you install,
marketing tags, custom code) versus what's platform-controlled, so you don't waste
effort chasing fixes you can't make.

## Security

The PSI key is read-only and quota-limited, but it's still a credential. It lives in
`config.js` (gitignored) or your browser's localStorage. **Restrict it** to the
PageSpeed Insights API with an HTTP-referrer restriction, or rotate it, in Google
Cloud Console. If you add a referrer restriction, allow both
`https://mikehholladay.github.io/*` (the hosted app) and `http://localhost:*` (local
testing) or the API calls will be rejected with a 403.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell / layout |
| `styles.css` | Styling |
| `app.js` | PSI client, audit→action mapping, scoring, history, PDF |
| `config.js` | Your API key (gitignored) |
| `config.example.js` | Template for `config.js` |
