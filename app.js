import { CONFIG } from "./config.js";
import { createDemoClient, resetDemo, DEMO_USERS } from "./demo.js";

// Demo se richiesta in config, se aggiungi ?demo all'indirizzo, o se Supabase non è ancora configurato
const DEMO = CONFIG.DEMO === true || new URLSearchParams(location.search).has("demo") || CONFIG.SUPABASE_URL.includes("XXXX");
const sb = DEMO
  ? createDemoClient()
  : (await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")).createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const TZ = CONFIG.TIMEZONE || "Europe/Rome";
const APP = CONFIG.APP_NAME || "Doposcuola";
const app = document.getElementById("app");
const dlg = document.getElementById("dlg");
document.title = `${APP} · Prenotazioni`;

const state = { session: null, profile: null, tab: null, weekStart: startOfWeek(new Date()), recovery: false };

/* =================== utilità =================== */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d, o) => new Intl.DateTimeFormat("it-IT", { timeZone: TZ, ...o }).format(new Date(d));
const fmtDay = (d) => fmt(d, { weekday: "long", day: "numeric", month: "long" });
const fmtTime = (d) => fmt(d, { hour: "2-digit", minute: "2-digit" });
const dayKey = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const durMin = (s, e) => Math.round((new Date(e) - new Date(s)) / 60000);
const phoneDigits = (p) => String(p || "").replace(/[^\d]/g, "");

function toast(msg, type = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${type}`; t.textContent = msg; t.setAttribute("role", "status");
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, type === "ok" ? 3000 : 5500);
}
function openDialog(html, onMount) {
  dlg.innerHTML = html;
  dlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => dlg.close()));
  dlg.showModal();
  onMount?.(dlg);
}
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
function confirmDialog(title, text, okLabel = "Conferma", danger = true) {
  return new Promise((resolve) => {
    openDialog(`<div class="dlg-body"><h3>${esc(title)}</h3><p class="muted">${text}</p>
      <div class="row end"><button class="btn" data-close>Annulla</button>
      <button class="btn ${danger ? "danger" : "primary"}" id="ok">${esc(okLabel)}</button></div></div>`, (d) => {
      d.querySelector("#ok").onclick = () => { resolve(true); d.close(); };
      d.addEventListener("close", () => resolve(false), { once: true });
    });
  });
}
async function busy(btn, fn) {
  const label = btn?.innerHTML; if (btn) { btn.disabled = true; btn.innerHTML = "Attendi…"; }
  try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
const errText = (e) => (e?.message || String(e)).replace(/^.*?ERROR:\s*/i, "");

/* chiamate alla edge function */
async function api(body) {
  const { data, error } = await sb.functions.invoke("tutor-api", { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
async function notify(bookingId, event) {
  try {
    const { results = [] } = await api({ action: "notify_booking", booking_id: bookingId, event });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) { console.warn("Notifiche non inviate:", failed); toast(`Salvato, ma non inviato: ${failed.map((f) => f.channel).join(", ")}`, "warn"); }
  } catch (e) { console.warn(e); toast("Salvato, ma le notifiche non sono partite", "warn"); }
}

/* calendario (.ics) lato browser */
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsEsc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function buildIcs(events) {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Doposcuola//IT", "METHOD:PUBLISH"];
  for (const e of events) {
    L.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${icsStamp(new Date())}`, `DTSTART:${icsStamp(e.start)}`,
      `DTEND:${icsStamp(e.end)}`, `SUMMARY:${icsEsc(e.summary)}`);
    if (e.description) L.push(`DESCRIPTION:${icsEsc(e.description)}`);
    if (e.location) L.push(`LOCATION:${icsEsc(e.location)}`);
    L.push("BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Lezione", "END:VALARM", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.join("\r\n") + "\r\n";
}
function downloadIcs(name, events) {
  const url = URL.createObjectURL(new Blob([buildIcs(events)], { type: "text/calendar;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function gcalLink(e) {
  const p = new URLSearchParams({ action: "TEMPLATE", text: e.summary, dates: `${icsStamp(e.start)}/${icsStamp(e.end)}`,
    details: e.description || "", location: e.location || "" });
  return `https://calendar.google.com/calendar/render?${p}`;
}
const studentEvent = (b, slot) => ({ uid: `${b.id}@doposcuola`, start: slot.starts_at, end: slot.ends_at,
  summary: `Lezione – ${APP}`, description: `Argomenti: ${b.topics || "—"}`, location: slot.location });

/* =================== autenticazione =================== */
sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") state.recovery = true;
  // stesso utente già caricato (refresh token, cambio tab): non ridisegnare
  if (session && state.profile && session.user.id === state.profile.id && event !== "PASSWORD_RECOVERY") { state.session = session; return; }
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  state.session = session;
  if (!session) { state.profile = null; state.tab = null; return render(); }
  const { data, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  if (error) console.error(error);
  state.profile = data || null;
  if (data && !state.tab) state.tab = data.role === "admin" ? "agenda" : "prenota";
  render();
}

function render() {
  if (state.recovery) return renderRecovery();
  if (!state.session) return renderLogin();
  if (!state.profile) {
    app.innerHTML = `<div class="auth"><div class="auth-card"><h1>Account non trovato</h1>
      <p class="muted">Il tuo profilo non esiste ancora. Chiedi al tutor di controllare.</p>
      <button class="btn w100" id="out">Esci</button></div></div>`;
    app.querySelector("#out").onclick = () => sb.auth.signOut();
    return;
  }
  renderShell();
}

function renderLogin() {
  app.innerHTML = `<div class="auth"><div class="auth-card">
    <h1>${esc(APP)}</h1><p class="muted">Accedi per prenotare le tue lezioni.</p>
    <form id="f"><label>Email<input type="email" name="email" required autocomplete="username"></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <button class="btn primary w100">Accedi</button></form>
    <button class="link" id="forgot">Ho dimenticato la password</button>
    ${DEMO ? `<div class="demo-box"><b>Modalità demo</b><p class="small">Dati di esempio salvati solo in questo browser. Password di tutti: <b>demo1234</b></p>
      <div class="row">${DEMO_USERS.map((u) => `<button class="btn sm" data-demo="${u.email}">${u.label}</button>`).join("")}</div></div>` : ""}
    </div></div>`;
  const f = app.querySelector("#f");
  app.querySelectorAll("[data-demo]").forEach((b) => (b.onclick = () => { f.email.value = b.dataset.demo; f.password.value = "demo1234"; f.requestSubmit(); }));
  f.onsubmit = async (e) => {
    e.preventDefault();
    await busy(f.querySelector("button"), async () => {
      const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) toast(error.message.includes("Invalid") ? "Email o password non corrette" : error.message, "err");
    });
  };
  app.querySelector("#forgot").onclick = async () => {
    const email = f.email.value.trim();
    if (!email) return toast("Scrivi prima la tua email nel campo qui sopra", "warn");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    toast(error ? error.message : "Ti abbiamo inviato un'email per reimpostare la password", error ? "err" : "ok");
  };
}

function renderRecovery() {
  app.innerHTML = `<div class="auth"><div class="auth-card"><h1>Nuova password</h1>
    <p class="muted">Scegli una password di almeno 8 caratteri.</p>
    <form id="f"><label>Nuova password<input type="password" name="p" minlength="8" required autocomplete="new-password"></label>
    <button class="btn primary w100">Salva password</button></form></div></div>`;
  const f = app.querySelector("#f");
  f.onsubmit = async (e) => {
    e.preventDefault();
    await busy(f.querySelector("button"), async () => {
      const { error } = await sb.auth.updateUser({ password: f.p.value });
      if (error) return toast(error.message, "err");
      state.recovery = false; toast("Password salvata"); handleSession(state.session);
    });
  };
}

/* =================== shell =================== */
const TABS = {
  student: [["prenota", "Prenota"], ["lezioni", "Le mie lezioni"], ["account", "Account"]],
  admin: [["agenda", "Agenda"], ["prenotazioni", "Prenotazioni"], ["studenti", "Studenti"], ["account", "Impostazioni"]],
};
const VIEWS = {};

function renderShell() {
  const p = state.profile, tabs = TABS[p.role === "admin" ? "admin" : "student"];
  app.innerHTML = `<header class="top"><div class="top-in">
      <div class="brand-row"><div class="brand">${esc(APP)}</div>
        <div class="who"><span>${esc(p.full_name || p.email)}</span><button class="btn sm" id="out">Esci</button></div></div>
      <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" ${k === state.tab ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
    </div></header>${DEMO ? `<div class="demo-bar">Modalità demo: nessun dato esce dal browser, le notifiche sono simulate. <button class="link" id="reset">Ripristina dati di esempio</button></div>` : ""}<main id="view"></main>`;
  app.querySelector("#reset")?.addEventListener("click", resetDemo);
  app.querySelector("#out").onclick = () => sb.auth.signOut();
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderShell(); }));
  if (!p.active && p.role !== "admin") {
    app.querySelector("#view").innerHTML = `<div class="empty">Il tuo account è sospeso. Contatta il tutor.</div>`;
    return;
  }
  VIEWS[state.tab](app.querySelector("#view"));
}

