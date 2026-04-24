import { useState, useEffect, useCallback, useRef } from "react";

// ─── SUPABASE CONFIG ─────────────────────────────────────────────────
const SUPABASE_URL = "https://ajbbkpmvpirxbvyfobpj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqYmJrcG12cGlyeGJ2eWZvYnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDg2MTEsImV4cCI6MjA5MTc4NDYxMX0.KEWpKmJJnDg2e-vCVXH6pNUTDijpbLxdHsNQ5Yyndig";

// ─── SQL (run once in Supabase SQL editor) ───────────────────────────
// create table courses (
//   id uuid primary key default gen_random_uuid(),
//   created_by uuid references auth.users,
//   name text not null,
//   holes jsonb not null,
//   is_shared boolean default true,
//   created_at timestamptz default now()
// );
// alter table courses enable row level security;
// create policy "read all courses" on courses for select using (true);
// create policy "own courses" on courses for insert with check (auth.uid() = created_by);
//
// create table rounds (
//   id uuid primary key default gen_random_uuid(),
//   user_id uuid references auth.users not null,
//   course_id uuid references courses,
//   date date not null,
//   course_name text,
//   tees text,
//   playing_hcp int default 0,
//   weather text,
//   notes text,
//   holes jsonb not null,
//   score_gross int,
//   score_net int,
//   score_diff numeric(4,1),
//   stableford int,
//   total_putts int,
//   total_gir int,
//   total_fairways int,
//   total_ud_conv int,
//   total_ud_chances int,
//   sg_off_tee numeric(4,2),
//   sg_approach numeric(4,2),
//   sg_short numeric(4,2),
//   sg_putting numeric(4,2),
//   created_at timestamptz default now()
// );
// alter table rounds enable row level security;
// create policy "own rounds" on rounds for all using (auth.uid() = user_id);
//
// create table training_sessions (
//   id uuid primary key default gen_random_uuid(),
//   user_id uuid references auth.users not null,
//   date date not null,
//   type text,
//   duration_min int,
//   focus text,
//   notes text,
//   created_at timestamptz default now()
// );
// alter table training_sessions enable row level security;
// create policy "own sessions" on training_sessions for all using (auth.uid() = user_id);

// ─── OFFLINE SYNC QUEUE ──────────────────────────────────────────────
// Stores pending writes when offline; flushes when online
const QUEUE_KEY = "golf_sync_queue";
const DRAFT_KEY = "golf_round_draft";

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function enqueue(table, data) {
  const q = loadQueue();
  q.push({ id: crypto.randomUUID(), table, data, ts: Date.now() });
  saveQueue(q);
}

// Draft auto-save (current in-progress round)
function saveDraft(draft) { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } }
function clearDraft() { localStorage.removeItem(DRAFT_KEY); }

