// Copy this file to `config.js` and paste your Google PageSpeed Insights API key.
// `config.js` is gitignored so your key is never committed.
//
// You can also just paste the key into the app's UI at runtime instead of using
// this file — the UI value is stored locally in your browser (localStorage).
//
// IMPORTANT: restrict this key in Google Cloud Console
//   APIs & Services > Credentials > (your key) > Edit
//     - API restrictions: restrict to "PageSpeed Insights API" only
//     - Application restrictions: HTTP referrers, add the domain you host this on
//       (for local testing, add http://localhost:* )
window.WIX_SPEED_CONFIG = {
  psiApiKey: "PASTE_YOUR_KEY_HERE",
};