function weekBar(el, reload) {
  const s = state.weekStart, e = addDays(s, 6);
  const html = `<div class="weekbar"><button class="btn" data-w="-1" aria-label="Settimana precedente">‹ Prima</button>
    <div class="range">${fmt(s, { day: "numeric", month: "short" })} – ${fmt(e, { day: "numeric", month: "short", year: "numeric" })}</div>
    <div class="row"><button class="btn sm" data-w="0">Oggi</button><button class="btn" data-w="1" aria-label="Settimana successiva">Dopo ›</button></div></div>`;
  setTimeout(() => el.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => {
    const w = +b.dataset.w;
    state.weekStart = w === 0 ? startOfWeek(new Date()) : addDays(state.weekStart, 7 * w);
    reload();
  })));
  return html;
}
function groupByDay(items, getDate) {
  const m = new Map();
  for (const it of items) { const k = dayKey(getDate(it)); if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
  return m;
}
const todayKey = () => dayKey(new Date());

/* =================== STUDENTE =================== */
VIEWS.prenota = async function (el) {
  const reload = () => VIEWS.prenota(el);
  el.innerHTML = weekBar(el, reload) + `<div id="list" class="muted">Caricamento…</div>`;
  const from = state.weekStart, to = addDays(from, 7);
  const { data, error } = await sb.rpc("list_slots", { p_from: from.toISOString(), p_to: to.toISOString() });
  const list = el.querySelector("#list");
  if (error) return (list.innerHTML = `<div class="empty">Errore: ${esc(error.message)}</div>`);
  const now = Date.now();
  const slots = data.filter((s) => new Date(s.starts_at).getTime() > now);
  if (!slots.length) return (list.innerHTML = `<div class="empty">Nessun turno disponibile in questa settimana.<br>Prova la settimana successiva.</div>`);
  list.className = "";
  list.innerHTML = [...groupByDay(slots, (s) => s.starts_at)].map(([k, arr]) => `
    <section class="day"><div class="day-head"><h3>${fmtDay(arr[0].starts_at)}</h3>${k === todayKey() ? '<span class="today">oggi</span>' : ""}</div>
    ${arr.map((s) => {
      const free = s.capacity - s.booked, mine = !!s.mine;
      return `<div class="slot ${mine ? "mine" : free <= 0 ? "full" : ""}">
        <div class="time">${fmtTime(s.starts_at)}<small>fino alle ${fmtTime(s.ends_at)}</small></div>
        <div><div class="seats ${mine ? "" : free > 0 ? "free" : "none"}">${mine ? "Prenotato da te" : free > 0 ? (s.capacity > 1 ? `${free} posti liberi` : "Libero") : "Al completo"}</div>
          <div class="meta">${durMin(s.starts_at, s.ends_at)} min${s.location ? ` · ${esc(s.location)}` : ""}${s.note ? ` · ${esc(s.note)}` : ""}</div></div>
        <div class="act">${mine ? `<button class="btn sm" data-goto="lezioni">Vedi</button>` :
          `<button class="btn primary" data-book="${s.id}" ${free <= 0 ? "disabled" : ""}>Prenota</button>`}</div></div>`;
    }).join("")}</section>`).join("");
  list.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => { state.tab = "lezioni"; renderShell(); }));
  list.querySelectorAll("[data-book]").forEach((b) => (b.onclick = () => openBookDialog(slots.find((s) => s.id === b.dataset.book), reload)));
};