// ─── SUPABASE CLIENT ─────────────────────────────────────────────────
const sb = {
  token: null, userId: null,
  h() { return { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${this.token || SUPABASE_ANON_KEY}` }; },
  async signIn(e, p) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: this.h(), body: JSON.stringify({ email: e, password: p }) });
    const d = await r.json();
    if (d.access_token) { this.token = d.access_token; this.userId = d.user?.id; localStorage.setItem("golf_token", d.access_token); localStorage.setItem("golf_uid", d.user?.id); }
    return d;
  },
  async signUp(e, p) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, { method: "POST", headers: this.h(), body: JSON.stringify({ email: e, password: p }) });
    return r.json();
  },
  restoreSession() {
    const t = localStorage.getItem("golf_token");
    const u = localStorage.getItem("golf_uid");
    if (t && u) { this.token = t; this.userId = u; return true; }
    return false;
  },
  logout() { this.token = null; this.userId = null; localStorage.removeItem("golf_token"); localStorage.removeItem("golf_uid"); },
  async insert(table, data) {
    if (!navigator.onLine) { enqueue(table, data); return { offline: true }; }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: "POST", headers: { ...this.h(), Prefer: "return=representation" }, body: JSON.stringify(data) });
    return r.json();
  },
  async select(table, q = "") {
    if (!navigator.onLine) return null; // caller handles null = offline
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}&order=created_at.desc`, { headers: this.h() });
    return r.json();
  },
  async update(table, id, data) {
    if (!navigator.onLine) { enqueue(table, { ...data, id }); return { offline: true }; }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method: "PATCH", headers: { ...this.h(), Prefer: "return=representation" }, body: JSON.stringify(data) });
    return r.json();
  },
  async flushQueue() {
    const q = loadQueue();
    if (!q.length || !navigator.onLine) return 0;
    let flushed = 0;
    const remaining = [];
    for (const item of q) {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${item.table}`, { method: "POST", headers: { ...this.h(), Prefer: "return=representation" }, body: JSON.stringify(item.data) });
        if (r.ok) flushed++;
        else remaining.push(item);
      } catch { remaining.push(item); }
    }
    saveQueue(remaining);
    return flushed;
  },
};

// ─── HELPERS ─────────────────────────────────────────────────────────
const DEFAULT_PAR = [4,4,3,4,5,3,4,4,5, 4,3,5,4,4,3,5,4,4];
const DEFAULT_HCP = [1,11,15,3,7,17,9,13,5, 2,16,6,12,4,18,8,14,10];
const WEATHER = ["☀️ Sonnig","⛅ Bewölkt","🌧️ Regen","💨 Windig","❄️ Kalt"];
const TRAINING_TYPES = { range:"🏌️ Driving Range", putting:"⛳ Putting Green", short_game:"🎯 Short Game", course:"⛳ Trainingsrunde", fitness:"💪 Fitness" };

// Haptic feedback helper
function haptic(style = "light") {
  if (navigator.vibrate) {
    navigator.vibrate(style === "light" ? 12 : style === "medium" ? 25 : 40);
  }
}

function calcRound(holeScores, coursePars, playingHcp) {
  let gross=0, net=0, stableford=0, putts=0, gir=0, fw=0, udConv=0, udCh=0;
  holeScores.forEach((h, i) => {
    const par = coursePars[i] || 4;
    const hcpIdx = DEFAULT_HCP[i] || (i+1);
    const strokes = hcpIdx <= Math.abs(playingHcp) ? Math.sign(playingHcp) : 0;
    const sc = Number(h.score) || 0;
    if (sc > 0) {
      gross += sc;
      net += sc - strokes;
      stableford += Math.max(0, par + 2 + strokes - sc);
    }
    if (h.putts) putts += Number(h.putts);
    if (h.gir) gir++;
    if (h.fairway) fw++;
    if (h.ud) { udCh++; if (h.ud_conv) udConv++; }
  });
  return { gross, net, stableford, putts, gir, fw, udConv, udCh };
}

function toPar(score, par) {
  const d = score - par;
  if (d <= -2) return { label: d === -2 ? "Eagle" : "Albatross", color: "#1a3d2b" };
  if (d === -1) return { label: "Birdie", color: "#4a9e6b" };
  if (d === 0) return { label: "Par", color: "#555" };
  if (d === 1) return { label: "Bogey", color: "#c8a84b" };
  if (d === 2) return { label: "Doppel", color: "#d84315" };
  return { label: `+${d}`, color: "#b71c1c" };
}

// ─── STYLES ──────────────────────────────────────────────────────────
const G = { green:"#1a3d2b", gm:"#2e6b47", gl:"#4a9e6b", gp:"#e8f5ee", ink:"#0f1a14", mu:"#6b7c72", bd:"#d4dfd8", bg:"#f7faf8", w:"#fff", red:"#c0392b", gold:"#c8a84b" };

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow-x:hidden}
body{font-family:'DM Sans',sans-serif;background:${G.bg};color:${G.ink};min-height:100vh;-webkit-font-smoothing:antialiased;overscroll-behavior:none}

/* PWA safe areas */
.safe-top{padding-top:env(safe-area-inset-top,0px)}
.safe-bottom{padding-bottom:max(env(safe-area-inset-bottom,0px),16px)}

/* Typography */
input,select,textarea{font-family:'DM Sans',sans-serif;font-size:16px;background:${G.w};border:1px solid ${G.bd};border-radius:9px;padding:10px 13px;width:100%;color:${G.ink};outline:none;transition:border .15s;-webkit-appearance:none}
input:focus,select:focus,textarea:focus{border-color:${G.gl};box-shadow:0 0 0 3px rgba(74,158,107,.12)}
input[type=number]{-moz-appearance:textfield}
input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}

/* Buttons — large touch targets for gloves */
button{font-family:'DM Sans',sans-serif;cursor:pointer;border:none;border-radius:9px;font-size:14px;transition:transform .1s,opacity .1s;-webkit-user-select:none;user-select:none;min-height:44px}
button:active{transform:scale(.96);opacity:.85}
.btn{background:${G.green};color:#fff;padding:12px 22px;font-weight:500;min-height:50px}
.btn:hover{background:${G.gm}}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.btn-sm{background:${G.green};color:#fff;padding:8px 16px;font-size:13px;font-weight:500;min-height:40px}
.btn-ghost{background:transparent;border:1px solid ${G.bd};color:${G.mu};padding:10px 18px;min-height:50px}
.btn-ghost:hover{border-color:${G.gl};color:${G.green}}
.btn-ghost-sm{background:transparent;border:1px solid ${G.bd};color:${G.mu};padding:7px 14px;font-size:13px;min-height:40px}
label{font-size:11px;font-weight:500;color:${G.mu};display:block;margin-bottom:5px;letter-spacing:.04em;text-transform:uppercase}
.card{background:${G.w};border:1px solid ${G.bd};border-radius:13px;padding:16px 18px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stitle{font-size:10px;font-weight:500;color:${G.mu};letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}

/* Offline banner */
.offline-bar{background:#d84315;color:#fff;text-align:center;font-size:12px;padding:6px;font-weight:500;position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:center;gap:6px}
.sync-bar{background:${G.green};color:#fff;text-align:center;font-size:12px;padding:6px;font-weight:500;animation:fadeout 3s forwards}
@keyframes fadeout{0%,70%{opacity:1}100%{opacity:0;display:none}}

/* Scorecard-specific large touch targets */
.score-btn{flex:1;min-height:64px;border-radius:9px;background:${G.w};color:${G.ink};border:1.5px solid ${G.bd};font-size:18px;font-weight:500;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;transition:transform .1s,background .12s,border-color .12s}
.score-btn .sub{font-size:9px;opacity:.65;font-weight:400}
.score-btn.on{background:${G.green};color:#fff;border-color:${G.green}}
.score-btn.bird-style{border-color:${G.gl};color:${G.gl}}
.score-btn.dbl-style{border-color:#e57373;color:#e57373}
.score-btn:active{transform:scale(.93)}

.putt-btn{width:56px;min-height:56px;border-radius:9px;background:${G.w};color:${G.ink};border:1.5px solid ${G.bd};font-size:20px;font-weight:500;cursor:pointer;transition:transform .1s,background .12s}
.putt-btn.on{background:${G.green};color:#fff;border-color:${G.green}}
.putt-btn:active{transform:scale(.93)}

.tog{padding:10px 16px;border-radius:22px;font-size:13px;font-weight:500;background:${G.w};color:${G.mu};border:1.5px solid ${G.bd};cursor:pointer;min-height:44px;transition:all .12s}
.tog.on{background:${G.gp};color:${G.gm};border-color:${G.gl}}
.tog:active{transform:scale(.95)}

/* Hole grid */
.hb{width:38px;height:38px;border-radius:7px;background:${G.w};color:${G.ink};border:2px solid ${G.bd};font-size:12px;font-weight:500;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.2;min-height:unset;transition:transform .1s}
.hb .hsc{font-size:9px;opacity:.7}
.hb.eagle{background:${G.green};border-color:${G.green};color:#fff}
.hb.birdie{background:${G.gp};border-color:${G.gl};color:${G.green}}
.hb.bogey{background:#fff8e1;border-color:#f0c040;color:#7a6000}
.hb.dbl{background:#fdecea;border-color:#f5c6c6;color:${G.red}}
.hb.cur{background:${G.green}!important;border-color:${G.green}!important;color:#fff!important}
.hb:active{transform:scale(.9)}

/* Round card */
.rcard{background:${G.w};border:1px solid ${G.bd};border-radius:13px;padding:14px 18px;margin-bottom:9px;cursor:pointer;transition:border-color .15s,box-shadow .15s;-webkit-user-select:none}
.rcard:active{border-color:${G.gl};box-shadow:0 2px 12px rgba(0,0,0,.07)}
`;

// ─── ONLINE/OFFLINE BANNER ────────────────────────────────────────────
function NetworkBanner({ onSync }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [synced, setSynced] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const up = () => { setOnline(true); handleSync(); };
    const dn = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", dn);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", dn); };
  }, []);

  const handleSync = async () => {
    const q = loadQueue();
    if (!q.length) return;
    setSyncing(true);
    const n = await sb.flushQueue();
    setSyncing(false);
    if (n > 0) { setSynced(n); onSync && onSync(); setTimeout(() => setSynced(0), 3500); }
  };

  if (!online) return <div className="offline-bar">📡 Offline — Eingaben werden lokal gespeichert</div>;
  if (syncing) return <div className="sync-bar">🔄 Synchronisiere {loadQueue().length} Einträge…</div>;
  if (synced > 0) return <div className="sync-bar">✅ {synced} Einträge synchronisiert</div>;
  return null;
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────
const Stat = ({ label, value, sub, accent, small }) => (
  <div style={{ background: accent ? G.green : G.w, border: `1px solid ${G.bd}`, borderRadius: 10, padding: small ? "10px 12px" : "13px 16px" }}>
    <div style={{ fontSize: 10, color: accent ? "rgba(255,255,255,.6)" : G.mu, fontWeight: 500, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
    <div style={{ fontSize: small ? 18 : 22, fontFamily: "'DM Serif Display'", color: accent ? "#fff" : G.ink, lineHeight: 1.1 }}>{value ?? <span style={{ color: G.mu, fontSize: 14 }}>—</span>}</div>
    {sub && <div style={{ fontSize: 10, color: accent ? "rgba(255,255,255,.5)" : G.mu, marginTop: 2 }}>{sub}</div>}
  </div>
);

// ─── AUTH ─────────────────────────────────────────────────────────────
function Auth({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setErr(""); setLoading(true);
    const d = mode === "login" ? await sb.signIn(email, pw) : await sb.signUp(email, pw);
    setLoading(false);
    if (d.access_token) onAuth();
    else if (d.error_description || d.msg) setErr(d.error_description || d.msg);
    else if (mode === "signup" && d.user) setErr("Bitte bestätige deine E-Mail, dann kannst du dich einloggen.");
  };

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: G.green, backgroundImage: "radial-gradient(circle at 20% 80%,rgba(74,158,107,.3),transparent 50%)", padding: "20px 16px" }}>
      <div style={{ width: "100%", maxWidth: 380, background: G.w, borderRadius: 18, padding: "40px 32px", boxShadow: "0 24px 64px rgba(0,0,0,.25)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>⛳</div>
          <div style={{ fontFamily: "'DM Serif Display'", fontSize: 26, color: G.green }}>Golf Companion</div>
          <div style={{ fontSize: 13, color: G.mu, marginTop: 4 }}>Dein persönliches Golf-Logbuch</div>
        </div>
        <div style={{ marginBottom: 14 }}><label>E-Mail</label><input type="email" inputMode="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" onKeyDown={e => e.key === "Enter" && handle()} /></div>
        <div style={{ marginBottom: 20 }}><label>Passwort</label><input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && handle()} /></div>
        {err && <div style={{ color: G.red, fontSize: 13, marginBottom: 14, padding: "10px 13px", background: "#fdecea", borderRadius: 8 }}>{err}</div>}
        <button className="btn" style={{ width: "100%" }} onClick={handle} disabled={loading}>{loading ? "…" : mode === "login" ? "Einloggen" : "Registrieren"}</button>
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: G.mu }}>
          {mode === "login" ? "Noch kein Konto? " : "Schon registriert? "}
          <span style={{ color: G.gm, cursor: "pointer", fontWeight: 500 }} onClick={() => { setMode(mode === "login" ? "signup" : "login"); setErr(""); }}>
            {mode === "login" ? "Registrieren" : "Einloggen"}
          </span>
        </div>
        <div style={{ marginTop: 20, padding: "10px 12px", background: "#fff8e1", borderRadius: 8, fontSize: 11, color: "#7a6000", lineHeight: 1.6 }}>
          <strong>Setup:</strong> Supabase URL + Anon Key in Zeile 4–5 eintragen. SQL-Kommentar im Code einmalig im Supabase SQL-Editor ausführen.
        </div>
      </div>
    </div>
  );
}

