// =====================================================================
//  MODALITÀ DEMO · finto Supabase che vive nel browser (localStorage)
//  Imita solo le parti usate da app.js. Nessun dato esce dal browser.
// =====================================================================
const KEY = "doposcuola-demo-v1";
const PW = "demo1234";
export const DEMO_USERS = [
  { email: "tutor@demo.it", label: "Entra come tutor" },
  { email: "giulia@demo.it", label: "Entra come studente" },
];

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now());
const clone = (x) => JSON.parse(JSON.stringify(x));
const iso = (d) => new Date(d).toISOString();

function seed() {
  const now = new Date();
  const mk = (full_name, email, phone, role = "student") =>
    ({ id: uuid(), full_name, email, phone, role, active: true, whatsapp_apikey: null, created_at: iso(now) });
  const admin = mk("Tutor Demo", "tutor@demo.it", "+39 333 0000000", "admin");
  const giulia = mk("Giulia Rossi", "giulia@demo.it", "+39 333 1111111");
  const marco = mk("Marco Bianchi", "marco@demo.it", "+39 333 2222222");
  const sara = mk("Sara Conti", "sara@demo.it", null);
  const profiles = [admin, giulia, marco, sara];

  // turni: dalla settimana scorsa a +2 settimane, lun-ven 15-18 (1 posto), sab 10-12 ripasso di gruppo
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7);
  const slots = [];
  for (let i = 0; i < 28; i++) {
    const d = new Date(monday); d.setDate(d.getDate() + i);
    const wd = d.getDay();
    if (wd >= 1 && wd <= 5) {
      for (const h of [15, 16, 17]) {
        const s = new Date(d); s.setHours(h, 0, 0, 0);
        slots.push({ id: uuid(), starts_at: iso(s), ends_at: iso(+s + 3600e3), capacity: 1, location: h === 17 ? "Online (Meet)" : "Studio", note: null, created_at: iso(now) });
      }
    } else if (wd === 6) {
      const s = new Date(d); s.setHours(10, 0, 0, 0);
      slots.push({ id: uuid(), starts_at: iso(s), ends_at: iso(+s + 7200e3), capacity: 4, location: "Biblioteca", note: "Ripasso di gruppo", created_at: iso(now) });
    }
  }

  const topics = [
    [giulia, "Equazioni di secondo grado, esercizi pag. 112"],
    [marco, "Analisi logica e ripasso complementi"],
    [giulia, "Verifica di inglese: present perfect vs past simple"],
    [sara, "Frazioni e problemi con le percentuali"],
    [marco, "Relazione di scienze sul ciclo dell'acqua"],
    [sara, "Storia: la Rivoluzione francese, mappa concettuale"],
    [giulia, "Geometria: teorema di Pitagora"],
  ];
  const bookings = [];
  const past = slots.filter((s) => new Date(s.starts_at) < now && s.capacity === 1);
  const future = slots.filter((s) => new Date(s.starts_at) > now);
  const add = (slot, [st, t], status = "confirmed") =>
    bookings.push({ id: uuid(), slot_id: slot.id, student_id: st.id, topics: t, status, created_at: iso(+new Date(slot.starts_at) - 3 * 864e5), cancelled_at: status === "cancelled" ? iso(now) : null });
  past.slice(-4).forEach((s, i) => add(s, topics[i]));
  [1, 4, 6, 9, 13].forEach((idx, i) => future[idx] && future[idx].capacity === 1 && add(future[idx], topics[(i + 2) % topics.length]));
  const group = future.find((s) => s.capacity > 1);
  if (group) { add(group, [marco, "Ripasso generale matematica"]); add(group, [sara, "Esercizi di grammatica"]); }
  if (future[7]?.capacity === 1) add(future[7], [marco, "Compiti di tecnologia"], "cancelled");

  const passwords = Object.fromEntries(profiles.map((p) => [p.email, PW]));
  return { profiles, slots, bookings, passwords, session: null };
}