function openBookDialog(slot, reload) {
  openDialog(`<form class="dlg-body" id="f">
    <h3>Prenota la lezione</h3>
    <p class="muted" class="cap">${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}–${fmtTime(slot.ends_at)}</p>
    <label>Cosa vuoi fare in questa lezione?
      <textarea name="topics" rows="5" maxlength="2000" required placeholder="Es. equazioni di secondo grado, esercizi pag. 112, ripasso per la verifica di giovedì"></textarea></label>
    <p class="small muted">Puoi disdire fino a ${CONFIG.CANCEL_HOURS} ore prima.</p>
    <div class="row end"><button type="button" class="btn" data-close>Annulla</button><button class="btn primary">Conferma prenotazione</button></div></form>`, (d) => {
    const f = d.querySelector("#f");
    f.topics.focus();
    f.onsubmit = async (e) => {
      e.preventDefault();
      await busy(f.querySelector(".primary"), async () => {
        const topics = f.topics.value.trim();
        const { data: id, error } = await sb.rpc("book_slot", { p_slot: slot.id, p_topics: topics });
        if (error) { toast(errText(error), "err"); d.close(); return reload(); }
        d.close();
        toast("Lezione prenotata");
        notify(id, "booked");
        reload();
        const ev = studentEvent({ id, topics }, slot);
        openDialog(`<div class="dlg-body"><h3>Prenotazione confermata</h3>
          <p class="muted">Riceverai una conferma via email. Aggiungi la lezione al tuo calendario:</p>
          <div class="row"><button class="btn" id="ics">Scarica evento (.ics)</button>
          <a class="btn" target="_blank" rel="noopener" href="${gcalLink(ev)}">Google Calendar</a></div>
          <div class="row end" style="margin-top:16px"><button class="btn primary" data-close>Fatto</button></div></div>`,
          (d2) => (d2.querySelector("#ics").onclick = () => downloadIcs("lezione.ics", [ev])));
      });
    };
  });
}

