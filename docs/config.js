// =====================================================================
// 賭讀 / StudyBet — config.js
// Fill in these values, then publish. Every value here is safe to be
// public: the anon key only allows what the database rules allow.
// NEVER put the service_role key (or any other secret) in this file.
// =====================================================================

window.STUDYBET_CONFIG = {
  // Supabase → Project Settings → Data API (or API) → "Project URL"
  // e.g. "https://abcdefghijkl.supabase.co"
  SUPABASE_URL: 'https://rqlgldutexfozaatpypd.supabase.co',

  // Supabase → Project Settings → API Keys → "anon / public" key
  // (or the newer "publishable" key, starts with "sb_publishable_")
  SUPABASE_ANON_KEY: 'sb_publishable_x8S43sIpX5gqn_jRIleH9Q_0UfLoO85',

  // Produced by Part C (push notifications). Leave empty until then;
  // the app works without it, only notifications stay off.
  VAPID_PUBLIC_KEY: '',

  // Optional. Cloudflare Turnstile site key (free). Only fill this in if you
  // turned on CAPTCHA protection in Supabase → Authentication. Empty = no
  // CAPTCHA widget is shown.
  TURNSTILE_SITE_KEY: '',
};
