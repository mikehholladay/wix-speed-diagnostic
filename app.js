/* Wix Speed Self-Diagnostic — all logic, no framework.
   Data: Google PageSpeed Insights v5 (Lighthouse 13 "insight" audits + CrUX field data).
   History + completed actions persist in localStorage. */
(() => {
  "use strict";

  // ---------- constants ----------
  const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
  const LAB = {
    lcp: "largest-contentful-paint",
    tbt: "total-blocking-time",
    cls: "cumulative-layout-shift",
    fcp: "first-contentful-paint",
    si: "speed-index",
  };
  // Lighthouse performance scoring weights + log-normal control points (mobile & desktop).
  const MET_W = { lcp: 0.25, fcp: 0.1, cls: 0.25, tbt: 0.3, si: 0.1 };
  const CP_MOBILE = { lcp: [2500, 4000], fcp: [1800, 3000], cls: [0.1, 0.25], tbt: [200, 600], si: [3387, 5800] };
  const CP_DESKTOP = { lcp: [1200, 2400], fcp: [934, 1600], cls: [0.1, 0.25], tbt: [150, 350], si: [1311, 2300] };
  const SQRT2 = Math.SQRT2;
  const ERFCINV = 0.9061938024368232; // |erfcinv(1.8)| → maps p10 to score 0.9

  const COL = { good: "#17c964", avg: "#f5a524", poor: "#f31260", muted: "#6c78a0", brand: "#6c8cff", brand2: "#8b6cff", grid: "#263156", text: "#eef2ff" };
  const LS = { key: "wsd_key", hist: "wsd_history", done: "wsd_completed" };
  const SIGNAL_FOR = { images: "imgWaste", apps: "tpMain", server: "serverMs", "dom-size": "domNodes", cls: "clsLab", "lcp-hero": "lcpLab", "unused-js": "unusedJs" };

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const fmtSec = (ms) => (ms / 1000).toFixed(ms < 9950 ? 1 : 0) + " s";
  const fmtMs = (ms) => (ms >= 1000 ? fmtSec(ms) : Math.round(ms) + " ms");
  const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? Math.round(b / 1024) + " KB" : Math.round(b) + " B");
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3600);
  }

  // ---------- state ----------
  const STATE = { key: "", url: "", urlKey: "", mobile: null, desktop: null, actions: [], filter: "all" };

  // ---------- API key ----------
  const resolveKey = () => store.get(LS.key, "") || (window.WIX_SPEED_CONFIG && window.WIX_SPEED_CONFIG.psiApiKey) || "";
  function refreshKeyStatus() {
    const el = $("keyStatus");
    if (STATE.key) { el.textContent = "✓ Key set (stored in this browser)."; el.className = "key-status ok"; }
    else { el.textContent = "No key yet — add one to run tests."; el.className = "key-status warn"; }
    $("keyBtn").textContent = STATE.key ? "🔑 Key set" : "🔑 Add API key";
  }

  // ---------- PSI fetch ----------
  async function runPSI(url, strategy, key) {
    const u = new URL(PSI);
    u.searchParams.set("url", url);
    u.searchParams.set("strategy", strategy);
    u.searchParams.append("category", "performance");
    if (key) u.searchParams.set("key", key);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try { res = await fetch(u.toString()); }
      catch { throw new Error("Network error contacting Google. Check your connection."); }
      if (res.ok) return res.json();
      let msg = "PageSpeed request failed (HTTP " + res.status + ").";
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch {}
      if (res.status === 403) msg = "Google rejected the request (403). Your API key may be invalid, or restricted to referrers that don't include this site. " + msg;
      else if (res.status === 400) msg = "Google couldn't analyze that URL (400). Make sure it's a public, reachable page. " + msg;
      else if (res.status === 429) msg = "Rate limit hit (429) — wait a minute and try again. " + msg;
      lastErr = new Error(msg); lastErr.status = res.status;
      if (res.status === 500 || res.status === 503) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw lastErr;
    }
    throw lastErr;
  }

  // ---------- parsing ----------
  function parse(json, strategy) {
    const lh = json.lighthouseResult || {};
    const audits = lh.audits || {};
    const scoreRaw = lh.categories && lh.categories.performance ? lh.categories.performance.score : null;
    const lab = {};
    for (const k in LAB) {
      const a = audits[LAB[k]];
      lab[k] = a ? { value: a.numericValue || 0, score: a.score, display: a.displayValue || "" } : null;
    }
    const le = json.loadingExperience || {};
    return {
      strategy,
      score: scoreRaw == null ? null : Math.round(scoreRaw * 100),
      lhVersion: lh.lighthouseVersion || "",
      audits, lab,
      field: fieldOf(le),
      fieldFallback: !!le.origin_fallback,
      fieldOverall: le.overall_category || null,
      finalUrl: lh.finalDisplayedUrl || lh.finalUrl || json.id || "",
    };
  }
  function fieldOf(src) {
    const m = (src && src.metrics) || null;
    if (!m || !Object.keys(m).length) return null;
    const g = (key) => (m[key] ? { p: m[key].percentile, cat: m[key].category } : null);
    return {
      LCP: g("LARGEST_CONTENTFUL_PAINT_MS"),
      INP: g("INTERACTION_TO_NEXT_PAINT"),
      CLS: g("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
      FCP: g("FIRST_CONTENTFUL_PAINT_MS"),
      TTFB: g("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
    };
  }

  // ---------- audit access (LH13 insights, with classic fallbacks) ----------
  const pick = (res, ...ids) => { for (const id of ids) if (res.audits[id]) return res.audits[id]; return null; };
  function savedBytes(a) {
    if (!a) return 0;
    const d = a.details || {};
    if (d.debugData && typeof d.debugData.wastedBytes === "number") return d.debugData.wastedBytes;
    if (typeof d.overallSavingsBytes === "number") return d.overallSavingsBytes;
    let s = 0; for (const it of d.items || []) s += it.wastedBytes || 0; return s;
  }
  const msav = (a, m) => (a && a.metricSavings && typeof a.metricSavings[m] === "number" ? a.metricSavings[m] : 0);

  function imageList(res) {
    const a = pick(res, "image-delivery-insight", "uses-optimized-images", "modern-image-formats", "uses-responsive-images");
    const items = (a && a.details && a.details.items) || [];
    return items
      .map((it) => ({ url: it.url || (it.node && it.node.url) || "(image)", total: it.totalBytes || 0, waste: it.wastedBytes || 0 }))
      .filter((x) => x.total > 0 || x.waste > 0)
      .sort((x, y) => y.waste - x.waste || y.total - x.total);
  }
  const entityName = (e) => (typeof e === "string" ? e : (e && (e.text || e.url)) || "Unknown");
  function thirdPartyList(res) {
    const a = pick(res, "third-parties-insight", "third-party-summary");
    const items = (a && a.details && a.details.items) || [];
    return items
      .map((it) => ({ name: entityName(it.entity), main: it.mainThreadTime || it.blockingTime || 0, bytes: it.transferSize || 0 }))
      .filter((x) => x.main > 0 || x.bytes > 0)
      .sort((x, y) => y.main - x.main || y.bytes - x.bytes);
  }
  function domNodes(res) {
    const a = pick(res, "dom-size-insight", "dom-size");
    if (!a) return 0;
    for (const it of (a.details && a.details.items) || []) {
      if (String(it.statistic || "").toLowerCase().includes("total element")) {
        const v = it.value; return v && typeof v === "object" ? v.value : typeof v === "number" ? v : 0;
      }
    }
    return a.numericValue || 0;
  }
  function currentMetrics(res) {
    const g = (id) => (res.audits[id] ? res.audits[id].numericValue : null);
    return { lcp: g(LAB.lcp), tbt: g(LAB.tbt), cls: g(LAB.cls), fcp: g(LAB.fcp), si: g(LAB.si) };
  }
  function signals(res) {
    const tp = thirdPartyList(res);
    return {
      imgWaste: savedBytes(pick(res, "image-delivery-insight", "uses-optimized-images")),
      tpMain: tp.reduce((s, x) => s + x.main, 0),
      tpBytes: tp.reduce((s, x) => s + x.bytes, 0),
      unusedJs: savedBytes(pick(res, "unused-javascript")),
      serverMs: (pick(res, "server-response-time") || {}).numericValue || 0,
      domNodes: domNodes(res),
      clsLab: (res.lab.cls && res.lab.cls.value) || 0,
      lcpLab: (res.lab.lcp && res.lab.lcp.value) || 0,
    };
  }

  // ---------- score-impact estimate (Lighthouse's own log-normal math) ----------
  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + z / 2);
    const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? ans : 2 - ans;
  }
  function metricScore(value, p10, median) {
    if (value == null || median <= 0 || p10 <= 0) return null;
    const loc = Math.log(median);
    const shape = Math.abs(Math.log(p10) - loc) / (SQRT2 * ERFCINV);
    if (!shape) return null;
    const z = (Math.log(Math.max(value, 1e-9)) - loc) / (SQRT2 * shape);
    return clamp(0.5 * erfc(z), 0, 1);
  }
  // Points a fix could add, from an audit's metricSavings (ms) and current metric values.
  function estPoints(cur, cp, savings) {
    if (!savings) return 0;
    let pts = 0;
    for (const m of ["lcp", "fcp", "cls", "tbt"]) {
      const s = savings[m.toUpperCase()] || 0;
      if (s <= 0) continue;
      const c = cur[m]; if (c == null) continue;
      const [p10, med] = cp[m];
      const s0 = metricScore(c, p10, med), s1 = metricScore(Math.max(0, c - s), p10, med);
      if (s0 == null || s1 == null) continue;
      pts += Math.max(0, s1 - s0) * MET_W[m] * 100;
    }
    return Math.round(pts);
  }

  // ---------- action catalog ----------
  function buildActions(res) {
    const cur = currentMetrics(res);
    const cp = res.strategy === "desktop" ? CP_DESKTOP : CP_MOBILE;
    const estp = (a) => estPoints(cur, cp, a && a.metricSavings);
    const out = [];
    const ptDisp = (n) => ({ big: "~" + n, small: "est. pts" });
    const msDisp = (ms) => ({ big: fmtMs(ms), small: "main-thread" });
    const infoDisp = () => ({ big: "•", small: "info" });

    // Images
    const imgA = pick(res, "image-delivery-insight", "uses-optimized-images", "modern-image-formats");
    const imgs = imageList(res);
    const imgWaste = savedBytes(imgA);
    if (imgWaste > 15 * 1024 || imgs.length > 2) {
      const top = imgs[0], pts = estp(imgA);
      out.push({
        key: "images", category: "images", who: "you",
        title: "Right-size and compress your images",
        detail: `Your images could be about ${fmtBytes(imgWaste)} lighter across ${imgs.length || "several"} file${imgs.length === 1 ? "" : "s"}.` +
          (top ? ` Biggest: ${shortUrl(top.url)} — ${fmtBytes(top.total)}${top.waste ? `, ~${fmtBytes(top.waste)} recoverable` : ""}.` : ""),
        fix: "Wix already auto-serves modern AVIF and lazy-loads below-the-fold images, so <b>don't convert formats</b> — just upload smaller. Export images near the size they actually display (don't drop a 4000px original into a 600px slot), and focus on your <b>hero</b>, which loads eagerly.",
        disp: pts >= 1 ? ptDisp(pts) : ptDisp(0), rank: pts + imgWaste / 40000,
      });
    }

    // LCP hero
    if (res.lab.lcp && res.lab.lcp.score != null && res.lab.lcp.score < 0.9) {
      const lcpA = pick(res, "lcp-discovery-insight", "lcp-breakdown-insight");
      const pts = Math.max(estp(lcpA), estp(imgA) ? 0 : 0);
      out.push({
        key: "lcp-hero", category: "images", who: "you",
        title: "Speed up your largest above-the-fold element (LCP)",
        detail: `Your Largest Contentful Paint is ${res.lab.lcp.display || fmtMs(res.lab.lcp.value)} (good is under 2.5 s). It's the first big thing visitors wait for.`,
        fix: "Lighten your hero: avoid full-screen video/animated backgrounds, pre-size the hero image, or use a text + button hero. Wix does <b>not</b> lazy-load above the fold, so the hero is usually your LCP.",
        disp: pts >= 1 ? ptDisp(pts) : { big: res.lab.lcp.display || fmtMs(res.lab.lcp.value), small: "current LCP" },
        rank: (pts || 8) + 2,
      });
    }

    // Apps / third parties
    const tp = thirdPartyList(res);
    const tpMain = tp.reduce((s, x) => s + x.main, 0);
    const tpBytes = tp.reduce((s, x) => s + x.bytes, 0);
    if (tp.length && (tpMain > 80 || tpBytes > 80 * 1024)) {
      out.push({
        key: "apps", category: "apps", who: "you",
        title: "Cut third-party apps & marketing tags",
        detail: `${tp.length} third-party provider${tp.length > 1 ? "s" : ""} run ~${fmtMs(tpMain)} of work on the main thread and download ${fmtBytes(tpBytes)}.` +
          (tp[0] ? ` Heaviest: ${esc(tp[0].name)} (~${fmtMs(tp[0].main)}, ${fmtBytes(tp[0].bytes)}).` : ""),
        fix: "In <b>Editor ▸ My Business</b> and <b>Dashboard ▸ Manage Apps</b>, remove apps you don't actively use (cancel any paid subscription first). Move heavy apps (chat, booking, social feeds) off the homepage. Use Wix's built-in <b>Marketing Integrations</b> for GA4 / Meta Pixel instead of pasted tags. Main-thread time is the biggest driver of Total Blocking Time — <b>30% of your score</b> — so this is often your single biggest lever, even though Google can't attribute exact points here. See the per-app breakdown below.",
        disp: msDisp(tpMain), rank: 60 + tpMain / 25,
      });
    }

    // JS execution / bootup (carries a real TBT saving)
    const bootup = pick(res, "bootup-time");
    if (bootup && (msav(bootup, "TBT") > 0 || (res.lab.tbt && res.lab.tbt.score != null && res.lab.tbt.score < 0.5))) {
      const pts = estp(bootup);
      out.push({
        key: "js-exec", category: "apps", who: "partial",
        title: "Reduce JavaScript execution time",
        detail: `The browser spends ${bootup.displayValue || fmtMs(bootup.numericValue || 0)} running JavaScript. Total Blocking Time is ${res.lab.tbt ? (res.lab.tbt.display || fmtMs(res.lab.tbt.value)) : "high"} (good is under 200 ms).`,
        fix: "This is mostly driven by installed apps and any <b>Velo</b> custom code. Remove unused apps, and move heavy Velo logic to the backend so less runs in the visitor's browser.",
        disp: pts >= 1 ? ptDisp(pts) : msDisp(bootup.numericValue || 0), rank: (pts || 20) + 5,
      });
    }

    // Layout shift
    if (res.lab.cls && res.lab.cls.value > 0.1) {
      const clsA = pick(res, "cls-culprits-insight");
      const pts = estp(clsA) || estPoints(cur, cp, { CLS: Math.max(0, res.lab.cls.value - 0.1) });
      out.push({
        key: "cls", category: "code", who: "partial",
        title: "Stop content from shifting as it loads (CLS)",
        detail: `Your Cumulative Layout Shift is ${res.lab.cls.display || res.lab.cls.value.toFixed(2)} (good is under 0.10) — things jump around while loading.`,
        fix: "Give images/videos fixed sizes, avoid inserting banners or app widgets above existing content, and keep custom fonts from swapping in late.",
        disp: pts >= 1 ? ptDisp(pts) : infoDisp(), rank: (pts || 5) + 1,
      });
    }

    // DOM size
    const dom = domNodes(res);
    if (dom > 1400) {
      out.push({
        key: "dom-size", category: "code", who: "partial",
        title: "Simplify a heavy page",
        detail: `This page has ${Math.round(dom).toLocaleString()} elements — large pages are slower to render, lay out, and stay responsive.`,
        fix: "Use fewer sections/columns/boxes, split very long pages, and delete unused strips and hidden elements.",
        disp: infoDisp(), rank: 4,
      });
    }

    // Fonts
    const fontA = pick(res, "font-display-insight", "font-display");
    if (fontA && fontA.score != null && fontA.score < 1) {
      const pts = estp(fontA);
      out.push({
        key: "fonts", category: "code", who: "you",
        title: "Trim and speed up your fonts",
        detail: "Custom fonts are delaying when your text becomes visible.",
        fix: "Reduce to <b>3–4 fonts max</b> and prefer system fonts. Each extra custom font is another download that can delay your text appearing.",
        disp: pts >= 1 ? ptDisp(pts) : infoDisp(), rank: (pts || 3) + 1,
      });
    }

    // Render-blocking (mostly Wix)
    const rbA = pick(res, "render-blocking-insight", "render-blocking-resources");
    if (rbA && (msav(rbA, "FCP") > 0 || msav(rbA, "LCP") > 0)) {
      const pts = estp(rbA);
      if (pts >= 1) out.push({
        key: "render-blocking", category: "code", who: "wix",
        title: "Render-blocking resources",
        detail: `Blocking requests are delaying first paint${rbA.displayValue ? " (" + esc(rbA.displayValue) + ")" : ""}.`,
        fix: "Mostly Wix's own framework files (static.parastorage.com) you can't edit. For custom code <em>you</em> added, add <b>defer</b> and place it in 'Body - end'.",
        disp: ptDisp(pts), rank: pts,
      });
    }

    // Unused JS
    const ujBytes = savedBytes(pick(res, "unused-javascript"));
    if (ujBytes > 120 * 1024) {
      out.push({
        key: "unused-js", category: "code", who: "partial",
        title: "Reduce unused JavaScript",
        detail: `About ${fmtBytes(ujBytes)} of downloaded JavaScript isn't used on load.`,
        fix: "Much of this is Wix platform + app code you can't remove. The part you control: <b>uninstall unused apps</b> (see the app breakdown).",
        disp: infoDisp(), rank: 2,
      });
    }

    // Cache (partly controllable via Wix caching settings)
    const cacheA = pick(res, "cache-insight", "uses-long-cache-ttl");
    const cacheBytes = savedBytes(cacheA);
    if (cacheBytes > 150 * 1024) {
      out.push({
        key: "cache", category: "server", who: "partial",
        title: "Serve static assets with efficient caching",
        detail: `Assets worth ${fmtBytes(cacheBytes)} could be cached longer for repeat visits.`,
        fix: "Enable page caching in <b>Dashboard ▸ Website Performance Settings</b> and per-page under Advanced Settings. Wix controls the underlying cache headers themselves.",
        disp: infoDisp(), rank: 1.5,
      });
    }

    // Server response (platform)
    const srv = pick(res, "server-response-time");
    const serverMs = (srv && srv.numericValue) || 0;
    if (serverMs > 600) {
      const pts = estp(srv);
      out.push({
        key: "server", category: "server", who: "wix",
        title: "Slow initial server response (TTFB)",
        detail: `Your server's first response took ${fmtMs(serverMs)} (Google's target is under 600 ms).`,
        fix: "TTFB on Wix is platform-controlled — you can't add a CDN or tune the server. What you can do: enable caching and re-test a while after publishing, since the first visit after a publish is uncached.",
        disp: pts >= 1 ? ptDisp(pts) : infoDisp(), rank: (pts || 3),
      });
    }

    return out;
  }
  function shortUrl(u) { try { const x = new URL(u); return esc(x.pathname.split("/").pop() || x.hostname); } catch { return esc(String(u).slice(0, 48)); } }

  const rankWho = { you: 0, partial: 1, wix: 2 };
  function sortActions(actions, doneMap) {
    return actions.slice().sort((a, b) => {
      const da = doneMap[a.key] ? 1 : 0, db = doneMap[b.key] ? 1 : 0;
      if (da !== db) return da - db;
      if (rankWho[a.who] !== rankWho[b.who]) return rankWho[a.who] - rankWho[b.who];
      return (b.rank || 0) - (a.rank || 0);
    });
  }

  // ---------- rendering ----------
  function gaugeSVG(score) {
    const s = score == null ? null : Math.round(score);
    const col = s == null ? COL.muted : s >= 90 ? COL.good : s >= 50 ? COL.avg : COL.poor;
    const r = 46, c = 2 * Math.PI * r, off = s == null ? c : c * (1 - s / 100);
    return `<svg class="gauge" width="112" height="112" viewBox="0 0 112 112" role="img" aria-label="Score ${s == null ? "unavailable" : s}">
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="#0a0f22" stroke-width="10"/>
      <circle cx="56" cy="56" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 56 56)"/>
      <text x="56" y="53" text-anchor="middle" font-size="30" font-weight="800" fill="${col}">${s == null ? "—" : s}</text>
      <text x="56" y="72" text-anchor="middle" font-size="11" fill="${COL.muted}">/ 100</text>
    </svg>`;
  }
  function scoreCard(res, label, prev) {
    if (!res) return `${gaugeSVG(null)}<div class="score-meta"><h3>${label}</h3><p class="muted small">Couldn't measure.</p></div>`;
    let delta = "";
    if (prev != null && res.score != null) {
      const d = res.score - prev;
      const cls = d > 0 ? "delta-up" : d < 0 ? "delta-down" : "delta-flat";
      delta = `<div class="score-delta ${cls}">${d > 0 ? "▲ +" + d : d < 0 ? "▼ " + d : "no change"} since last run</div>`;
    }
    return `${gaugeSVG(res.score)}<div class="score-meta"><h3>${label}</h3><div class="muted small">Performance score</div>${delta}</div>`;
  }

  const catBand = (cat) => (cat == null ? "" : cat === "FAST" ? "good" : cat === "AVERAGE" ? "avg" : "poor");
  const labBand = (score) => (score == null ? "" : score >= 0.9 ? "good" : score >= 0.5 ? "avg" : "poor");

  function renderCWV(res) {
    const src = $("cwvSource"), note = $("cwvNote"), grid = $("cwvGrid");
    let items = [];
    if (res.field) {
      src.textContent = res.fieldFallback ? "Real users · origin (CrUX)" : "Real users (CrUX, 28-day)";
      note.textContent = "This is real-visitor data from Chrome — the number Wix and Google say to prioritize over the lab score. Green here means real users are having a good experience even if the lab score looks low.";
      const f = res.field, mk = (k, label, fmt) => { if (!f[k]) return; items.push({ band: catBand(f[k].cat), label, val: fmt(f[k].p), sub: (f[k].cat || "").toLowerCase() }); };
      mk("LCP", "LCP", (p) => fmtSec(p)); mk("INP", "INP", (p) => Math.round(p) + " ms");
      mk("CLS", "CLS", (p) => (p / 100).toFixed(2)); mk("FCP", "FCP", (p) => fmtSec(p)); mk("TTFB", "TTFB", (p) => fmtMs(p));
    } else {
      src.textContent = "Lab (simulated)";
      note.textContent = "No real-user data available yet for this URL, so these are Lighthouse's simulated lab metrics on a throttled phone.";
      const mk = (k, label) => { const a = res.lab[k]; if (!a) return; items.push({ band: labBand(a.score), label, val: a.display || fmtMs(a.value), sub: "lab" }); };
      mk("lcp", "LCP"); mk("tbt", "TBT"); mk("cls", "CLS"); mk("fcp", "FCP"); mk("si", "Speed Index");
    }
    grid.innerHTML = items.length ? items.map((i) => `<div class="cwv-item ${i.band}"><div class="k">${i.label}</div><div class="v">${esc(i.val)}</div><div class="sub">${esc(i.sub)}</div></div>`).join("") : `<p class="empty">No Core Web Vitals returned.</p>`;
  }

  function whoChip(who) {
    return who === "you" ? `<span class="chip you">You can fix this</span>`
      : who === "partial" ? `<span class="chip">Partly in your control</span>`
      : `<span class="chip wix">Wix-controlled · limited</span>`;
  }
  function renderActions() {
    const doneMap = getDone(), hist = getHistory();
    const prevSig = hist.length >= 2 ? hist[hist.length - 2].signals : null;
    const curSig = hist.length ? hist[hist.length - 1].signals : null;
    const visible = sortActions(STATE.actions, doneMap).filter((a) => STATE.filter === "all" || a.category === STATE.filter);
    const list = $("actionList");
    if (!visible.length) { list.innerHTML = `<li class="empty">No action items in this category — nice.</li>`; return; }
    list.innerHTML = visible.map((a) => {
      const done = !!doneMap[a.key];
      let confirmed = "";
      const sf = SIGNAL_FOR[a.key];
      if (done && sf && prevSig && curSig && prevSig[sf] > 0) {
        const drop = (prevSig[sf] - curSig[sf]) / prevSig[sf];
        if (drop > 0.05) confirmed = `<div class="confirmed">✓ Confirmed: −${Math.round(drop * 100)}% since last run</div>`;
      }
      return `<li class="action ${done ? "done" : ""}" data-key="${a.key}">
        <input class="action-check" type="checkbox" ${done ? "checked" : ""} aria-label="Mark done" />
        <div>
          <p class="action-title">${esc(a.title)} ${whoChip(a.who)}</p>
          <p class="action-detail">${a.detail}</p>
          <p class="action-fix"><b>Fix:</b> ${a.fix}</p>${confirmed}
        </div>
        <div class="action-impact"><div class="impact-pts">${esc(a.disp.big)}</div><div class="impact-lbl">${esc(a.disp.small)}</div></div>
      </li>`;
    }).join("");
    list.querySelectorAll(".action-check").forEach((cb) => cb.addEventListener("change", (e) => {
      const key = e.target.closest(".action").dataset.key, m = getDone();
      if (e.target.checked) m[key] = true; else delete m[key];
      setDone(m); renderActions();
      if (e.target.checked) toast("Marked done — make the change in Wix, then hit Re-run to measure it.");
    }));
  }
  function renderFilters() {
    const cats = [["all", "All"], ["images", "Images"], ["apps", "Apps & scripts"], ["code", "Code & layout"], ["server", "Server"]];
    const box = $("actionFilters");
    box.innerHTML = cats.map(([c, l]) => `<button class="filter-btn ${STATE.filter === c ? "active" : ""}" data-cat="${c}">${l}</button>`).join("");
    box.querySelectorAll(".filter-btn").forEach((b) => b.addEventListener("click", () => { STATE.filter = b.dataset.cat; renderFilters(); renderActions(); }));
  }

  function barRows(rows, valFmt) {
    if (!rows.length) return `<p class="empty">Nothing significant detected. 🎉</p>`;
    const max = Math.max(...rows.map((r) => r.val)) || 1;
    return rows.map((r) => `<div><div class="bar-row"><span class="name">${esc(r.name)}</span><span class="bar-val">${valFmt(r)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${clamp((r.val / max) * 100, 3, 100).toFixed(0)}%"></div></div></div>`).join("");
  }
  function renderThirdParty(res) {
    const tp = thirdPartyList(res).slice(0, 8);
    $("thirdPartyBox").innerHTML = barRows(tp.map((t) => ({ name: t.name, val: t.main, bytes: t.bytes })), (r) => `${fmtMs(r.val)} · ${fmtBytes(r.bytes)}`);
  }
  function renderImages(res) {
    const imgs = imageList(res).slice(0, 8);
    $("imagesBox").innerHTML = barRows(imgs.map((i) => ({ name: shortUrl(i.url), val: i.waste || i.total, total: i.total, waste: i.waste })),
      (r) => `${fmtBytes(r.total)}${r.waste ? " · save " + fmtBytes(r.waste) : ""}`);
  }

  // ---------- chart ----------
  function buildChartSVG(snaps, w, h) {
    const pad = { l: 34, r: 12, t: 16, b: 22 }, iw = w - pad.l - pad.r, ih = h - pad.t - pad.b, n = snaps.length;
    const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => pad.t + ih - (v / 100) * ih;
    const line = (sel, col) => {
      const pts = snaps.map((s, i) => (s[sel] == null ? null : [x(i), y(s[sel])])).filter(Boolean);
      if (!pts.length) return "";
      const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
      return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.5"/>` + pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="${col}"/>`).join("");
    };
    const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${pad.l}" y1="${y(v).toFixed(1)}" x2="${w - pad.r}" y2="${y(v).toFixed(1)}" stroke="${COL.grid}" stroke-width="1"/><text x="${pad.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${COL.muted}">${v}</text>`).join("");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${w}" height="${h}" fill="#0e1428"/>${grid}${line("mobile", COL.brand)}${line("desktop", COL.brand2)}
      <g font-size="10"><rect x="${pad.l}" y="3" width="9" height="9" fill="${COL.brand}"/><text x="${pad.l + 13}" y="11" fill="${COL.text}">Mobile</text>
      <rect x="${pad.l + 64}" y="3" width="9" height="9" fill="${COL.brand2}"/><text x="${pad.l + 77}" y="11" fill="${COL.text}">Desktop</text></g></svg>`;
  }
  function renderChart() {
    const snaps = getHistory(), box = $("chartBox");
    if (!snaps.length) { box.innerHTML = `<p class="empty">Run a scan to start tracking.</p>`; return; }
    if (snaps.length < 2) { box.innerHTML = `<p class="empty">One scan recorded. Make a change and Re-run to grow your trend line.</p>`; return; }
    box.innerHTML = buildChartSVG(snaps, 900, 220);
  }
  function renderHistory() {
    const snaps = getHistory().slice().reverse(), box = $("historyTable");
    if (!snaps.length) { box.innerHTML = ""; return; }
    const rows = snaps.map((s, idx) => {
      const older = snaps[idx + 1];
      const d = older && s.mobile != null && older.mobile != null ? s.mobile - older.mobile : null;
      const dcell = d == null ? "—" : `<span class="${d > 0 ? "delta-up" : d < 0 ? "delta-down" : "delta-flat"}">${d > 0 ? "+" + d : d}</span>`;
      return `<tr><td>${new Date(s.ts).toLocaleString()}</td><td class="num">${s.mobile ?? "—"}</td><td class="num">${s.desktop ?? "—"}</td><td class="num">${s.signals && s.signals.lcpLab ? fmtSec(s.signals.lcpLab) : "—"}</td><td class="num">${dcell}</td></tr>`;
    }).join("");
    box.innerHTML = `<table class="hist"><thead><tr><th>When</th><th class="num">Mobile</th><th class="num">Desktop</th><th class="num">LCP (lab)</th><th class="num">Δ mobile</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ---------- storage (per URL) ----------
  const normalizeUrl = (raw) => { let u = raw.trim(); if (!/^https?:\/\//i.test(u)) u = "https://" + u; return u; };
  const getHistory = () => store.get(LS.hist, {})[STATE.urlKey] || [];
  function pushSnapshot(snap) { const all = store.get(LS.hist, {}); (all[STATE.urlKey] = all[STATE.urlKey] || []).push(snap); if (all[STATE.urlKey].length > 50) all[STATE.urlKey] = all[STATE.urlKey].slice(-50); store.set(LS.hist, all); }
  const getDone = () => store.get(LS.done, {})[STATE.urlKey] || {};
  function setDone(m) { const all = store.get(LS.done, {}); all[STATE.urlKey] = m; store.set(LS.done, all); }

  // ---------- main flow ----------
  async function runDiagnostic(rawUrl) {
    STATE.key = resolveKey();
    if (!STATE.key) { openKeyPanel("Add your PageSpeed Insights API key first — it's free."); return; }
    const url = normalizeUrl(rawUrl);
    STATE.url = url; STATE.urlKey = url.toLowerCase();
    $("urlInput").value = url; $("runError").hidden = true;
    setBusy(true, "Contacting Google PageSpeed Insights… (mobile + desktop, ~15–40s)");
    try {
      const [m, d] = await Promise.allSettled([runPSI(url, "mobile", STATE.key), runPSI(url, "desktop", STATE.key)]);
      if (m.status === "rejected" && d.status === "rejected") throw m.reason;
      STATE.mobile = m.status === "fulfilled" ? parse(m.value, "mobile") : null;
      STATE.desktop = d.status === "fulfilled" ? parse(d.value, "desktop") : null;
      const base = STATE.mobile || STATE.desktop;
      STATE.actions = buildActions(base);

      const prev = getHistory();
      const prevMobile = prev.length ? prev[prev.length - 1].mobile : null;
      const prevDesktop = prev.length ? prev[prev.length - 1].desktop : null;
      pushSnapshot({ ts: Date.now(), url, mobile: STATE.mobile ? STATE.mobile.score : null, desktop: STATE.desktop ? STATE.desktop.score : null, signals: signals(base) });

      renderAll(prevMobile, prevDesktop);
      $("results").hidden = false;
      $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      $("runError").textContent = err.message || String(err); $("runError").hidden = false;
    } finally { setBusy(false); }
  }
  function renderAll(prevMobile, prevDesktop) {
    const base = STATE.mobile || STATE.desktop;
    $("scoreMobile").innerHTML = scoreCard(STATE.mobile, "📱 Mobile", prevMobile);
    $("scoreDesktop").innerHTML = scoreCard(STATE.desktop, "💻 Desktop", prevDesktop);
    renderCWV(base); renderFilters(); renderActions();
    renderThirdParty(base); renderImages(base); renderChart(); renderHistory();
  }
  function setBusy(on, msg) {
    $("loading").hidden = !on;
    if (msg) $("loadingMsg").textContent = msg;
    $("runBtn").disabled = on; if ($("rerunBtn")) $("rerunBtn").disabled = on;
  }

  // ---------- summary (email / copy) ----------
  const stripTags = (s) => String(s).replace(/<[^>]+>/g, "");
  function summaryText() {
    const m = STATE.mobile, d = STATE.desktop, lines = [];
    lines.push(`Site speed report — ${STATE.url}`, `Generated ${new Date().toLocaleString()}`, "");
    lines.push(`Mobile score:  ${m && m.score != null ? m.score + "/100" : "n/a"}`);
    lines.push(`Desktop score: ${d && d.score != null ? d.score + "/100" : "n/a"}`, "");
    lines.push("Top things YOU can fix (highest impact first):");
    sortActions(STATE.actions, getDone()).filter((a) => a.who !== "wix").slice(0, 6).forEach((a, i) => {
      lines.push(`  ${i + 1}. [${a.disp.big} ${a.disp.small}] ${a.title}`, `      ${stripTags(a.detail)}`);
    });
    lines.push("", "Point estimates are approximate — re-run the diagnostic after each change to see the real gain.");
    return lines.join("\n");
  }

  // ---------- PDF ----------
  async function downloadPDF() {
    if (!window.jspdf || !window.jspdf.jsPDF) { toast("PDF library didn't load (needs internet)."); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const autotable = (opts) => (typeof doc.autoTable === "function" ? doc.autoTable(opts) : window.autoTable(doc, opts));
    const M = 40, PH = doc.internal.pageSize.getHeight();
    const m = STATE.mobile, d = STATE.desktop, base = m || d;
    let y = 170;
    const ensure = (need) => { if (y > PH - (need || 120)) { doc.addPage(); y = 54; } };

    doc.setFontSize(20); doc.setTextColor(20, 25, 45); doc.text("Website Speed Report", M, 54);
    doc.setFontSize(11); doc.setTextColor(90, 100, 130); doc.text(STATE.url, M, 74); doc.text("Generated " + new Date().toLocaleString(), M, 90);
    doc.setFontSize(30); doc.setTextColor(...bandColor(m && m.score)); doc.text(String(m && m.score != null ? m.score : "—"), M, 132);
    doc.setFontSize(10); doc.setTextColor(90, 100, 130); doc.text("Mobile / 100", M, 146);
    doc.setFontSize(30); doc.setTextColor(...bandColor(d && d.score)); doc.text(String(d && d.score != null ? d.score : "—"), M + 130, 132);
    doc.setFontSize(10); doc.setTextColor(90, 100, 130); doc.text("Desktop / 100", M + 130, 146);

    const cwv = cwvRows(base);
    if (cwv.length) { autotable({ startY: y, head: [["Core Web Vital", "Value", "Status"]], body: cwv, margin: { left: M, right: M }, headStyles: { fillColor: [108, 140, 255] }, styles: { fontSize: 9 } }); y = doc.lastAutoTable.finalY + 18; }

    const actRows = sortActions(STATE.actions, getDone()).map((a, i) => [String(i + 1), a.title, whoLabel(a.who), a.disp.big + " " + a.disp.small, stripTags(a.detail)]);
    autotable({ startY: y, head: [["#", "Action", "Who", "Impact", "Details"]], body: actRows, margin: { left: M, right: M }, headStyles: { fillColor: [108, 140, 255] }, styles: { fontSize: 8, cellPadding: 3 }, columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 118 }, 2: { cellWidth: 54 }, 3: { cellWidth: 56 }, 4: { cellWidth: "auto" } } });
    y = doc.lastAutoTable.finalY + 18;

    const tp = thirdPartyList(base).slice(0, 10).map((t) => [t.name, fmtMs(t.main), fmtBytes(t.bytes)]);
    if (tp.length) { ensure(); autotable({ startY: y, head: [["Third-party provider", "Main-thread", "Size"]], body: tp, margin: { left: M, right: M }, headStyles: { fillColor: [139, 108, 255] }, styles: { fontSize: 8 } }); y = doc.lastAutoTable.finalY + 18; }
    const im = imageList(base).slice(0, 10).map((i) => [shortUrlPlain(i.url), fmtBytes(i.total), i.waste ? fmtBytes(i.waste) : "—"]);
    if (im.length) { ensure(); autotable({ startY: y, head: [["Heaviest images", "Size", "Potential saving"]], body: im, margin: { left: M, right: M }, headStyles: { fillColor: [139, 108, 255] }, styles: { fontSize: 8 } }); y = doc.lastAutoTable.finalY + 18; }

    const snaps = getHistory();
    if (snaps.length >= 2) {
      try {
        const png = await svgToPng(buildChartSVG(snaps, 520, 200), 520, 200, 2);
        ensure(230); doc.setFontSize(12); doc.setTextColor(20, 25, 45); doc.text("Score over time", M, y); y += 10; doc.addImage(png, "PNG", M, y, 520, 200); y += 210;
      } catch {}
    }
    doc.setFontSize(8); doc.setTextColor(140, 148, 170);
    doc.text("Point-impact figures are estimates (Lighthouse's own scoring math). The re-run delta is the source of truth.", M, PH - 24);
    doc.save("wix-speed-report-" + hostSlug(STATE.url) + ".pdf");
  }
  function cwvRows(res) {
    const rows = [];
    if (res.field) {
      const f = res.field, add = (k, l, fmt) => { if (f[k]) rows.push([l, fmt(f[k].p), (f[k].cat || "").toLowerCase()]); };
      add("LCP", "LCP (real users)", (p) => fmtSec(p)); add("INP", "INP", (p) => Math.round(p) + " ms");
      add("CLS", "CLS", (p) => (p / 100).toFixed(2)); add("FCP", "FCP", (p) => fmtSec(p)); add("TTFB", "TTFB", (p) => fmtMs(p));
    } else {
      const add = (k, l) => { const a = res.lab[k]; if (a) rows.push([l + " (lab)", a.display || fmtMs(a.value), a.score >= 0.9 ? "good" : a.score >= 0.5 ? "avg" : "poor"]); };
      add("lcp", "LCP"); add("tbt", "TBT"); add("cls", "CLS"); add("fcp", "FCP"); add("si", "Speed Index");
    }
    return rows;
  }
  const whoLabel = (w) => (w === "you" ? "You" : w === "partial" ? "Partly you" : "Wix");
  const bandColor = (s) => (s == null ? [108, 120, 160] : s >= 90 ? [23, 201, 100] : s >= 50 ? [217, 145, 20] : [243, 18, 96]);
  const shortUrlPlain = (u) => { try { const x = new URL(u); return x.pathname.split("/").pop() || x.hostname; } catch { return String(u).slice(0, 40); } };
  const hostSlug = (u) => { try { return new URL(u).hostname.replace(/\W+/g, "-"); } catch { return "site"; } };

  function svgToPng(svg, w, h, scale) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = w * scale; canvas.height = h * scale;
        const ctx = canvas.getContext("2d"); ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        try { resolve(canvas.toDataURL("image/png")); } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("svg raster failed")); };
      img.src = url;
    });
  }

  // ---------- key panel + init ----------
  function openKeyPanel(msg) { $("keyPanel").hidden = false; $("keyInput").focus(); if (msg) { const s = $("keyStatus"); s.textContent = msg; s.className = "key-status warn"; } $("keyPanel").scrollIntoView({ behavior: "smooth" }); }
  function init() {
    STATE.key = resolveKey(); refreshKeyStatus();
    if (!STATE.key) $("keyPanel").hidden = false;

    $("keyBtn").addEventListener("click", () => { $("keyPanel").hidden = !$("keyPanel").hidden; if (!$("keyPanel").hidden) $("keyInput").focus(); });
    $("keySave").addEventListener("click", () => {
      const v = $("keyInput").value.trim(); if (!v) { toast("Paste a key first."); return; }
      store.set(LS.key, v); STATE.key = v; $("keyInput").value = ""; refreshKeyStatus(); toast("Key saved in this browser."); $("keyPanel").hidden = true;
    });
    $("keyClear").addEventListener("click", () => { localStorage.removeItem(LS.key); STATE.key = (window.WIX_SPEED_CONFIG && window.WIX_SPEED_CONFIG.psiApiKey) || ""; refreshKeyStatus(); toast("Cleared saved key."); });

    $("runForm").addEventListener("submit", (e) => { e.preventDefault(); runDiagnostic($("urlInput").value); });
    $("rerunBtn").addEventListener("click", () => { if (STATE.url) { toast("Re-running to measure your changes…"); runDiagnostic(STATE.url); } else toast("Run a scan first."); });
    $("pdfBtn").addEventListener("click", downloadPDF);
    $("emailBtn").addEventListener("click", () => { window.location.href = `mailto:?subject=${encodeURIComponent("Site speed report — " + STATE.url)}&body=${encodeURIComponent(summaryText())}`; });
    $("copyBtn").addEventListener("click", async () => { try { await navigator.clipboard.writeText(summaryText()); toast("Summary copied to clipboard."); } catch { toast("Couldn't copy — browser blocked clipboard access."); } });
    $("clearHistory").addEventListener("click", () => {
      if (!STATE.urlKey || !confirm("Clear saved scan history and checked-off actions for " + STATE.url + "?")) return;
      const h = store.get(LS.hist, {}); delete h[STATE.urlKey]; store.set(LS.hist, h);
      const dn = store.get(LS.done, {}); delete dn[STATE.urlKey]; store.set(LS.done, dn);
      renderChart(); renderHistory(); renderActions(); toast("History cleared.");
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