let db;
function load() {
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
  if (!db?.profiles) { db = seed(); save(); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }
export function resetDemo() { try { localStorage.removeItem(KEY); } catch {} location.reload(); }

const me = () => db.profiles.find((p) => p.id === db.session?.user?.id) || null;
const isAdmin = () => me()?.role === "admin";
const ok = (data = null) => ({ data, error: null });
const fail = (message) => ({ data: null, error: { message } });
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/* ---------- query builder (sottoinsieme di PostgREST) ---------- */
const get = (row, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), row);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function visible(table) {
  const u = me(); if (!u) return [];
  const rows = db[table];
  if (u.role === "admin" || table === "slots") return rows;
  if (table === "profiles") return rows.filter((p) => p.id === u.id);
  if (table === "bookings") return rows.filter((b) => b.student_id === u.id);
  return [];
}
function enrich(table, rows) {
  const prof = (id) => { const p = db.profiles.find((x) => x.id === id); return p ? clone(p) : null; };
  if (table === "slots") return rows.map((s) => ({ ...clone(s),
    bookings: db.bookings.filter((b) => b.slot_id === s.id).map((b) => ({ ...clone(b), student: prof(b.student_id) })) }));
  if (table === "bookings") return rows.map((b) => ({ ...clone(b), slot: clone(db.slots.find((s) => s.id === b.slot_id) || null), student: prof(b.student_id) }))
    .filter((b) => b.slot);
  return clone(rows);
}

function from(table) {
  const q = { filters: [], order: null, single: false, op: "select", payload: null };
  const f = (fn) => (field, v) => { q.filters.push((r) => fn(get(r, field), v)); return b; };
  const b = {
    select() { return b; },
    eq: f((a, v) => a === v), neq: f((a, v) => a !== v),
    gt: f((a, v) => a != null && cmp(a, v) > 0), gte: f((a, v) => a != null && cmp(a, v) >= 0),
    lt: f((a, v) => a != null && cmp(a, v) < 0), lte: f((a, v) => a != null && cmp(a, v) <= 0),
    order(field, o = {}) { q.order = [field, o.ascending !== false]; return b; },
    single() { q.single = true; return b; },
    insert(p) { q.op = "insert"; q.payload = p; return b; },
    update(p) { q.op = "update"; q.payload = p; return b; },
    delete() { q.op = "delete"; return b; },
    then(res, rej) { return wait().then(() => exec(table, q)).then(res, rej); },
  };
  return b;
}

function exec(table, q) {
  if (!me()) return fail("Non autenticato");
  const match = (r) => q.filters.every((fn) => fn(r));
  if (q.op !== "select" && !isAdmin()) return fail("Permesso negato (RLS)");
  if (q.op === "insert") {
    const now = iso(new Date());
    for (const r of [].concat(q.payload)) db[table].push({ id: uuid(), created_at: now, capacity: 1, location: null, note: null, ...r });
    save(); return ok();
  }
  if (q.op === "update") { db[table].filter(match).forEach((r) => Object.assign(r, q.payload)); save(); return ok(); }
  if (q.op === "delete") {
    const del = new Set(db[table].filter(match).map((r) => r.id));
    db[table] = db[table].filter((r) => !del.has(r.id));
    if (table === "slots") db.bookings = db.bookings.filter((b) => !del.has(b.slot_id));
    save(); return ok();
  }
  let rows = enrich(table, visible(table)).filter(match);
  if (q.order) { const [fld, asc] = q.order; rows.sort((a, c) => cmp(get(a, fld) ?? "", get(c, fld) ?? "") * (asc ? 1 : -1)); }
  if (q.single) return rows[0] ? ok(rows[0]) : fail("Nessun risultato");
  return ok(rows);
}

/* ---------- funzioni del database (RPC) ---------- */
const CANCEL_HOURS = 24;
async function rpc(name, a) {
  await wait();
  const u = me(); if (!u) return fail("Non autenticato");
  const active = (sid) => db.bookings.filter((b) => b.slot_id === sid && b.status === "confirmed");
  switch (name) {
    case "list_slots":
      return ok(db.slots.filter((s) => s.starts_at >= a.p_from && s.starts_at < a.p_to)
        .sort((x, y) => cmp(x.starts_at, y.starts_at))
        .map((s) => ({ ...clone(s), booked: active(s.id).length, mine: active(s.id).find((b) => b.student_id === u.id)?.id ?? null })));
    case "book_slot": {
      const s = db.slots.find((x) => x.id === a.p_slot);
      if (!s) return fail("Turno non trovato");
      if (new Date(s.starts_at) <= new Date()) return fail("Questo turno è già iniziato");
      if (active(s.id).some((b) => b.student_id === u.id)) return fail("Hai già prenotato questo turno");
      if (active(s.id).length >= s.capacity) return fail("Turno al completo");
      const id = uuid();
      db.bookings.push({ id, slot_id: s.id, student_id: u.id, topics: String(a.p_topics || "").trim().slice(0, 2000), status: "confirmed", created_at: iso(new Date()), cancelled_at: null });
      save(); return ok(id);
    }
    case "cancel_booking": {
      const b = db.bookings.find((x) => x.id === a.p_booking);
      if (!b) return fail("Prenotazione non trovata");
      if (b.student_id !== u.id && !isAdmin()) return fail("Non autorizzato");
      const s = db.slots.find((x) => x.id === b.slot_id);
      if (!isAdmin() && new Date(s.starts_at) - new Date() < CANCEL_HOURS * 3600e3)
        return fail(`Puoi disdire solo fino a ${CANCEL_HOURS} ore prima. Scrivi al tutor.`);
      b.status = "cancelled"; b.cancelled_at = iso(new Date()); save(); return ok();
    }
    case "update_topics": {
      const b = db.bookings.find((x) => x.id === a.p_booking && x.status === "confirmed" && (x.student_id === u.id || isAdmin()));
      if (!b) return fail("Prenotazione non trovata");
      b.topics = String(a.p_topics || "").trim().slice(0, 2000); save(); return ok();
    }
  }
  return fail("Funzione sconosciuta: " + name);
}