VIEWS.lezioni = async function (el) {
  el.innerHTML = `<div class="muted">Caricamento…</div>`;
  const { data, error } = await sb.from("bookings")
    .select("id, topics, status, created_at, slot:slots(id, starts_at, ends_at, location, note)")
    .eq("student_id", state.profile.id);
  if (error) return (el.innerHTML = `<div class="empty">Errore: ${esc(error.message)}</div>`);
  const now = Date.now();
  const rows = data.filter((b) => b.slot).sort((a, b) => new Date(a.slot.starts_at) - new Date(b.slot.starts_at));
  const next = rows.filter((b) => b.status === "confirmed" && new Date(b.slot.ends_at) > now);
  const past = rows.filter((b) => !next.includes(b)).reverse().slice(0, 30);
  const limit = CONFIG.CANCEL_HOURS * 3600e3;
  const card = (b, upcoming) => {
    const canCancel = upcoming && new Date(b.slot.starts_at) - now > limit;
    return `<div class="card"><div class="row between"><h3 class="cap">${fmtDay(b.slot.starts_at)}</h3>
      ${b.status === "cancelled" ? '<span class="pill off">Disdetta</span>' : upcoming ? '<span class="pill ok">Confermata</span>' : '<span class="pill">Svolta</span>'}</div>
      <div class="muted">${fmtTime(b.slot.starts_at)}–${fmtTime(b.slot.ends_at)}${b.slot.location ? ` · ${esc(b.slot.location)}` : ""}</div>
      <div class="topics-box">${esc(b.topics || "Nessun argomento indicato")}</div>
      ${upcoming ? `<div class="row"><button class="btn sm" data-edit="${b.id}">Modifica argomenti</button>
        <button class="btn sm" data-ics="${b.id}">Aggiungi al calendario</button>
        ${canCancel ? `<button class="btn sm danger" data-cancel="${b.id}">Disdici</button>` : `<span class="small muted">Per disdire ora scrivi al tutor</span>`}</div>` : ""}</div>`;
  };
  el.innerHTML = `<h2 class="section-title" style="margin-top:0">Prossime lezioni</h2>
    ${next.length ? next.map((b) => card(b, true)).join("") : `<div class="empty">Non hai lezioni in programma.<br><button class="btn primary" style="margin-top:12px" data-goto>Prenota una lezione</button></div>`}
    ${past.length ? `<h2 class="section-title">Storico</h2>${past.map((b) => card(b, false)).join("")}` : ""}`;
  const find = (id) => rows.find((b) => b.id === id);
  el.querySelector("[data-goto]")?.addEventListener("click", () => { state.tab = "prenota"; renderShell(); });
  el.querySelectorAll("[data-ics]").forEach((btn) => (btn.onclick = () => { const b = find(btn.dataset.ics); downloadIcs("lezione.ics", [studentEvent(b, b.slot)]); }));
  el.querySelectorAll("[data-edit]").forEach((btn) => (btn.onclick = () => editTopics(find(btn.dataset.edit), () => VIEWS.lezioni(el))));
  el.querySelectorAll("[data-cancel]").forEach((btn) => (btn.onclick = async () => {
    const b = find(btn.dataset.cancel);
    if (!(await confirmDialog("Disdire la lezione?", `${esc(fmtDay(b.slot.starts_at))} alle ${fmtTime(b.slot.starts_at)}. Il posto tornerà libero per gli altri.`, "Disdici lezione"))) return;
    const { error } = await sb.rpc("cancel_booking", { p_booking: b.id });
    if (error) return toast(errText(error), "err");
    toast("Lezione disdetta"); notify(b.id, "cancelled"); VIEWS.lezioni(el);
  }));
};

function editTopics(b, reload) {
  openDialog(`<form class="dlg-body" id="f"><h3>Argomenti della lezione</h3>
    <label>Cosa vuoi fare?<textarea name="t" rows="6" maxlength="2000" required>${esc(b.topics)}</textarea></label>
    <div class="row end"><button type="button" class="btn" data-close>Annulla</button><button class="btn primary">Salva argomenti</button></div></form>`, (d) => {
    const f = d.querySelector("#f");
    f.onsubmit = async (e) => {
      e.preventDefault();
      await busy(f.querySelector(".primary"), async () => {
        const { error } = await sb.rpc("update_topics", { p_booking: b.id, p_topics: f.t.value });
        if (error) return toast(errText(error), "err");
        d.close(); toast("Argomenti salvati"); notify(b.id, "updated"); reload();
      });
    };
  });
}

/* =================== ACCOUNT (tutti) =================== */
VIEWS.account = async function (el) {
  const p = state.profile, isAdmin = p.role === "admin";
  el.innerHTML = `<div class="form-card"><h2>Il tuo account</h2>
      <p class="muted">${esc(p.full_name)}<br>${esc(p.email)}${p.phone ? `<br>${esc(p.phone)}` : ""}</p>
      <form id="pw"><label>Nuova password<input type="password" name="p" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary">Cambia password</button></form></div>
    ${isAdmin ? `<div class="form-card"><h2>Calendario personale</h2>
      <p class="muted">Iscrivi Google Calendar, Apple o Outlook a questo indirizzo: le lezioni prenotate compariranno da sole.
      Google aggiorna i calendari iscritti ogni qualche ora.</p><div id="feed" class="code">Caricamento…</div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="copy">Copia indirizzo</button>
      <a class="btn sm" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/r/settings/addbyurl">Apri Google Calendar</a></div></div>
      <div class="form-card"><h2>Notifiche</h2><p class="muted">Invia un messaggio di prova a te stesso per verificare email e WhatsApp.</p>
      <button class="btn" id="test">Invia prova</button><div id="testres" class="small" style="margin-top:10px"></div></div>` : ""}`;
  const f = el.querySelector("#pw");
  f.onsubmit = async (e) => {
    e.preventDefault();
    await busy(f.querySelector("button"), async () => {
      const { error } = await sb.auth.updateUser({ password: f.p.value });
      if (error) return toast(error.message, "err");
      f.reset(); toast("Password cambiata");
    });
  };
  if (!isAdmin) return;
  api({ action: "feed_url" }).then(({ url }) => {
    el.querySelector("#feed").textContent = url || "Imposta FEED_TOKEN nei secret della funzione per attivare il feed.";
    el.querySelector("#copy").onclick = () => url && navigator.clipboard.writeText(url).then(() => toast("Indirizzo copiato"));
  }).catch((e) => (el.querySelector("#feed").textContent = "Funzione non raggiungibile: " + e.message));
  el.querySelector("#test").onclick = (ev) => busy(ev.currentTarget, async () => {
    try {
      const { results } = await api({ action: "test_notify" });
      el.querySelector("#testres").innerHTML = results.map((r) => `${r.ok ? "✅" : "❌"} ${esc(r.channel)}${r.error ? ` — ${esc(r.error)}` : ""}`).join("<br>");
    } catch (e) { toast(e.message, "err"); }
  });
};

