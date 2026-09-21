// Copia qui i dati da Supabase → Project Settings → API (o "API Keys").
// La chiave "anon"/"publishable" è pubblica per design: la sicurezza è garantita dalle regole RLS.
export const CONFIG = {
  SUPABASE_URL: "https://ifmudesfanrkiyomdhfo.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_IboYSq2eEKG65BphYiea5Q_d6489Qen",
  DEMO: false,       // true = dati finti nel browser, senza Supabase (utile per provare)
  APP_NAME: "Doposcuola",
  TIMEZONE: "Europe/Rome",
  CANCEL_HOURS: 24, // solo testo mostrato agli studenti: il vincolo vero è in schema.sql (cancel_booking)
};