// ─── COURSE EDITOR ────────────────────────────────────────────────────
function CourseEditor({ onSave, onCancel, initial }) {
  const [name, setName] = useState(initial?.name || "");
  const [holes, setHoles] = useState(initial?.holes || DEFAULT_PAR.map((par, i) => ({ par, hcp: DEFAULT_HCP[i] })));
  const [saving, setSaving] = useState(false);

  const setHole = (i, key, val) => setHoles(h => h.map((x, j) => j === i ? { ...x, [key]: Number(val) || 0 } : x));
  const totalPar = holes.reduce((s, h) => s + (h.par || 0), 0);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    haptic("medium");
    if (initial?.id) await sb.update("golf_courses", initial.id, { name, holes });
    else await sb.insert("golf_courses", { created_by: sb.userId, name, holes, is_shared: true });
    setSaving(false); onSave();
  };

  const half = (from, to) => (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 52px 52px", gap: 6, marginBottom: 6, paddingBottom: 6, borderBottom: `1px solid ${G.bd}` }}>
        <div style={{ fontSize: 9, color: G.mu, fontWeight: 500 }}>L</div>
        <div />
        <div style={{ fontSize: 9, color: G.mu, fontWeight: 500, textAlign: "center" }}>PAR</div>
        <div style={{ fontSize: 9, color: G.mu, fontWeight: 500, textAlign: "center" }}>HCP</div>
      </div>
      {holes.slice(from, to).map((h, idx) => {
        const i = from + idx;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "28px 1fr 52px 52px", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: G.mu }}>{i + 1}</div>
            <div />
            <input type="number" min={3} max={5} value={h.par} onChange={e => setHole(i, "par", e.target.value)} style={{ textAlign: "center", padding: "8px 4px", fontSize: 14 }} />
            <input type="number" min={1} max={18} value={h.hcp} onChange={e => setHole(i, "hcp", e.target.value)} style={{ textAlign: "center", padding: "8px 4px", fontSize: 14 }} />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="card">
      <div style={{ fontFamily: "'DM Serif Display'", fontSize: 20, marginBottom: 18 }}>{initial ? "Platz bearbeiten" : "Neuer Platz"}</div>
      <div style={{ marginBottom: 16 }}><label>Platzname</label><input value={name} onChange={e => setName(e.target.value)} placeholder="z.B. GC Bildstein" /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 16 }}>
        <div><div style={{ fontSize: 10, fontWeight: 500, color: G.mu, letterSpacing: ".05em", marginBottom: 8 }}>VORDERNEUN (1–9)</div>{half(0, 9)}</div>
        <div><div style={{ fontSize: 10, fontWeight: 500, color: G.mu, letterSpacing: ".05em", marginBottom: 8 }}>HINTERNEUN (10–18)</div>{half(9, 18)}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, color: G.mu }}>Platz-Par: <strong style={{ color: G.ink }}>{totalPar}</strong></div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost-sm" onClick={onCancel}>Abbrechen</button>
          <button className="btn-sm" onClick={save} disabled={saving || !name.trim()}>{saving ? "…" : "Speichern"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── COURSE LIST ──────────────────────────────────────────────────────
function CourseList({ onSelect }) {
  const [courses, setCourses] = useState([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => { const d = await sb.select("golf_courses", ""); if (Array.isArray(d)) setCourses(d); };
  useEffect(() => { load(); }, []);

  if (adding) return <CourseEditor onSave={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />;
  if (editing) return <CourseEditor initial={editing} onSave={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div><div style={{ fontFamily: "'DM Serif Display'", fontSize: 22 }}>Plätze</div></div>
        <button className="btn-sm" onClick={() => { haptic(); setAdding(true); }}>+ Platz anlegen</button>
      </div>
      {courses.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontFamily: "'DM Serif Display'", fontSize: 18, marginBottom: 6 }}>Noch keine Plätze</div>
          <div style={{ fontSize: 13, color: G.mu, marginBottom: 16 }}>Lege deinen ersten Platz an</div>
          <button className="btn" onClick={() => setAdding(true)}>Platz anlegen</button>
        </div>
      ) : courses.map(c => (
        <div key={c.id} className="rcard" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ fontWeight: 500, fontSize: 15 }}>{c.name}</div><div style={{ fontSize: 12, color: G.mu, marginTop: 2 }}>18 Löcher · Par {c.holes.reduce((s, h) => s + (h.par || 0), 0)}</div></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost-sm" onClick={() => setEditing(c)}>Bearbeiten</button>
            {onSelect && <button className="btn-sm" onClick={() => { haptic(); onSelect(c); }}>Auswählen</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── HOLE-BY-HOLE SCORECARD ───────────────────────────────────────────
function Scorecard({ course, playingHcp, onFinish, onCancel }) {
  const pars = course.holes.map(h => h.par);
  const totalPar = pars.reduce((s, p) => s + p, 0);
  const emptyHole = () => ({ score: "", putts: "", gir: false, fairway: false, ud: false, ud_conv: false, sand: false, sand_save: false });

  // Restore draft if exists
  const initHoles = () => {
    const draft = loadDraft();
    if (draft?.courseId === course.id) return draft.holes;
    return Array(18).fill(null).map(emptyHole);
  };

  const [holes, setHoles] = useState(initHoles);
  const [active, setActive] = useState(0);
  const [view, setView] = useState("entry");
  const touchStartX = useRef(null);

  // Auto-save draft after every hole change
  useEffect(() => {
    saveDraft({ courseId: course.id, playingHcp, holes, ts: Date.now() });
  }, [holes]);

  const setH = (i, key, val) => setHoles(h => h.map((x, j) => j === i ? { ...x, [key]: val } : x));
  const togH = (i, key) => { haptic("light"); setHoles(h => h.map((x, j) => j === i ? { ...x, [key]: !x[key] } : x)); };

  const calc = calcRound(holes, pars, playingHcp);
  const filledCount = holes.filter(h => Number(h.score) > 0).length;

  // Swipe to navigate holes
  const onTouchStart = e => { touchStartX.current = e.touches[0].clientX; };
  const onTouchEnd = e => {
    if (touchStartX.current === null || view !== "entry") return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) < 50) return;
    if (dx < 0 && active < 17) { haptic("light"); setActive(a => a + 1); }
    if (dx > 0 && active > 0) { haptic("light"); setActive(a => a - 1); }
    touchStartX.current = null;
  };

  const h = holes[active];
  const par = pars[active];
  const sc = Number(h.score) || 0;
  const tp = sc > 0 ? toPar(sc, par) : null;

  const HoleBtn = ({ i }) => {
    const hh = holes[i]; const pp = pars[i]; const s = Number(hh.score);
    const d = s > 0 ? s - pp : null;
    let cls = "hb";
    if (i === active) cls += " cur";
    else if (d != null) { if (d <= -2) cls += " eagle"; else if (d === -1) cls += " birdie"; else if (d === 1) cls += " bogey"; else if (d >= 2) cls += " dbl"; }
    return (
      <div className={cls} onClick={() => { haptic("light"); setActive(i); }}>
        <span>{s > 0 ? s : i + 1}</span>
        {s > 0 && <span className="hsc">{d <= -2 ? "E" : d === -1 ? "B" : d === 0 ? "P" : `+${d}`}</span>}
      </div>
    );
  };

  return (
    <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* Header */}
      <div style={{ background: G.green, margin: "0 -16px", padding: `calc(env(safe-area-inset-top,0px) + 14px) 16px 0`, backgroundImage: "radial-gradient(circle at 80% 0%,rgba(74,158,107,.2),transparent 60%)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: "'DM Serif Display'", fontSize: 18, color: "#fff" }}>{course.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.6)" }}>HCP {playingHcp >= 0 ? "+" : ""}{playingHcp} · Par {totalPar}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.55)" }}>Brutto · {filledCount}/18</div>
            <div style={{ fontFamily: "'DM Serif Display'", fontSize: 28, color: "#fff", lineHeight: 1 }}>{filledCount > 0 ? calc.gross : "—"}</div>
          </div>
        </div>
        {/* Hole grid */}
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", paddingBottom: 14 }}>
          {holes.map((_, i) => <HoleBtn key={i} i={i} />)}
        </div>
      </div>

      {view === "entry" && (
        <div style={{ paddingTop: 14 }}>
          <div className="card" style={{ marginBottom: 12 }}>
            {/* Hole header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontFamily: "'DM Serif Display'", fontSize: 24 }}>Loch {active + 1}</div>
                <div style={{ fontSize: 13, color: G.mu }}>Par {par} · HCP {course.holes[active].hcp}</div>
              </div>
              {tp && <span style={{ fontSize: 12, fontWeight: 500, color: tp.color, background: tp.color + "22", padding: "4px 12px", borderRadius: 20 }}>{tp.label}</span>}
            </div>

            {/* Score — large buttons */}
            <div style={{ fontSize: 10, fontWeight: 500, color: G.mu, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 8 }}>Score</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 18 }}>
              {[par - 2, par - 1, par, par + 1, par + 2, par + 3].map(v => {
                if (v < 1) return null;
                const d = v - par;
                const isOn = Number(h.score) === v;
                let cls = "score-btn";
                if (isOn) cls += " on";
                else if (d < 0) cls += " bird-style";
                else if (d >= 2) cls += " dbl-style";
                return (
                  <button key={v} className={cls} onClick={() => { haptic("light"); setH(active, "score", v); }}>
                    <div>{v}</div>
                    <div className="sub">{d <= -2 ? "Eagle" : d === -1 ? "Birdie" : d === 0 ? "Par" : d === 1 ? "Bogey" : d === 2 ? "Dbl" : `+${d}`}</div>
                  </button>
                );
              })}
            </div>

            {/* Putts — large buttons */}
            <div style={{ fontSize: 10, fontWeight: 500, color: G.mu, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 8 }}>Putts</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {[0, 1, 2, 3, 4].map(v => (
                <button key={v} className={`putt-btn${Number(h.putts) === v ? " on" : ""}`} onClick={() => { haptic("light"); setH(active, "putts", v); }}>{v}</button>
              ))}
            </div>

            {/* Toggles */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { key: "gir", label: "GIR", show: true },
                { key: "fairway", label: "Fairway", show: par >= 4 },
                { key: "ud", label: "U&D Versuch", show: true },
                { key: "ud_conv", label: "U&D ✓", show: h.ud },
                { key: "sand", label: "Sand Versuch", show: true },
                { key: "sand_save", label: "Sand Save ✓", show: h.sand },
              ].filter(t => t.show).map(t => (
                <button key={t.key} className={`tog${h[t.key] ? " on" : ""}`} onClick={() => togH(active, t.key)}>
                  {h[t.key] ? "✓ " : ""}{t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Navigation */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {active > 0 && <button className="btn-ghost" onClick={() => { haptic(); setActive(a => a - 1); }}>← Loch {active}</button>}
            <div style={{ flex: 1 }} />
            {active < 17
              ? <button className="btn" onClick={() => { haptic(); setActive(a => a + 1); }}>Loch {active + 2} →</button>
              : <button className="btn" style={{ background: G.gold }} onClick={() => { haptic("medium"); setView("summary"); }}>Runde abschliessen →</button>
            }
          </div>

          <div style={{ textAlign: "center", fontSize: 11, color: G.mu, marginBottom: 4 }}>← Swipe zum Wechseln →</div>

          <button className="btn-ghost" style={{ width: "100%", marginTop: 4 }} onClick={() => {
            if (window.confirm("Runde abbrechen? Der aktuelle Fortschritt ist als Entwurf gespeichert.")) { onCancel(); }
          }}>Abbrechen</button>
        </div>
      )}

      {view === "summary" && (
        <ScorecardSummary holes={holes} course={course} playingHcp={playingHcp} calc={calc}
          onBack={() => setView("entry")}
          onSave={async extra => {
            haptic("medium");
            const payload = {
              user_id: sb.userId, course_id: course.id, course_name: course.name,
              date: new Date().toISOString().split("T")[0], playing_hcp: playingHcp,
              holes, score_gross: calc.gross, score_net: calc.net, stableford: calc.stableford,
              total_putts: calc.putts, total_gir: calc.gir, total_fairways: calc.fw,
              total_ud_conv: calc.udConv, total_ud_chances: calc.udCh,
              weather: extra.weather, notes: extra.notes,
              sg_off_tee: extra.sg_off_tee || null, sg_approach: extra.sg_approach || null,
              sg_short: extra.sg_short || null, sg_putting: extra.sg_putting || null,
            };
            await sb.insert("golf_rounds", payload);
            clearDraft();
            onFinish();
          }}
        />
      )}
    </div>
  );
}

function ScorecardSummary({ holes, course, playingHcp, calc, onBack, onSave }) {
  const pars = course.holes.map(h => h.par);
  const totalPar = pars.reduce((s, p) => s + p, 0);
  const grossDiff = calc.gross - totalPar;
  const [extra, setExtra] = useState({ weather: "", notes: "", sg_off_tee: "", sg_approach: "", sg_short: "", sg_putting: "" });
  const [showSG, setShowSG] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <div style={{ paddingTop: 14 }}>
      {/* Scorecard table */}
      <div className="card" style={{ marginBottom: 12, overflowX: "auto" }}>
        <div style={{ fontFamily: "'DM Serif Display'", fontSize: 18, marginBottom: 14 }}>Scorecard</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${G.bd}` }}>
              <th style={{ textAlign: "left", padding: "4px 5px", color: G.mu, fontWeight: 500 }}>Loch</th>
              {holes.map((_, i) => <th key={i} style={{ padding: "4px 3px", color: G.mu, fontWeight: 500, minWidth: 20, textAlign: "center" }}>{i + 1}</th>)}
              <th style={{ padding: "4px 5px", color: G.mu, fontWeight: 500, textAlign: "center" }}>∑</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: `1px solid ${G.bd}` }}>
              <td style={{ padding: "4px 5px", color: G.mu, fontSize: 11 }}>Par</td>
              {pars.map((p, i) => <td key={i} style={{ textAlign: "center", padding: "4px 2px", color: G.mu }}>{p}</td>)}
              <td style={{ textAlign: "center", padding: "4px 5px", fontWeight: 500 }}>{totalPar}</td>
            </tr>
            <tr style={{ borderBottom: `1px solid ${G.bd}` }}>
              <td style={{ padding: "4px 5px", fontWeight: 500 }}>Score</td>
              {holes.map((h, i) => {
                const sc = Number(h.score); const d = sc > 0 ? sc - pars[i] : null;
                return <td key={i} style={{ textAlign: "center", padding: "3px 2px" }}>
                  {sc > 0 ? <span style={{ display: "inline-block", width: 20, height: 20, borderRadius: d <= -1 ? 10 : 2, background: d <= -2 ? G.green : d === -1 ? G.gp : d === 1 ? "#fff8e1" : d >= 2 ? "#fdecea" : "transparent", border: d === 0 ? `1px solid ${G.bd}` : d >= 2 ? "1px solid #f5c6c6" : d === -1 ? `1px solid ${G.gl}` : "none", textAlign: "center", lineHeight: "20px", fontSize: 10, fontWeight: 500, color: d <= -2 ? "#fff" : d === -1 ? G.green : d >= 2 ? G.red : G.ink }}>{sc}</span> : "·"}
                </td>;
              })}
              <td style={{ textAlign: "center", padding: "4px 5px", fontFamily: "'DM Serif Display'", fontSize: 18, color: grossDiff < 0 ? G.gm : grossDiff > 2 ? G.red : G.ink }}>{calc.gross > 0 ? calc.gross : "—"}</td>
            </tr>
            <tr>
              <td style={{ padding: "4px 5px", color: G.mu, fontSize: 11 }}>Putts</td>
              {holes.map((h, i) => <td key={i} style={{ textAlign: "center", padding: "4px 2px", fontSize: 11, color: G.mu }}>{h.putts !== "" ? h.putts : "·"}</td>)}
              <td style={{ textAlign: "center", padding: "4px 5px", fontWeight: 500, fontSize: 12, color: G.mu }}>{calc.putts || "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="g4" style={{ marginBottom: 12 }}>
        <Stat label="Brutto" value={calc.gross || "—"} small accent />
        <Stat label="Netto" value={calc.net || "—"} small />
        <Stat label="Stableford" value={calc.stableford || "—"} small />
        <Stat label="To par" value={calc.gross > 0 ? (grossDiff > 0 ? `+${grossDiff}` : grossDiff === 0 ? "E" : `${grossDiff}`) : "—"} small />
        <Stat label="GIR" value={`${calc.gir}/18`} small />
        <Stat label="Putts" value={calc.putts || "—"} small />
        <Stat label="Fairways" value={calc.fw > 0 ? `${calc.fw}/${holes.filter((_, i) => pars[i] >= 4).length}` : "—"} small />
        <Stat label="U&D" value={calc.udCh > 0 ? `${calc.udConv}/${calc.udCh}` : "—"} small />
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="g2" style={{ marginBottom: 12 }}>
          <div><label>Wetter</label>
            <select value={extra.weather} onChange={e => setExtra(p => ({ ...p, weather: e.target.value }))}>
              <option value="">—</option>
              {WEATHER.map(w => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
          <div><label>Notizen</label><input value={extra.notes} onChange={e => setExtra(p => ({ ...p, notes: e.target.value }))} placeholder="Besonderheiten…" /></div>
        </div>
        <button className="btn-ghost-sm" onClick={() => setShowSG(!showSG)}>{showSG ? "▲" : "▼"} Strokes Gained (optional)</button>
        {showSG && (
          <div className="g4" style={{ marginTop: 12 }}>
            {[["sg_off_tee", "Off-tee"], ["sg_approach", "Approach"], ["sg_short", "Short Game"], ["sg_putting", "Putting"]].map(([k, l]) => (
              <div key={k}><label>{l}</label><input type="number" step=".01" value={extra[k]} onChange={e => setExtra(p => ({ ...p, [k]: e.target.value }))} placeholder="0.00" /></div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-ghost" onClick={onBack}>← Zurück</button>
        <button className="btn" style={{ flex: 1 }} disabled={saving || calc.gross === 0} onClick={async () => { setSaving(true); await onSave(extra); setSaving(false); }}>
          {saving ? "Speichern…" : "Runde speichern ✓"}
        </button>
      </div>
    </div>
  );
}

// ─── ROUND SETUP ──────────────────────────────────────────────────────
function RoundSetup({ onStart, onCancel }) {
  const [courses, setCourses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [hcp, setHcp] = useState(0);
  const [step, setStep] = useState("course");
  const draft = loadDraft();

  useEffect(() => { sb.select("golf_courses", "").then(d => { if (Array.isArray(d)) setCourses(d); }); }, []);

  if (step === "course") return (
    <div>
      {draft && (
        <div style={{ background: "#fff8e1", border: "1px solid #f0c040", borderRadius: 10, padding: "12px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ fontSize: 13, fontWeight: 500 }}>Entwurf vorhanden</div><div style={{ fontSize: 11, color: G.mu }}>Unterbrochene Runde fortsetzen?</div></div>
          <button className="btn-sm" style={{ background: G.gold }} onClick={() => {
            const c = courses.find(x => x.id === draft.courseId);
            if (c) { haptic("medium"); onStart(c, draft.playingHcp, true); }
          }}>Fortsetzen</button>
        </div>
      )}
      <div style={{ fontFamily: "'DM Serif Display'", fontSize: 22, marginBottom: 16 }}>Platz wählen</div>
      {courses.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 14, color: G.mu, marginBottom: 14 }}>Noch kein Platz angelegt</div>
          <button className="btn" onClick={() => onCancel("courses")}>Platz anlegen →</button>
        </div>
      ) : courses.map(c => (
        <div key={c.id} className="rcard" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          onClick={() => { haptic(); setSelected(c); setStep("hcp"); }}>
          <div><div style={{ fontWeight: 500 }}>{c.name}</div><div style={{ fontSize: 12, color: G.mu }}>Par {c.holes.reduce((s, h) => s + (h.par || 0), 0)}</div></div>
          <span style={{ color: G.gl, fontSize: 20 }}>→</span>
        </div>
      ))}
      <button className="btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => onCancel(null)}>Abbrechen</button>
    </div>
  );

  return (
    <div className="card">
      <div style={{ fontFamily: "'DM Serif Display'", fontSize: 20, marginBottom: 4 }}>{selected.name}</div>
      <div style={{ fontSize: 13, color: G.mu, marginBottom: 20 }}>Par {selected.holes.reduce((s, h) => s + (h.par || 0), 0)}</div>
      <div style={{ marginBottom: 24 }}>
        <label>Spielvorgabe (Playing Handicap)</label>
        <input type="number" value={hcp} min={-10} max={54} inputMode="numeric" onChange={e => setHcp(Number(e.target.value))} style={{ fontSize: 22, textAlign: "center", fontWeight: 500 }} />
        <div style={{ fontSize: 11, color: G.mu, marginTop: 6 }}>Negativ für Plus-HCP (z.B. −3 für HCP +3)</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-ghost" onClick={() => setStep("course")}>← Zurück</button>
        <button className="btn" style={{ flex: 1 }} onClick={() => { haptic("medium"); onStart(selected, hcp); }}>Runde starten →</button>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────
function Dashboard({ rounds, onAddRound }) {
  const [detail, setDetail] = useState(null);

  const last10 = rounds.slice(0, 10).filter(r => r.score_gross > 0);
  const avg = (key) => { const r = last10.filter(x => x[key]); return r.length ? (r.reduce((s, x) => s + x[key], 0) / r.length).toFixed(1) : null; };
  const udPct = () => { const r = last10.filter(x => x.total_ud_chances > 0); if (!r.length) return null; return Math.round(r.reduce((s, x) => s + x.total_ud_conv, 0) / r.reduce((s, x) => s + x.total_ud_chances, 0) * 100) + "%"; };

  const scores = rounds.slice(0, 20).reverse().map(r => r.score_gross).filter(Boolean);
  const sMin = Math.min(...scores) - 1, sMax = Math.max(...scores) + 1;
  const SW = 280, SH = 44;
  const toY = v => SH - ((v - sMin) / (sMax - sMin)) * SH;
  const path = scores.length > 1 ? scores.map((v, i) => `${i === 0 ? "M" : "L"} ${(i / (scores.length - 1)) * SW} ${toY(v).toFixed(1)}`).join(" ") : null;

  if (detail) return (
    <div>
      <button className="btn-ghost" style={{ marginBottom: 16 }} onClick={() => setDetail(null)}>← Zurück</button>
      <RoundDetail round={detail} />
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div><div style={{ fontFamily: "'DM Serif Display'", fontSize: 22 }}>Meine Runden</div><div style={{ fontSize: 12, color: G.mu, marginTop: 2 }}>{rounds.length} Runden</div></div>
        <button className="btn-sm" onClick={() => { haptic(); onAddRound(); }}>+ Neue Runde</button>
      </div>
      {last10.length > 0 && (
        <>
          <div className="g4" style={{ marginBottom: 12 }}>
            <Stat label="Ø Score" value={avg("score_gross")} sub="letzte 10" accent />
            <Stat label="Ø Putts" value={avg("total_putts")} />
            <Stat label="Ø GIR" value={avg("total_gir") ? `${avg("total_gir")}/18` : null} />
            <Stat label="U&D" value={udPct()} />
          </div>
          {path && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="stitle">Score-Verlauf (letzte {scores.length} Runden)</div>
              <svg width="100%" viewBox={`0 0 ${SW} ${SH}`} style={{ overflow: "visible" }}>
                <path d={path} fill="none" stroke={G.gl} strokeWidth="1.5" strokeLinejoin="round" />
                {scores.map((v, i) => <circle key={i} cx={(i / (scores.length - 1)) * SW} cy={toY(v)} r="3.5" fill={G.green} />)}
              </svg>
            </div>
          )}
        </>
      )}
      <div>
        {rounds.length === 0 ? (
          <div className="card" style={{ textAlign: "center", padding: "48px 20px" }}>
            <div style={{ fontFamily: "'DM Serif Display'", fontSize: 18, marginBottom: 8 }}>Noch keine Runden</div>
            <div style={{ fontSize: 13, color: G.mu }}>Lege zuerst einen Platz an, dann starte deine erste Runde.</div>
          </div>
        ) : rounds.map(r => <RoundCard key={r.id} r={r} onClick={() => setDetail(r)} />)}
      </div>
    </div>
  );
}

function RoundCard({ r, onClick }) {
  const diff = r.score_gross ? r.score_gross - 72 : null;
  return (
    <div className="rcard" onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div><div style={{ fontWeight: 500, fontSize: 14 }}>{r.course_name}</div><div style={{ fontSize: 12, color: G.mu, marginTop: 2 }}>{new Date(r.date).toLocaleDateString("de-AT", { day: "2-digit", month: "short", year: "numeric" })} {r.weather?.split(" ")[0]}</div></div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "'DM Serif Display'", fontSize: 24, color: diff != null ? (diff < 0 ? G.gm : diff > 2 ? G.red : G.ink) : G.ink }}>{r.score_gross || "—"}</div>
          {r.stableford && <div style={{ fontSize: 11, color: G.mu }}>{r.stableford} Pkt</div>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        {r.total_gir != null && <span style={{ fontSize: 12 }}><span style={{ color: G.mu, fontSize: 10, textTransform: "uppercase", letterSpacing: ".03em" }}>GIR </span>{r.total_gir}/18</span>}
        {r.total_putts && <span style={{ fontSize: 12 }}><span style={{ color: G.mu, fontSize: 10, textTransform: "uppercase", letterSpacing: ".03em" }}>Putts </span>{r.total_putts}</span>}
        {r.total_ud_chances > 0 && <span style={{ fontSize: 12 }}><span style={{ color: G.mu, fontSize: 10, textTransform: "uppercase", letterSpacing: ".03em" }}>U&D </span>{r.total_ud_conv}/{r.total_ud_chances}</span>}
      </div>
    </div>
  );
}

function RoundDetail({ round }) {
  const holes = round.holes || [];
  const pars = holes.map((_, i) => DEFAULT_PAR[i]);
  const totalPar = pars.reduce((s, p) => s + p, 0);
  const diff = round.score_gross - totalPar;
  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div><div style={{ fontFamily: "'DM Serif Display'", fontSize: 20 }}>{round.course_name}</div><div style={{ fontSize: 13, color: G.mu }}>{new Date(round.date).toLocaleDateString("de-AT", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })} {round.weather}</div></div>
          <div style={{ fontFamily: "'DM Serif Display'", fontSize: 32, color: diff < 0 ? G.gm : diff > 2 ? G.red : G.ink }}>{diff > 0 ? `+${diff}` : diff === 0 ? "E" : `${diff}`}</div>
        </div>
        <div className="g4">
          <Stat label="Brutto" value={round.score_gross} small />
          <Stat label="Netto" value={round.score_net} small />
          <Stat label="Stableford" value={round.stableford} small />
          <Stat label="GIR" value={round.total_gir != null ? `${round.total_gir}/18` : null} small />
          <Stat label="Putts" value={round.total_putts} small />
          <Stat label="U&D" value={round.total_ud_chances > 0 ? `${round.total_ud_conv}/${round.total_ud_chances}` : null} small />
        </div>
      </div>
      {holes.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <div className="stitle">Loch für Loch</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ borderBottom: `1px solid ${G.bd}` }}>
              {["L", "Par", "Score", "Putts", "GIR", "FW", "U&D"].map(h => <th key={h} style={{ padding: "4px 6px", color: G.mu, fontWeight: 500, textAlign: "center" }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {holes.map((h, i) => {
                const sc = Number(h.score); const d = sc > 0 ? sc - pars[i] : null;
                return <tr key={i} style={{ borderBottom: `1px solid ${G.bd}`, background: i % 2 === 0 ? G.bg : G.w }}>
                  <td style={{ padding: "5px 6px", textAlign: "center", fontWeight: 500 }}>{i + 1}</td>
                  <td style={{ padding: "5px 6px", textAlign: "center", color: G.mu }}>{pars[i]}</td>
                  <td style={{ padding: "5px 6px", textAlign: "center" }}>{sc > 0 ? <span style={{ fontWeight: 500, color: d < 0 ? G.gm : d > 1 ? G.red : G.ink }}>{sc}</span> : "—"}</td>
                  <td style={{ padding: "5px 6px", textAlign: "center", color: G.mu }}>{h.putts !== "" ? h.putts : "—"}</td>
                  <td style={{ padding: "5px 6px", textAlign: "center" }}>{h.gir ? "✓" : ""}</td>
                  <td style={{ padding: "5px 6px", textAlign: "center" }}>{h.fairway ? "✓" : pars[i] < 4 ? "·" : ""}</td>
                  <td style={{ padding: "5px 6px", textAlign: "center" }}>{h.ud ? (h.ud_conv ? "✓" : "✗") : "—"}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      {round.notes && <div style={{ marginTop: 12, padding: "12px 16px", background: G.gp, borderRadius: 10, fontSize: 13, color: G.green, lineHeight: 1.6 }}>{round.notes}</div>}
    </div>
  );
}

// ─── TRAINING LOG ─────────────────────────────────────────────────────
function TrainingLog({ sessions, onAdd }) {
  const [form, setForm] = useState(false);
  const [f, setF] = useState({ date: new Date().toISOString().split("T")[0], type: "range", duration: "", focus: "", notes: "" });
  const save = async () => {
    haptic("medium");
    await sb.insert("golf_training_sessions", { user_id: sb.userId, date: f.date, type: f.type, duration_min: Number(f.duration) || null, focus: f.focus, notes: f.notes });
    setForm(false); onAdd();
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ fontFamily: "'DM Serif Display'", fontSize: 22 }}>Training</div>
        <button className="btn-sm" onClick={() => { haptic(); setForm(!form); }}>+ Einheit</button>
      </div>
      {form && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="g2" style={{ marginBottom: 12 }}>
            <div><label>Datum</label><input type="date" value={f.date} onChange={e => setF(p => ({ ...p, date: e.target.value }))} /></div>
            <div><label>Art</label><select value={f.type} onChange={e => setF(p => ({ ...p, type: e.target.value }))}>{Object.entries(TRAINING_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          </div>
          <div className="g2" style={{ marginBottom: 12 }}>
            <div><label>Dauer (Min)</label><input type="number" inputMode="numeric" value={f.duration} onChange={e => setF(p => ({ ...p, duration: e.target.value }))} placeholder="60" /></div>
            <div><label>Fokus</label><input value={f.focus} onChange={e => setF(p => ({ ...p, focus: e.target.value }))} placeholder="z.B. Wedges 80-100m" /></div>
          </div>
          <div style={{ marginBottom: 12 }}><label>Notizen</label><textarea rows={2} value={f.notes} onChange={e => setF(p => ({ ...p, notes: e.target.value }))} style={{ resize: "none" }} /></div>
          <div style={{ display: "flex", gap: 8 }}><button className="btn-sm" onClick={save}>Speichern</button><button className="btn-ghost-sm" onClick={() => setForm(false)}>Abbrechen</button></div>
        </div>
      )}
      <div>
        {sessions.length === 0 ? (
          <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
            <div style={{ fontFamily: "'DM Serif Display'", fontSize: 18, marginBottom: 6 }}>Kein Training erfasst</div>
          </div>
        ) : sessions.map(s => (
          <div key={s.id} className="rcard">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div><div style={{ fontWeight: 500, fontSize: 14 }}>{TRAINING_TYPES[s.type] || s.type}{s.focus && ` — ${s.focus}`}</div><div style={{ fontSize: 12, color: G.mu, marginTop: 2 }}>{new Date(s.date).toLocaleDateString("de-AT", { day: "2-digit", month: "short", year: "numeric" })}</div></div>
              {s.duration_min && <div style={{ fontFamily: "'DM Serif Display'", fontSize: 20 }}>{s.duration_min}<span style={{ fontSize: 11, color: G.mu }}>min</span></div>}
            </div>
            {s.notes && <div style={{ fontSize: 12, color: G.mu, marginTop: 6 }}>{s.notes}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────
const TABS = [{ id: "rounds", label: "Runden" }, { id: "training", label: "Training" }, { id: "courses", label: "Plätze" }];

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState("rounds");
  const [rounds, setRounds] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [mode, setMode] = useState("list");
  const [activeCourse, setActiveCourse] = useState(null);
  const [activeHcp, setActiveHcp] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offlineRounds, setOfflineRounds] = useState([]);

  // Restore session on mount
  useEffect(() => {
    if (sb.restoreSession()) setAuthed(true);
  }, []);

  const loadRounds = useCallback(async () => {
    setLoading(true);
    const d = await sb.select("golf_rounds", `user_id=eq.${sb.userId}`);
    if (Array.isArray(d)) { setRounds(d); setOfflineRounds([]); }
    else {
      // Offline: show locally queued rounds as placeholders
      const q = loadQueue().filter(x => x.table === "golf_rounds");
      setOfflineRounds(q.map(x => ({ ...x.data, id: x.id, _offline: true })));
    }
    setLoading(false);
  }, []);

  const loadSessions = useCallback(async () => {
    const d = await sb.select("golf_training_sessions", `user_id=eq.${sb.userId}`);
    if (Array.isArray(d)) setSessions(d);
  }, []);

  useEffect(() => {
    if (authed) { loadRounds(); loadSessions(); }
  }, [authed]);

  const handleAuth = () => { setAuthed(true); };
  const logout = () => { sb.logout(); setAuthed(false); setRounds([]); setSessions([]); };

  if (!authed) return (<><style>{css}</style><Auth onAuth={handleAuth} /></>);

  const allRounds = [...rounds, ...offlineRounds];

  return (
    <>
      <style>{css}</style>
      <NetworkBanner onSync={() => { loadRounds(); loadSessions(); }} />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 16px", paddingBottom: "max(env(safe-area-inset-bottom, 0px), 32px)" }}>
        {/* Header */}
        <div style={{
          background: G.green, margin: "0 -16px",
          padding: `calc(env(safe-area-inset-top, 0px) + 16px) 20px 0`,
          marginBottom: 18,
          backgroundImage: "radial-gradient(circle at 80% 0%,rgba(74,158,107,.25),transparent 60%)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "'DM Serif Display'", fontSize: 21, color: "#fff", fontStyle: "italic" }}>⛳ Golf Companion</div>
            <button className="btn-ghost" style={{ color: "rgba(255,255,255,.7)", borderColor: "rgba(255,255,255,.2)", fontSize: 12, padding: "6px 12px", minHeight: 36 }} onClick={logout}>Abmelden</button>
          </div>
          <div style={{ display: "flex" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => { haptic("light"); setTab(t.id); setMode("list"); }}
                style={{ background: tab === t.id ? "rgba(255,255,255,.15)" : "transparent", color: "#fff", padding: "8px 18px", fontFamily: "'DM Sans'", fontSize: 14, borderRadius: "8px 8px 0 0", border: "none", opacity: tab === t.id ? 1 : .55, fontWeight: tab === t.id ? 500 : 400, minHeight: "unset" }}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <div style={{ textAlign: "center", color: G.mu, padding: 48, fontFamily: "'DM Serif Display'", fontSize: 18 }}>Laden…</div>}

        {!loading && tab === "rounds" && (
          mode === "list" ? <Dashboard rounds={allRounds} onAddRound={() => setMode("setup")} /> :
          mode === "setup" ? <RoundSetup
            onStart={(course, hcp, resume) => { setActiveCourse(course); setActiveHcp(hcp); setMode("playing"); }}
            onCancel={goto => { setMode("list"); if (goto === "courses") setTab("courses"); }}
          /> :
          mode === "playing" ? <Scorecard
            course={activeCourse} playingHcp={activeHcp}
            onFinish={() => { setMode("list"); loadRounds(); }}
            onCancel={() => setMode("list")}
          /> : null
        )}
        {!loading && tab === "training" && <TrainingLog sessions={sessions} onAdd={loadSessions} />}
        {!loading && tab === "courses" && <CourseList />}
      </div>
    </>
  );
}