/* =================== ADMIN: agenda =================== */
VIEWS.agenda = async function (el) {
  const reload = () => VIEWS.agenda(el);
  el.innerHTML = weekBar(el, reload) + `<div class="toolbar">
      <button class="btn primary" id="add1">Aggiungi turno</button>
      <button class="btn" id="addN">Crea turni ricorrenti</button>
      <button class="btn" id="copyw">Copia settimana precedente</button></div><div id="list" class="muted">Caricamento…</div>`;
  el.querySelector("#add1").onclick = () => slotDialog(reload);
  el.querySelector("#addN").onclick = () => recurringDialog(reload);
  el.querySelector("#copyw").onclick = () => copyPrevWeek(reload);

  const from = state.weekStart, to = addDays(from, 7);
  const { data, error } = await sb.from("slots")
    .select("*, bookings(id, topics, status, student:profiles(id, full_name, email, phone))")
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString()).order("starts_at");
  const list = el.querySelector("#list");
  if (error) return (list.innerHTML = `<div class="empty">Errore: ${esc(error.message)}</div>`);
  list.className = "";
  const byDay = groupByDay(data, (s) => s.starts_at);
  const now = Date.now();
  list.innerHTML = Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => {
    const arr = byDay.get(dayKey(d)) || [];
    return `<section class="day"><div class="day-head"><h3>${fmtDay(d)}</h3>${dayKey(d) === todayKey() ? '<span class="today">oggi</span>' : ""}</div>
      ${arr.length ? arr.map((s) => {
        const bk = s.bookings.filter((b) => b.status === "confirmed");
        const past = new Date(s.ends_at) < now;
        return `<div class="slot ${bk.length >= s.capacity ? "full" : ""} ${past ? "past" : ""}">
          <div class="time">${fmtTime(s.starts_at)}<small>fino alle ${fmtTime(s.ends_at)}</small></div>
          <div><div class="seats ${bk.length < s.capacity ? "free" : "none"}">${bk.length}/${s.capacity} prenotati</div>
            <div class="meta">${s.location ? esc(s.location) : ""}${s.note ? ` · ${esc(s.note)}` : ""}</div></div>
          <div class="act row"><button class="btn sm" data-edit="${s.id}">Modifica</button><button class="btn sm danger" data-del="${s.id}">Elimina</button></div>
          ${bk.length ? `<div class="bk">${bk.map((b) => `<div class="bk-item"><div>
              <div class="bk-name">${esc(b.student?.full_name || b.student?.email)}</div>
              <div class="bk-topics">${esc(b.topics || "—")}</div>
              <div class="contact">${b.student?.phone ? `<a href="https://wa.me/${phoneDigits(b.student.phone)}" target="_blank" rel="noopener">WhatsApp</a><a href="tel:${esc(b.student.phone)}">Chiama</a>` : ""}${b.student?.email ? `<a href="mailto:${esc(b.student.email)}">Email</a>` : ""}</div></div>
              ${past ? "" : `<button class="btn sm danger" data-cancelb="${b.id}">Annulla</button>`}</div>`).join("")}</div>` : ""}
        </div>`;
      }).join("") : `<div class="small muted">Nessun turno</div>`}</section>`;
  }).join("");

  const find = (id) => data.find((s) => s.id === id);
  list.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => slotDialog(reload, find(b.dataset.edit))));
  list.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => deleteSlot(find(b.dataset.del), reload)));
  list.querySelectorAll("[data-cancelb]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog("Annullare questa prenotazione?", "Lo studente riceverà una notifica di annullamento.", "Annulla prenotazione"))) return;
    const { error } = await sb.rpc("cancel_booking", { p_booking: b.dataset.cancelb });
    if (error) return toast(errText(error), "err");
    toast("Prenotazione annullata"); notify(b.dataset.cancelb, "cancelled"); reload();
  }));
};

function slotDialog(reload, slot) {
  const s = slot ? new Date(slot.starts_at) : null, e = slot ? new Date(slot.ends_at) : null;
  const def = addDays(state.weekStart, Math.min(Math.max(((new Date().getDay() + 6) % 7), 0), 6));
  openDialog(`<form class="dlg-body" id="f"><h3>${slot ? "Modifica turno" : "Nuovo turno"}</h3>
    <label>Giorno<input type="date" name="d" required value="${isoDate(s || def)}"></label>
    <div class="grid2"><label>Dalle<input type="time" name="s" required value="${s ? `${pad(s.getHours())}:${pad(s.getMinutes())}` : "15:00"}"></label>
    <label>Alle<input type="time" name="e" required value="${e ? `${pad(e.getHours())}:${pad(e.getMinutes())}` : "16:00"}"></label></div>
    <div class="grid2"><label>Posti<input type="number" name="c" min="1" max="30" value="${slot?.capacity ?? 1}" required></label>
    <label>Luogo<input name="l" placeholder="Es. online, a casa, biblioteca" value="${esc(slot?.location || "")}"></label></div>
    <label>Nota per gli studenti<input name="n" value="${esc(slot?.note || "")}"></label>
    <div class="row end"><button type="button" class="btn" data-close>Annulla</button><button class="btn primary">${slot ? "Salva turno" : "Aggiungi turno"}</button></div></form>`, (d) => {
    const f = d.querySelector("#f");
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const starts = new Date(`${f.d.value}T${f.s.value}`), ends = new Date(`${f.d.value}T${f.e.value}`);
      if (ends <= starts) return toast("L'orario di fine deve essere dopo l'inizio", "err");
      const row = { starts_at: starts.toISOString(), ends_at: ends.toISOString(), capacity: +f.c.value,
        location: f.l.value.trim() || null, note: f.n.value.trim() || null };
      await busy(f.querySelector(".primary"), async () => {
        const { error } = slot ? await sb.from("slots").update(row).eq("id", slot.id) : await sb.from("slots").insert(row);
        if (error) return toast(error.message, "err");
        d.close(); toast(slot ? "Turno salvato" : "Turno aggiunto"); reload();
      });
    };
  });
}