/* ---------- edge function simulata ---------- */
async function invoke(_name, { body }) {
  await wait(250);
  const u = me(); if (!u) return ok({ error: "Sessione scaduta" });
  const adminOnly = () => (isAdmin() ? null : ok({ error: "Operazione riservata al tutor" }));
  switch (body.action) {
    case "notify_booking":
      console.info("[demo] notifica simulata:", body.event, body.booking_id);
      return ok({ results: [{ channel: "email (simulata)", ok: true }, { channel: "whatsapp (simulato)", ok: true }] });
    case "test_notify":
      return adminOnly() || ok({ results: [
        { channel: "email tutor", ok: true, error: "simulata: in demo non parte nulla" },
        { channel: "whatsapp tutor", ok: true, error: "simulato: in demo non parte nulla" }] });
    case "feed_url":
      return adminOnly() || ok({ url: "https://TUO-PROGETTO.supabase.co/functions/v1/tutor-api?feed=… (disponibile dopo il deploy)" });
    case "create_student": {
      const e = adminOnly(); if (e) return e;
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !String(body.full_name || "").trim()) return ok({ error: "Nome ed email sono obbligatori" });
      if (String(body.password || "").length < 8) return ok({ error: "La password deve avere almeno 8 caratteri" });
      if (db.profiles.some((p) => p.email === email)) return ok({ error: "Esiste già un account con questa email" });
      const id = uuid();
      db.profiles.push({ id, full_name: body.full_name.trim(), email, phone: body.phone?.trim() || null, role: "student", active: true, whatsapp_apikey: null, created_at: iso(new Date()) });
      db.passwords[email] = body.password; save();
      return ok({ id, results: body.send_welcome ? [{ channel: "email benvenuto (simulata)", ok: true }] : [] });
    }
    case "update_student": {
      const e = adminOnly(); if (e) return e;
      const p = db.profiles.find((x) => x.id === body.id); if (!p) return ok({ error: "Studente non trovato" });
      for (const k of ["full_name", "phone", "whatsapp_apikey", "active"]) if (k in body) p[k] = body[k] === "" ? null : body[k];
      if (body.password) db.passwords[p.email] = body.password;
      save(); return ok({ ok: true });
    }
    case "delete_student": {
      const e = adminOnly(); if (e) return e;
      if (body.id === u.id) return ok({ error: "Non puoi eliminare il tuo account" });
      db.profiles = db.profiles.filter((p) => p.id !== body.id);
      db.bookings = db.bookings.filter((b) => b.student_id !== body.id);
      save(); return ok({ ok: true });
    }
  }
  return ok({ error: "Azione sconosciuta" });
}

/* ---------- auth ---------- */
export function createDemoClient() {
  load();
  const listeners = [];
  const session = () => (db.session ? clone(db.session) : null);
  const emit = (ev) => listeners.forEach((cb) => cb(ev, session()));
  return {
    from, rpc, functions: { invoke },
    auth: {
      onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb("INITIAL_SESSION", session()), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        await wait(200);
        email = String(email).trim().toLowerCase();
        const p = db.profiles.find((x) => x.email === email);
        if (!p || db.passwords[email] !== password) return fail("Invalid login credentials");
        if (!p.active && p.role !== "admin") return fail("Utente sospeso: contatta il tutor");
        db.session = { user: { id: p.id, email }, access_token: "demo" }; save(); emit("SIGNED_IN");
        return ok({ session: session() });
      },
      async signOut() { db.session = null; save(); emit("SIGNED_OUT"); return { error: null }; },
      async updateUser({ password }) { const u = me(); if (u && password) { db.passwords[u.email] = password; save(); } return ok({}); },
      async resetPasswordForEmail() { return fail("In modalità demo non vengono inviate email: la password di tutti è demo1234"); },
    },
  };
}