function buildRecurring(f) {
  const from = new Date(`${f.from.value}T00:00`), to = new Date(`${f.to.value}T00:00`);
  const days = [...f.querySelectorAll("[name=wd]:checked")].map((c) => +c.value);
  const [sh, sm] = f.s.value.split(":").map(Number), [eh, em] = f.e.value.split(":").map(Number);
  const dur = +f.dur.value, gap = +f.gap.value;
  const out = [];
  if (!(dur > 0) || isNaN(from) || isNaN(to) || to < from) return out;
  for (let d = new Date(from); d <= to && out.length < 1000; d = addDays(d, 1)) {
    if (!days.includes(d.getDay())) continue;
    let t = new Date(d); t.setHours(sh, sm, 0, 0);
    const end = new Date(d); end.setHours(eh, em, 0, 0);
    while (t.getTime() + dur * 60000 <= end.getTime()) {
      const e = new Date(t.getTime() + dur * 60000);
      out.push({ starts_at: t.toISOString(), ends_at: e.toISOString(), capacity: +f.c.value, location: f.l.value.trim() || null });
      t = new Date(e.getTime() + gap * 60000);
    }
  }
  return out;
}

function recurringDialog(reload) {
  const wd = [[1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Gio"], [5, "Ven"], [6, "Sab"], [0, "Dom"]];
  openDialog(`<form class="dlg-body" id="f"><h3>Crea turni ricorrenti</h3>
    <p class="muted small">Genera in un colpo tutte le lezioni di un periodo. I turni già esistenti allo stesso orario vengono saltati.</p>
    <div class="grid2"><label>Dal<input type="date" name="from" required value="${isoDate(state.weekStart)}"></label>
    <label>Al<input type="date" name="to" required value="${isoDate(addDays(state.weekStart, 27))}"></label></div>
    <div class="small" style="font-weight:700">Giorni</div>
    <div class="days-pick">${wd.map(([v, l]) => `<label><input type="checkbox" name="wd" value="${v}" ${v >= 1 && v <= 5 ? "checked" : ""}>${l}</label>`).join("")}</div>
    <div class="grid2"><label>Dalle<input type="time" name="s" value="15:00" required></label><label>Alle<input type="time" name="e" value="19:00" required></label></div>
    <div class="grid3"><label>Durata (min)<input type="number" name="dur" value="60" min="15" step="5" required></label>
    <label>Pausa (min)<input type="number" name="gap" value="0" min="0" step="5"></label>
    <label>Posti<input type="number" name="c" value="1" min="1" max="30" required></label></div>
    <label>Luogo<input name="l" placeholder="Facoltativo"></label>
    <p id="pv" class="small" style="font-weight:700"></p>
    <div class="row end"><button type="button" class="btn" data-close>Annulla</button><button class="btn primary">Crea turni</button></div></form>`, (d) => {
    const f = d.querySelector("#f"), pv = d.querySelector("#pv");
    const upd = () => { const n = buildRecurring(f).length; pv.textContent = n ? `Verranno creati fino a ${n} turni.` : "Nessun turno con queste impostazioni."; };
    f.addEventListener("input", upd); upd();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      let rows = buildRecurring(f);
      if (!rows.length) return toast("Nessun turno da creare", "warn");
      await busy(f.querySelector(".primary"), async () => {
        const { data: ex, error: e1 } = await sb.from("slots").select("starts_at")
          .gte("starts_at", rows[0].starts_at).lte("starts_at", rows[rows.length - 1].starts_at);
        if (e1) return toast(e1.message, "err");
        const taken = new Set(ex.map((x) => new Date(x.starts_at).getTime()));
        rows = rows.filter((r) => !taken.has(new Date(r.starts_at).getTime()));
        if (!rows.length) { d.close(); return toast("Tutti i turni esistevano già", "warn"); }
        const { error } = await sb.from("slots").insert(rows);
        if (error) return toast(error.message, "err");
        d.close(); toast(`${rows.length} turni creati`); reload();
      });
    };
  });
}

async function copyPrevWeek(reload) {
  const from = addDays(state.weekStart, -7), to = state.weekStart;
  const { data, error } = await sb.from("slots").select("starts_at, ends_at, capacity, location, note")
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString());
  if (error) return toast(error.message, "err");
  if (!data.length) return toast("La settimana precedente non ha turni", "warn");
  const { data: ex } = await sb.from("slots").select("starts_at").gte("starts_at", to.toISOString()).lt("starts_at", addDays(to, 7).toISOString());
  const taken = new Set((ex || []).map((x) => new Date(x.starts_at).getTime()));
  const rows = data.map((s) => ({ ...s, starts_at: addDays(new Date(s.starts_at), 7).toISOString(), ends_at: addDays(new Date(s.ends_at), 7).toISOString() }))
    .filter((r) => !taken.has(new Date(r.starts_at).getTime()));
  if (!rows.length) return toast("Questa settimana ha già gli stessi turni", "warn");
  if (!(await confirmDialog("Copiare i turni?", `Verranno aggiunti ${rows.length} turni a questa settimana, con gli stessi orari della precedente.`, "Copia turni", false))) return;
  const { error: e2 } = await sb.from("slots").insert(rows);
  if (e2) return toast(e2.message, "err");
  toast(`${rows.length} turni copiati`); reload();
}

async function deleteSlot(slot, reload) {
  const bk = slot.bookings.filter((b) => b.status === "confirmed");
  const msg = bk.length ? `Ci sono ${bk.length} prenotazioni: gli studenti riceveranno un avviso di annullamento.` : "Il turno non ha prenotazioni.";
  if (!(await confirmDialog("Eliminare il turno?", msg, "Elimina turno"))) return;
  for (const b of bk) {
    const { error } = await sb.rpc("cancel_booking", { p_booking: b.id });
    if (!error) await notify(b.id, "cancelled");
  }
  const { error } = await sb.from("slots").delete().eq("id", slot.id);
  if (error) return toast(error.message, "err");
  toast("Turno eliminato"); reload();
}

/* =================== ADMIN: prenotazioni =================== */
VIEWS.prenotazioni = async function (el, mode = "next") {
  el.innerHTML = `<div class="row between" style="margin-bottom:16px"><h2>Prenotazioni</h2>
    <div class="row"><select id="mode" style="width:auto;margin:0">
      <option value="next">Prossime</option><option value="past">Ultimi 60 giorni</option><option value="cancelled">Disdette</option></select>
    <button class="btn" id="exp">Esporta .ics</button></div></div><div id="list" class="muted">Caricamento…</div>`;
  const sel = el.querySelector("#mode"); sel.value = mode;
  sel.onchange = () => VIEWS.prenotazioni(el, sel.value);
  const nowIso = new Date().toISOString(), since = addDays(new Date(), -60).toISOString();
  let q = sb.from("bookings").select("id, topics, status, created_at, slot:slots!inner(starts_at, ends_at, location), student:profiles(full_name, email, phone)");
  if (mode === "next") q = q.eq("status", "confirmed").gte("slot.starts_at", nowIso);
  if (mode === "past") q = q.eq("status", "confirmed").lt("slot.starts_at", nowIso).gte("slot.starts_at", since);
  if (mode === "cancelled") q = q.eq("status", "cancelled").gte("slot.starts_at", since);
  const { data, error } = await q;
  const list = el.querySelector("#list");
  if (error) return (list.innerHTML = `<div class="empty">Errore: ${esc(error.message)}</div>`);
  const rows = data.sort((a, b) => (new Date(a.slot.starts_at) - new Date(b.slot.starts_at)) * (mode === "next" ? 1 : -1));
  list.className = "";
  list.innerHTML = rows.length ? rows.map((b) => `<div class="card">
      <div class="row between"><h3>${esc(b.student?.full_name || b.student?.email)}</h3><span class="pill">${fmt(b.slot.starts_at, { weekday: "short", day: "numeric", month: "short" })} · ${fmtTime(b.slot.starts_at)}</span></div>
      <div class="topics-box">${esc(b.topics || "—")}</div>
      <div class="contact">${b.student?.phone ? `<a href="https://wa.me/${phoneDigits(b.student.phone)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}${b.student?.email ? `<a href="mailto:${esc(b.student.email)}">Email</a>` : ""}
      <span class="small muted">prenotata il ${fmt(b.created_at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div></div>`).join("")
    : `<div class="empty">Nessuna prenotazione in questo elenco.</div>`;
  el.querySelector("#exp").onclick = () => {
    const evs = rows.filter((b) => b.status === "confirmed").map((b) => ({ uid: `${b.id}-t@doposcuola`, start: b.slot.starts_at, end: b.slot.ends_at,
      summary: `Lezione – ${b.student?.full_name}`, description: `Argomenti: ${b.topics || "—"}\nTel: ${b.student?.phone || "-"}`, location: b.slot.location }));
    if (!evs.length) return toast("Niente da esportare", "warn");
    downloadIcs("lezioni.ics", evs);
  };
};

/* =================== ADMIN: studenti =================== */
const genPassword = () => { const c = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(crypto.getRandomValues(new Uint32Array(10)), (n) => c[n % c.length]).join(""); };

VIEWS.studenti = async function (el) {
  const reload = () => VIEWS.studenti(el);
  el.innerHTML = `<div class="form-card"><h2>Nuovo studente</h2><p class="muted small">Crei tu l'accesso: lo studente entra con email e password.</p>
    <form id="f"><div class="grid2"><label>Nome e cognome<input name="n" required></label><label>Email<input type="email" name="e" required></label></div>
    <div class="grid2"><label>Telefono (con prefisso)<input name="p" placeholder="+39 333 1234567"></label>
    <label>Password<div class="row" style="flex-wrap:nowrap"><input name="pw" required minlength="8" value="${genPassword()}" style="margin-top:5px"><button type="button" class="btn sm" id="gen" style="margin-top:5px">Nuova</button></div></label></div>
    <label style="font-weight:400"><input type="checkbox" name="w" checked>Invia le credenziali via email allo studente</label>
    <button class="btn primary">Crea studente</button></form></div>
    <h2 class="section-title">Studenti</h2><div id="list" class="muted">Caricamento…</div>`;
  const f = el.querySelector("#f");
  el.querySelector("#gen").onclick = () => (f.pw.value = genPassword());
  f.onsubmit = async (e) => {
    e.preventDefault();
    await busy(f.querySelector(".primary"), async () => {
      try {
        const r = await api({ action: "create_student", full_name: f.n.value, email: f.e.value, phone: f.p.value, password: f.pw.value, send_welcome: f.w.checked });
        const failed = (r.results || []).filter((x) => !x.ok);
        const creds = `Email: ${f.e.value.trim()}\nPassword: ${f.pw.value}\nLink: ${location.origin + location.pathname}`;
        toast(failed.length ? "Studente creato, ma email non inviata" : "Studente creato", failed.length ? "warn" : "ok");
        openDialog(`<div class="dlg-body"><h3>Credenziali di ${esc(f.n.value)}</h3>
          <p class="muted small">Copiale ora: la password non sarà più visibile.</p><div class="code" style="white-space:pre-wrap">${esc(creds)}</div>
          <div class="row" style="margin-top:12px"><button class="btn" id="cp">Copia</button>
          ${f.p.value ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${phoneDigits(f.p.value)}?text=${encodeURIComponent(`Ciao! Ecco il tuo accesso per prenotare le lezioni:\n${creds}`)}">Invia su WhatsApp</a>` : ""}</div>
          <div class="row end" style="margin-top:14px"><button class="btn primary" data-close>Fatto</button></div></div>`,
          (d) => (d.querySelector("#cp").onclick = () => navigator.clipboard.writeText(creds).then(() => toast("Copiato"))));
        dlg.addEventListener("close", reload, { once: true });
      } catch (err) { toast(err.message, "err"); }
    });
  };

  const { data, error } = await sb.from("profiles").select("*").neq("role", "admin").order("full_name");
  const list = el.querySelector("#list");
  if (error) return (list.innerHTML = `<div class="empty">Errore: ${esc(error.message)}</div>`);
  list.className = "";
  list.innerHTML = data.length ? data.map((s) => `<div class="card"><div class="row between">
      <div><h3>${esc(s.full_name || "(senza nome)")}</h3><div class="small muted">${esc(s.email)}${s.phone ? ` · ${esc(s.phone)}` : ""}</div></div>
      <div class="row">${s.active ? "" : '<span class="pill off">Sospeso</span>'}${s.whatsapp_apikey ? '<span class="pill ok">WhatsApp attivo</span>' : ""}
      <button class="btn sm" data-edit="${s.id}">Modifica</button><button class="btn sm danger" data-del="${s.id}">Elimina</button></div></div></div>`).join("")
    : `<div class="empty">Ancora nessuno studente. Crea il primo con il modulo qui sopra.</div>`;
  const find = (id) => data.find((s) => s.id === id);
  list.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => studentDialog(find(b.dataset.edit), reload)));
  list.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    const s = find(b.dataset.del);
    if (!(await confirmDialog(`Eliminare ${s.full_name}?`, "Verranno cancellati l'account e tutto lo storico delle sue prenotazioni. Se vuoi solo bloccarlo, usa “Sospendi” in Modifica.", "Elimina studente"))) return;
    try { await api({ action: "delete_student", id: s.id }); toast("Studente eliminato"); reload(); } catch (e) { toast(e.message, "err"); }
  }));
};

function studentDialog(s, reload) {
  openDialog(`<form class="dlg-body" id="f"><h3>Modifica studente</h3><p class="muted small">${esc(s.email)}</p>
    <label>Nome e cognome<input name="n" required value="${esc(s.full_name)}"></label>
    <label>Telefono (con prefisso)<input name="p" value="${esc(s.phone || "")}" placeholder="+39 333 1234567"></label>
    <label>Apikey WhatsApp (CallMeBot)<input name="k" value="${esc(s.whatsapp_apikey || "")}" placeholder="Facoltativa: per inviare conferme WhatsApp allo studente"></label>
    <label>Nuova password<input name="pw" minlength="8" placeholder="Lascia vuoto per non cambiarla" autocomplete="new-password"></label>
    <label style="font-weight:400"><input type="checkbox" name="a" ${s.active ? "checked" : ""}>Account attivo (se lo togli lo studente non può più accedere)</label>
    <div class="row end"><button type="button" class="btn" data-close>Annulla</button><button class="btn primary">Salva modifiche</button></div></form>`, (d) => {
    const f = d.querySelector("#f");
    f.onsubmit = async (e) => {
      e.preventDefault();
      await busy(f.querySelector(".primary"), async () => {
        try {
          const body = { action: "update_student", id: s.id, full_name: f.n.value.trim(), phone: f.p.value.trim(), whatsapp_apikey: f.k.value.trim() };
          if (f.a.checked !== s.active) body.active = f.a.checked;
          if (f.pw.value) body.password = f.pw.value;
          await api(body);
          d.close(); toast("Modifiche salvate"); reload();
        } catch (err) { toast(err.message, "err"); }
      });
    };
  });
}
