const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");

let config = {};
let catalog = { cards: [], rarities: {} };
let me = null;
let timerInterval = null;
let adminTab = "dashboard";
let pendingEdit = null;

// ---------- Utilitaires ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(url, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Erreur"), { data, status: res.status });
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image illisible")); };
    img.src = url;
  });
}

// Redimensionne l'image côté navigateur pour garder des fichiers légers.
async function fileToDataUrl(file, maxSide, type, quality) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality);
}

function avatarHtml(p, size = "") {
  if (p.avatar) return `<img class="avatar ${size}" src="${esc(p.avatar)}" alt="">`;
  return `<span class="avatar ${size} ph">${esc((p.name || "?").trim().charAt(0).toUpperCase())}</span>`;
}

// ---------- Cartes ----------
function artHtml(c) {
  if (c.image) return `<img src="${esc(c.image)}" alt="" loading="lazy">`;
  return `<span class="emo">${esc(c.emoji || "🎴")}</span>`;
}

function cardHtml(c, o = {}) {
  const r = catalog.rarities[c.rarity] || { label: c.rarity };
  const cls = ["card", c.rarity];
  if (o.locked) cls.push("locked");
  if (o.animate) cls.push("reveal-in");
  if (o.pick) cls.push("pick");
  if (o.selected) cls.push("selected");
  const style = `--h:${Number(c.hue) || 0};${o.animate ? `animation-delay:${o.delay || 0}ms` : ""}`;
  const head = `<div class="${cls.join(" ")}" style="${style}" data-id="${Number(c.id)}">`;
  const tag = `<span class="tag">${esc(r.label)}</span>`;
  if (o.locked) return `${head}<div class="art"><span class="emo">?</span>${tag}</div><div class="meta"><h3>Carte inconnue</h3><p>Pas encore découverte</p></div></div>`;
  return `${head}<div class="art">${artHtml(c)}${tag}${o.count > 1 ? `<span class="count">x${o.count}</span>` : ""}</div><div class="meta"><h3>${esc(c.name)}</h3><p>${esc(c.desc)}</p></div></div>`;
}


// ---------- Fiche d'une carte (clic) ----------
function dropRate(c, setId) {
  const rs = catalog.rarities;
  const pool = catalog.cards.filter((x) => (x.sets || ["douzieme"]).includes(setId));
  const present = Object.keys(rs).filter((k) => pool.some((x) => x.rarity === k));
  const total = present.reduce((n, k) => n + rs[k].weight, 0);
  if (!total || !present.includes(c.rarity)) return 0;
  return ((rs[c.rarity].weight / total) * 100) / pool.filter((x) => x.rarity === c.rarity).length;
}
function closeCardModal() { const m = $("#cardModal"); if (m) m.remove(); document.body.classList.remove("no-scroll"); }
function openCardModal(id) {
  const c = catalog.cards.find((x) => x.id === id);
  if (!c) return;
  closeCardModal();
  XII.Sound.play("open");
  const r = catalog.rarities[c.rarity] || { label: c.rarity };
  const n = (me && me.collection && me.collection[c.id]) || 0;
  const m = document.createElement("div");
  m.id = "cardModal";
  m.className = "modal";
  m.innerHTML = `<div class="modal-box ${esc(c.rarity)}" style="--h:${Number(c.hue) || 0}" role="dialog" aria-modal="true">
    <button class="modal-x" aria-label="Fermer">×</button>
    <div class="modal-art">${artHtml(c)}</div>
    <div class="modal-info">
      <span class="tag">${esc(r.label)}</span>
      <h2>${esc(c.name)}</h2>
      <p class="modal-desc">${esc(c.desc) || "<em>Aucune description.</em>"}</p>
      <dl class="facts">
        <dt>Numéro</dt><dd>#${Number(c.id)}</dd>
        <dt>Booster${(c.sets || []).length > 1 ? "s" : ""}</dt><dd>${esc((c.sets || ["douzieme"]).map((id) => packTheme(id).name).join(" + "))}</dd>
        <dt>Probabilité</dt><dd>${(c.sets || ["douzieme"]).map((id) => `${dropRate(c, id).toFixed(2)} %${(c.sets || []).length > 1 ? ` (${esc(packTheme(id).name)})` : ""}`).join(" · ")} par tirage</dd>
        <dt>Tes exemplaires</dt><dd>${n || "Pas encore obtenue"}</dd>
      </dl>
      ${me && me.isAdmin ? `<div class="actions"><button class="btn small" data-m-edit>Modifier</button><button class="btn small danger" data-m-del>Supprimer</button></div>` : ""}
    </div></div>`;
  document.body.appendChild(m);
  document.body.classList.add("no-scroll");
  m.onclick = (e) => { if (e.target === m) closeCardModal(); };
  $(".modal-x", m).onclick = closeCardModal;
  const ed = $("[data-m-edit]", m), del = $("[data-m-del]", m);
  if (ed) ed.onclick = () => { closeCardModal(); adminTab = "cards"; pendingEdit = c.id; if (location.hash === "#/admin") render(); else location.hash = "#/admin"; };
  if (del) del.onclick = async () => {
    if (!confirm(`Supprimer « ${c.name} » ? Elle disparaîtra aussi des collections et des vitrines.`)) return;
    try {
      await api(`/api/admin/cards/${c.id}`, "DELETE");
      catalog = await api("/api/catalog");
      me = (await api("/api/me")).user;
      closeCardModal();
      toast("Carte supprimée");
      render();
    } catch (err) { toast(err.message, true); }
  };
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCardModal(); });
document.addEventListener("click", (e) => {
  const el = e.target.closest(".card[data-id]");
  if (!el || el.closest("#cardModal") || el.classList.contains("locked") || el.classList.contains("pick")) return;
  if (e.target.closest("button, a, input, select, label")) return;
  const id = Number(el.dataset.id);
  if (id > 0) openCardModal(id);
});

function filtersHtml(cur) {
  const keys = ["all", ...Object.keys(catalog.rarities)];
  return keys.map((k) => `<button class="chip ${cur === k ? "active" : ""}" data-k="${esc(k)}">${k === "all" ? "Toutes" : esc(catalog.rarities[k].label)}</button>`).join("");
}

// Affiche une collection avec filtres par rareté. getColl() renvoie { idCarte: quantité }.
function mountCollection({ filters, grid, progress }, getColl) {
  let f = "all";
  const draw = () => {
    const coll = getColl();
    filters.innerHTML = filtersHtml(f);
    $$(".chip", filters).forEach((b) => (b.onclick = () => { f = b.dataset.k; draw(); }));
    grid.innerHTML = catalog.cards
      .filter((c) => f === "all" || c.rarity === f)
      .map((c) => (coll[c.id] ? cardHtml(c, { count: coll[c.id] }) : cardHtml(c, { locked: true })))
      .join("");
    if (progress) {
      const found = catalog.cards.filter((c) => coll[c.id]).length;
      progress.textContent = `${found} / ${catalog.cards.length} cartes découvertes`;
    }
  };
  draw();
  return draw;
}

// ---------- Couleurs du texte ----------
const TEXT_THEMES = [
  { id: "os",        label: "Reiatsu (défaut)", text: "#f4f7ff", muted: "#8a93b8", accent: "#8ff6ff" },
  { id: "or",        label: "Bankai orange", text: "#ffe9d2", muted: "#c9a07a", accent: "#ff8a1f" },
  { id: "blanc",     label: "Blanc pur",   text: "#ffffff", muted: "#b9b9c2", accent: "#f0d28a" },
  { id: "vermillon", label: "Vermillon",   text: "#ffd9d2", muted: "#c9908a", accent: "#ff6a57" },
  { id: "jade",      label: "Jade",        text: "#d8f5e4", muted: "#8fb5a0", accent: "#6fe3a6" },
  { id: "azur",      label: "Azur",        text: "#d9ebff", muted: "#8fa6c4", accent: "#7ec0ff" },
  { id: "lavande",   label: "Lavande",     text: "#eadfff", muted: "#a898c4", accent: "#c3a2ff" },
  { id: "rose",      label: "Rose sakura", text: "#ffe3ee", muted: "#c79aae", accent: "#ff9ec4" },
];

function applyTextTheme() {
  const t = TEXT_THEMES.find((x) => x.id === (me && me.textTheme)) || TEXT_THEMES[0];
  const st = document.documentElement.style;
  st.setProperty("--bone", t.text);
  st.setProperty("--muted", t.muted);
  st.setProperty("--gold-hi", t.accent);
}

// ---------- Fond d'écran ----------
const WP_URL = "/default-wallpaper.jpg";
// Adresse de l'image d'un fond : « custom » = ma photo (privée), sinon un fond prédéfini.
function wallpaperUrl(w, thumb = false) {
  if (w.source === "custom" && w.custom) return `/api/wallpaper?v=${w.v}`;
  const id = w.source && w.source !== "custom" ? w.source : "default";
  if (id === "default") return thumb ? "/wallpapers/default-thumb.jpg" : WP_URL;
  return `/wallpapers/${id}${thumb ? "-thumb" : ""}.jpg`;
}
function applyWallpaper() {
  const w = (me && me.wallpaper) || { custom: false, source: "default", blur: 6, dim: 45, v: 0 };
  const el = $("#wallpaper");
  const dim = $("#wallpaperDim");
  document.body.classList.add("has-wallpaper");
  el.style.backgroundImage = `url(${wallpaperUrl(w)})`;
  el.style.filter = `blur(${w.blur}px)`;
  dim.style.background = `rgba(0,0,0,${w.dim / 100})`;
}

// ---------- Navigation ----------
function renderNav() {
  const nav = $("#nav");
  if (!me) { nav.innerHTML = ""; return; }
  const links = [["", "Accueil"], ["joueurs", "Joueurs"], ["tickets", "Tickets"], ["code", "Code"]];
  if (me.isAdmin) links.push(["admin", "Admin"]);
  links.push(["reglages", "Réglages"]);
  nav.innerHTML =
    links.map(([k, l]) => `<a href="#/${k}" data-r="${k}">${l}</a>`).join("") +
    `<a href="#/joueur/${esc(me.pid)}" data-r="moi">${avatarHtml(me, "sm")}<span>${esc(me.name)}</span></a>` +
    `<button class="btn small" id="logout">Déconnexion</button>`;
  $("#logout").onclick = async () => {
    await api("/auth/logout", "POST");
    location.hash = "#/";
    boot();
  };
}

function setActiveNav(name, arg) {
  const key = name === "joueur" && me && arg === me.pid ? "moi" : name === "joueur" ? "joueurs" : name;
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.r === key));
}

// ---------- Connexion ----------
function renderLogin() {
  $("#loginBox").innerHTML = `<a class="btn big" href="/auth/discord">Se connecter avec Discord</a>`;
  const rank = { mythic: -1, legendary: 0, epic: 1, rare: 2, common: 3 };
  const show = [...catalog.cards].sort((a, b) => rank[a.rarity] - rank[b.rarity] || a.id - b.id);
  const pick = [show[1], show[0], show[2]].filter(Boolean); // une épique de chaque côté d'une légendaire au centre
  $("#fan").innerHTML = pick.map((c) => cardHtml(c)).join("");
}


// ---------- Pack animé (booster 12e Division) ----------
const PACK_CARDS = 3;
// Habillage de chaque booster (couleurs et textes du pack).
const SERIF_CJK = "'Hiragino Mincho ProN','Yu Mincho','Noto Serif CJK JP',serif";
const PACK_THEMES = {
  douzieme: { name: "12e Division", acc: "#e10600", bg: "#070709", tri: "#2a0305", dia: "#1a0204", dark: "#9c0008", glow: "225,6,0", serif: "Georgia,serif",
    mark: "XII", kanji: "十二", edition: "ÉDITION 12", title: "12E DIVISION", titleSize: 42, titleSp: 3, medal: "XII", medalY: 564, medalSize: 16, set: "SET 01", pm: "60,8,14" },
  yamato: { name: "Yamato", acc: "#f0b429", bg: "#070a14", tri: "#0b1a42", dia: "#0a1432", dark: "#a87a0a", glow: "240,180,41", serif: SERIF_CJK,
    mark: "大和", kanji: "大和", edition: "ÉDITION 02", title: "YAMATO", titleSize: 46, titleSp: 5, medal: "和", medalY: 565, medalSize: 18, set: "SET 02", pm: "13,31,82" },
};
const packTheme = (id) => PACK_THEMES[id] || PACK_THEMES.douzieme;
const PACK_SHAPE = "M190 54 L200 40 L210 54 L220 40 L230 54 L240 40 L250 54 L260 40 L270 54 L280 40 L290 54 L300 40 L310 54 L320 40 L330 54 L340 40 L350 54 L360 40 L370 54 L380 40 L390 54 L400 40 L410 54 L420 40 L430 54 L440 40 L450 54 L460 40 L470 54 L480 40 L490 54 L490 586 L480 600 L470 586 L460 600 L450 586 L440 600 L430 586 L420 600 L410 586 L400 600 L390 586 L380 600 L370 586 L360 600 L350 586 L340 600 L330 586 L320 600 L310 586 L300 600 L290 586 L280 600 L270 586 L260 600 L250 586 L240 600 L230 586 L220 600 L210 586 L200 600 L190 586 Z";
// Ligne de déchirure en dents de scie (y ≈ 100) : le pack est dessiné deux fois, découpé en haut / en bas.
const PACK_CUT = (() => { const p = []; for (let x = 190, i = 0; x <= 490; x += 15, i++) p.push([x, i % 2 ? 108 : 92]); return p; })();
const ptsStr = (a) => a.map((q) => q.join(",")).join(" ");
function packDefsHtml() {
  const up = [[150, 0], [550, 0], [550, 100], ...[...PACK_CUT].reverse(), [150, 100]];
  const dn = [[150, 100], ...PACK_CUT, [550, 100], [550, 700], [150, 700]];
  return `<svg class="packx-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
    <path id="xp-shape" d="${PACK_SHAPE}"/><clipPath id="xp-pk"><use href="#xp-shape"/></clipPath>
    ${Object.entries(PACK_THEMES).map(([k, t]) => `<pattern id="xp-dots-${k}" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.4" fill="${t.acc}" opacity="0.4"/></pattern>`).join("")}
    <clipPath id="xp-up"><polygon points="${ptsStr(up)}"/></clipPath><clipPath id="xp-dn"><polygon points="${ptsStr(dn)}"/></clipPath>
  </defs></svg>`;
}
function packArtHtml(cut, set = "douzieme") {
  const T = packTheme(set);
  return `<svg viewBox="150 20 380 620" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><g clip-path="url(#xp-${cut})">
<ellipse class="sh" cx="340" cy="624" rx="130" ry="9" fill="#000000"></ellipse>
<g clip-path="url(#xp-pk)">
<rect x="190" y="40" width="300" height="560" fill="${T.bg}"></rect>
<polygon points="190,40 300,40 190,200" fill="${T.tri}"></polygon><polygon points="490,40 490,160 380,40" fill="${T.tri}"></polygon>
<rect x="190" y="40" width="300" height="320" fill="url(#xp-dots-${set})"></rect>
<g class="rot"><g stroke="${T.acc}" stroke-width="2" opacity=".3"><line x1="340" y1="245" x2="340" y2="-120"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(30 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(60 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(90 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(120 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(150 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(180 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(210 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(240 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(270 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(300 340 245)"></line><line x1="340" y1="245" x2="340" y2="-120" transform="rotate(330 340 245)"></line></g></g>
<g class="dm"><polygon points="340,52 500,245 340,438 180,245" fill="${T.dia}" stroke="${T.acc}" stroke-width="4"></polygon><polygon points="340,68 482,245 340,422 198,245" fill="none" stroke="#f2f2f2" stroke-width="1.5"></polygon><polygon points="340,84 464,245 340,406 216,245" fill="none" stroke="${T.acc}" stroke-width="1" stroke-dasharray="6 6"></polygon>
<text x="340" y="112" text-anchor="middle" font-size="20" font-family="${T.serif}" font-weight="700" fill="${T.acc}" letter-spacing="3">${T.mark}</text><text x="340" y="400" text-anchor="middle" font-size="20" font-family="${T.serif}" font-weight="700" fill="${T.acc}" letter-spacing="3">${T.mark}</text></g>
<circle class="sun" cx="340" cy="245" r="100" fill="${T.acc}"></circle>
<circle class="pls" cx="340" cy="245" r="86" fill="${T.dark}"></circle>
<circle cx="340" cy="245" r="76" fill="none" stroke="${T.bg}" stroke-width="3"></circle>
<circle class="rotf" cx="340" cy="245" r="112" fill="none" stroke="#f2f2f2" stroke-width="2" stroke-dasharray="34 10 4 10"></circle>
<text class="kj" x="340" y="268" text-anchor="middle" font-size="76" font-family="'Hiragino Mincho ProN','Yu Mincho','Noto Serif CJK JP',serif" fill="${T.bg}" letter-spacing="3">${T.kanji}</text>
<g class="sl"><polygon points="190,335 490,165 490,205 190,375" fill="${T.acc}"></polygon><polygon points="190,375 490,205 490,211 190,381" fill="#f2f2f2"></polygon><polygon points="190,329 490,159 490,165 190,335" fill="${T.bg}"></polygon></g>
<g class="bl"><line x1="250" y1="412" x2="448" y2="150" stroke="#f2f2f2" stroke-width="7" stroke-linecap="round"></line><line x1="250" y1="412" x2="448" y2="150" stroke="${T.bg}" stroke-width="1.5"></line><line x1="236" y1="431" x2="214" y2="460" stroke="${T.bg}" stroke-width="12" stroke-linecap="round"></line><line x1="236" y1="431" x2="214" y2="460" stroke="${T.acc}" stroke-width="5" stroke-dasharray="3 5"></line><circle cx="248" cy="414" r="12" fill="${T.bg}" stroke="${T.acc}" stroke-width="3"></circle></g>
<g fill="#f2f2f2"><circle class="tw" style="--d:0s" cx="205" cy="130" r="5"></circle><circle class="tw" style="--d:.4s" cx="470" cy="106" r="3.5"></circle><circle class="tw" style="--d:.8s" cx="478" cy="330" r="4"></circle><circle class="tw" style="--d:.2s" cx="202" cy="300" r="3"></circle></g>
<rect x="190" y="440" width="300" height="160" fill="${T.bg}"></rect><rect x="190" y="440" width="300" height="5" fill="${T.acc}"></rect><rect x="190" y="450" width="300" height="1.5" fill="#f2f2f2"></rect>
<rect x="190" y="68" width="92" height="24" fill="${T.acc}"></rect><text x="236" y="85" text-anchor="middle" font-size="12" font-family="'Arial Black',Impact,sans-serif" fill="${T.bg}" letter-spacing="2">${T.edition}</text>
<text class="gl" x="340" y="494" text-anchor="middle" font-size="${T.titleSize}" font-family="Impact,'Arial Black',sans-serif" fill="${T.acc}" letter-spacing="${T.titleSp}">${T.title}</text>
<text x="340" y="494" text-anchor="middle" font-size="${T.titleSize}" font-family="Impact,'Arial Black',sans-serif" fill="#f2f2f2" letter-spacing="${T.titleSp}">${T.title}</text>
<text x="340" y="518" text-anchor="middle" font-size="14" font-family="'Arial Black',Impact,sans-serif" fill="${T.acc}" letter-spacing="6">BOOSTER PACK</text>
<circle class="md" cx="340" cy="558" r="22" fill="${T.acc}" stroke="#f2f2f2" stroke-width="2"></circle><text x="340" y="${T.medalY}" text-anchor="middle" font-size="${T.medalSize}" font-family="${T.serif}" font-weight="700" fill="${T.bg}">${T.medal}</text>
<text x="262" y="563" text-anchor="middle" font-size="12" font-family="'Arial Black',Impact,sans-serif" fill="#f2f2f2" letter-spacing="2">${T.set}</text><text x="418" y="563" text-anchor="middle" font-size="12" font-family="'Arial Black',Impact,sans-serif" fill="#f2f2f2" letter-spacing="2">${PACK_CARDS} CARTES</text>
<circle class="em" style="--d:0s;--x:12px" cx="220" cy="440" r="3" fill="${T.acc}"></circle><circle class="em" style="--d:.5s;--x:-10px" cx="260" cy="440" r="2" fill="#f2f2f2"></circle><circle class="em" style="--d:1s;--x:16px" cx="300" cy="440" r="3.5" fill="${T.acc}"></circle><circle class="em" style="--d:1.5s;--x:-14px" cx="340" cy="440" r="2" fill="${T.acc}"></circle><circle class="em" style="--d:.8s;--x:10px" cx="380" cy="440" r="3" fill="#f2f2f2"></circle><circle class="em" style="--d:2s;--x:-12px" cx="420" cy="440" r="3.5" fill="${T.acc}"></circle><circle class="em" style="--d:2.4s;--x:14px" cx="455" cy="440" r="2" fill="${T.acc}"></circle><circle class="em" style="--d:1.2s;--x:-8px" cx="240" cy="440" r="2.5" fill="${T.acc}"></circle><circle class="em" style="--d:2.8s;--x:9px" cx="400" cy="440" r="2" fill="#f2f2f2"></circle>
<rect class="shine" x="160" y="30" width="56" height="580" fill="#ffffff" opacity=".25"></rect>
</g>
<use href="#xp-shape" fill="none" stroke="${T.acc}" stroke-width="2.5"></use>
</g></svg>`;
}
function packHtml(set = "douzieme", withDefs = true) {
  return `${withDefs ? packDefsHtml() : ""}
    <span class="packx-tilt"><span class="packx-float">
      <span class="packx-half packx-bot">${packArtHtml("dn", set)}</span>
      <span class="packx-half packx-top">${packArtHtml("up", set)}</span>
    </span></span>
    <span class="packx-burst"></span>`;
}

// ---------- Ouverture d'un booster en grand (plein écran) ----------
const canOpenNow = () => Date.now() >= me.nextBoosterAt || (me.bonusBoosters || 0) > 0;

// Ouvre la scène : le booster en grand au milieu, bouton « Ouvrir » en bas. onClose reçoit les cartes du dernier tirage.
function openBoosterStage(setId, onClose) {
  const T = packTheme(setId);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const calm = () => document.body.classList.contains("fx-calm");
  const box = document.createElement("div");
  box.className = "pm";
  box.style.setProperty("--glow", T.glow);
  box.style.setProperty("--pm", T.pm);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Ouverture d'un booster");
  box.innerHTML = `
    <button class="pm-x" id="pmClose" aria-label="Fermer">×</button>
    <div class="pm-body">
      <h2 class="pm-title" id="pmTitle">Booster ${esc(T.name)}</h2>
      <div class="pm-stage" id="pmStage">
        <button class="packx" id="pmPack" aria-label="Ouvrir le booster ${esc(T.name)}">${packHtml(setId, false)}</button>
        <div class="pm-cards" id="pmCards" hidden></div>
      </div>
      <p class="pm-stock" id="pmStock"></p>
      <div class="pm-actions" id="pmActions"></div>
    </div>`;
  document.body.appendChild(box);
  document.body.classList.add("pm-open");

  const pack = $("#pmPack", box), tilt = $(".packx-tilt", pack);
  let busy = false, last = [];

  const stock = () => {
    const n = me.bonusBoosters || 0;
    $("#pmStock", box).innerHTML = n > 0 ? `🎁 <b>${n}</b> booster${n > 1 ? "s" : ""} en réserve` : "";
  };
  const close = () => {
    if (busy) return;
    document.removeEventListener("keydown", onKey);
    box.classList.add("leaving");
    document.body.classList.remove("pm-open");
    setTimeout(() => box.remove(), calm() ? 0 : 220);
    onClose(last);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $("#pmClose", box).onclick = close;
  box.addEventListener("click", (e) => { if (e.target === box) close(); });

  const showPack = () => {
    $("#pmCards", box).hidden = true;
    $("#pmCards", box).innerHTML = "";
    pack.hidden = false;
    pack.classList.remove("opening", "charging");
    pack.classList.add("back");
    setTimeout(() => pack.classList.remove("back"), 700);
    $("#pmTitle", box).textContent = `Booster ${T.name}`;
    stock();
    $("#pmActions", box).innerHTML = `<button class="btn big pm-go" id="pmGo">Ouvrir</button>`;
    $("#pmGo", box).onclick = go;
    $("#pmGo", box).focus();
  };

  const go = async () => {
    if (busy || !canOpenNow()) return;
    busy = true;
    $("#pmActions", box).innerHTML = "";
    tilt.style.transform = "";
    pack.classList.add("charging"); // le booster tremble pendant que le serveur tire les cartes
    try {
      const [data] = await Promise.all([api("/api/booster", "POST", { set: setId }), wait(calm() ? 0 : 900)]);
      me.collection = data.collection;
      me.nextBoosterAt = data.nextBoosterAt;
      me.bonusBoosters = data.bonusBoosters || 0;
      // Les plus communes d'abord, les plus rares à la fin (le serveur trie déjà, on le garantit ici aussi).
      const w = (c) => (catalog.rarities[c.rarity] || { weight: 0 }).weight;
      data.cards = [...data.cards].sort((x, y) => w(y) - w(x));
      last = data.cards;
      pack.classList.remove("charging");
      pack.classList.add("opening"); // déchirure : le haut s'envole, éclat de lumière
      XII.Sound.play("tear");
      await wait(calm() ? 0 : 1000);
      pack.hidden = true;
      const cards = $("#pmCards", box);
      cards.hidden = false;
      cards.innerHTML = data.cards.map((c, i) => cardHtml(c, { count: 1, animate: true, delay: i * 400 })).join("");
      $("#pmTitle", box).textContent = "Tes nouvelles cartes";
      data.cards.forEach((c, i) => XII.Sound.reveal(c.rarity, i * 0.4 + 0.05));
      stock();
      await wait(calm() ? 0 : data.cards.length * 400 + 500);
      busy = false;
      const again = canOpenNow();
      $("#pmActions", box).innerHTML =
        (again ? `<button class="btn big pm-go" id="pmAgain">Ouvrir un autre booster</button>` : "") +
        `<button class="btn ${again ? "ghost" : "big"}" id="pmDone">${again ? "Terminer" : "Continuer"}</button>`;
      if (again) $("#pmAgain", box).onclick = showPack;
      $("#pmDone", box).onclick = close;
      ($("#pmAgain", box) || $("#pmDone", box)).focus();
    } catch (err) {
      busy = false;
      if (err.data && err.data.nextBoosterAt) { me.nextBoosterAt = err.data.nextBoosterAt; me.bonusBoosters = err.data.bonusBoosters || 0; }
      toast(err.message, true);
      showPack();
    }
  };

  pack.onmouseenter = () => XII.Sound.play("packHover");
  pack.addEventListener("mousemove", (e) => {
    if (busy || calm()) return;
    const r = pack.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    tilt.style.transform = `rotateY(${x * 28}deg) rotateX(${-y * 20}deg)`;
  });
  pack.addEventListener("mouseleave", () => { tilt.style.transform = ""; });
  pack.onclick = go;
  showPack();
}

// ---------- Page : Accueil / boosters ----------
function formatRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

async function pageHome() {
  view.innerHTML = `
    <section class="panel booster">
      <div class="side">
        <div class="pack-pair" id="packPair" role="radiogroup" aria-label="Choisir un booster">
          ${(catalog.sets || [{ id: "douzieme" }]).map((s, i) => `<div class="pk-wrap" style="--glow:${packTheme(s.id).glow}">
            <button class="packx pk" data-set="${esc(s.id)}" role="radio" aria-label="Booster ${esc(packTheme(s.id).name)}">${packHtml(s.id, i === 0)}</button>
            <span class="pk-cap">${esc(packTheme(s.id).name)}</span></div>`).join("")}
        </div>
        <p id="stock" class="stock" hidden></p>
        <p id="timer"></p>
      </div>
      <div id="reveal" class="reveal-empty">Choisis un booster puis clique dessus pour l'ouvrir : tes trois cartes apparaîtront ici.</div>
    </section>
    <section class="panel">
      <div class="row"><h2>Ma collection</h2><span id="progress" class="muted"></span></div>
      <div id="filters" class="filters"></div>
      <div id="grid" class="cards"></div>
    </section>`;
  const redraw = mountCollection({ filters: $("#filters"), grid: $("#grid"), progress: $("#progress") }, () => me.collection);

  const updateStock = () => {
    const n = me.bonusBoosters || 0;
    const el = $("#stock");
    el.hidden = n <= 0;
    el.innerHTML = n > 0 ? `🎁 <b>${n}</b> booster${n > 1 ? "s" : ""} en réserve` : "";
  };
  // ----- Choix du booster : 12e Division à gauche, Yamato à droite. Clic sur l'autre = on change, clic sur celui choisi = on l'ouvre.
  const setIds = (catalog.sets || [{ id: "douzieme" }]).map((s) => s.id);
  let cur = setIds[0];
  try { const saved = localStorage.getItem("xii-set"); if (setIds.includes(saved)) cur = saved; } catch (e) { /* stockage indisponible */ }
  const packs = $$(".pk", $("#packPair"));
  const selPack = () => packs.find((b) => b.dataset.set === cur);
  const setDisabled = (flag) => { const s = selPack(); packs.forEach((b) => (b.disabled = flag && b === s)); };

  const updateTimer = () => {
    const left = me.nextBoosterAt - Date.now();
    const stock = me.bonusBoosters || 0;
    updateStock();
    if (left <= 0) {
      const wasWaiting = selPack().disabled;
      setDisabled(false);
      if (wasWaiting) XII.Sound.play("ready");
      $("#timer").textContent = stock > 0 ? "Booster gratuit prêt" : "Ton booster est prêt.";
      $("#timer").classList.add("ready");
      clearInterval(timerInterval);
    } else {
      setDisabled(stock <= 0);
      $("#timer").classList.toggle("ready", stock > 0);
      $("#timer").textContent = stock > 0
        ? `Ouvre un booster en réserve · gratuit dans ${formatRemaining(left)}`
        : `Prochain booster dans ${formatRemaining(left)}`;
    }
  };
  const startTimer = () => {
    clearInterval(timerInterval);
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  };
  const applySel = () => {
    packs.forEach((b) => {
      const on = b.dataset.set === cur;
      b.disabled = false;
      b.classList.toggle("sel", on);
      b.classList.toggle("alt", !on);
      b.setAttribute("aria-checked", String(on));
      b.parentElement.classList.toggle("sel", on);
      $(".packx-tilt", b).style.transform = "";
    });
  };
  applySel();

  packs.forEach((pack) => {
    const tilt = $(".packx-tilt", pack);
    pack.onmouseenter = () => { if (!pack.disabled) XII.Sound.play("packHover"); };
    // Inclinaison 3D du pack qui suit la souris (comme dans la maquette)
    pack.addEventListener("mousemove", (e) => {
      if (pack.disabled || document.body.classList.contains("fx-calm")) return;
      const r = pack.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      tilt.style.transform = `rotateY(${x * 28}deg) rotateX(${-y * 20}deg)`;
    });
    pack.addEventListener("mouseleave", () => { tilt.style.transform = ""; });
    pack.onclick = () => {
      if (pack.dataset.set !== cur) { // on change de booster
        cur = pack.dataset.set;
        try { localStorage.setItem("xii-set", cur); } catch (e) { /* ignoré */ }
        applySel();
        updateTimer();
        return;
      }
      if (pack.disabled) return;
      tilt.style.transform = "";
      // Le booster s'ouvre en grand au milieu de l'écran, avec le bouton « Ouvrir » en bas.
      openBoosterStage(cur, (cards) => {
        redraw();
        if (cards && cards.length) {
          const reveal = $("#reveal");
          reveal.className = "cards";
          reveal.innerHTML = cards.map((c) => cardHtml(c, { count: 1 })).join("");
        }
        startTimer();
      });
    };
  });
  startTimer();
}

// ---------- Page : Joueurs ----------
function playerTile(p, cmap) {
  const thumbs = p.showcase
    .map((id) => cmap.get(id))
    .filter(Boolean)
    .slice(0, 3)
    .map((c) => `<span class="${esc(c.rarity)}" style="--h:${Number(c.hue) || 0}">${c.image ? `<img src="${esc(c.image)}" alt="">` : esc(c.emoji || "🎴")}</span>`)
    .join("");
  return `<a class="player" href="#/joueur/${esc(p.pid)}">
    ${avatarHtml(p)}
    <div class="info"><strong>${esc(p.name)}</strong>
    <span class="muted">${p.unique}/${p.total} cartes${p.mythic ? ` · ${p.mythic} ✦` : ""}${p.legendary ? ` · ${p.legendary} ★` : ""}</span></div>
    <div class="mini">${thumbs}</div>
  </a>`;
}

async function pagePlayers() {
  view.innerHTML = `
    <section class="panel">
      <div class="row"><h2>Joueurs</h2><input class="input" id="q" placeholder="Rechercher un joueur"></div>
      <div id="plist" class="players"></div>
    </section>`;
  const { players } = await api("/api/players");
  const cmap = new Map(catalog.cards.map((c) => [c.id, c]));
  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const list = players.filter((p) => p.name.toLowerCase().includes(q));
    $("#plist").innerHTML = list.map((p) => playerTile(p, cmap)).join("") || `<p class="empty">Aucun joueur trouvé.</p>`;
  };
  $("#q").oninput = draw;
  draw();
}

// ---------- Page : Profil + vitrine ----------
async function pageProfile(pid) {
  const p = await api(`/api/players/${encodeURIComponent(pid)}`);
  const isMe = me.pid === p.pid;
  const cmap = new Map(catalog.cards.map((c) => [c.id, c]));
  view.innerHTML = `
    <section class="panel profile-head">
      ${avatarHtml(p, "lg")}
      <div class="grow">
        <h2>${esc(p.name)} ${isMe ? `<span class="chip-mini">toi</span>` : ""}</h2>
        <p class="muted">${p.unique}/${p.total} cartes · ${p.legendary} Légendaire${p.legendary > 1 ? "s" : ""}${p.mythic ? ` · ${p.mythic} Mythique${p.mythic > 1 ? "s" : ""}` : ""}</p>
      </div>
      ${isMe ? `<button class="btn small" id="editShow">Modifier ma vitrine</button>` : ""}
    </section>
    <section class="panel">
      <h2>Vitrine</h2>
      <div id="showcase" class="cards showcase"></div>
      <div id="showEditor"></div>
    </section>
    <section class="panel">
      <div class="row"><h2>Collection</h2><span id="progress" class="muted"></span></div>
      <div id="filters" class="filters"></div>
      <div id="grid" class="cards"></div>
    </section>`;

  const drawShowcase = () => {
    const cards = p.showcase.map((id) => cmap.get(id)).filter(Boolean);
    $("#showcase").outerHTML = cards.length
      ? `<div id="showcase" class="cards showcase">${cards.map((c) => cardHtml(c, { count: p.collection[c.id] })).join("")}</div>`
      : `<div id="showcase" class="empty">${isMe ? "Ta vitrine est vide : choisis tes cartes préférées avec « Modifier ma vitrine »." : "Cette vitrine est vide pour l'instant."}</div>`;
  };
  drawShowcase();
  mountCollection({ filters: $("#filters"), grid: $("#grid"), progress: $("#progress") }, () => p.collection);

  if (!isMe) return;
  const max = config.showcaseMax || 6;
  $("#editShow").onclick = () => {
    const sel = new Set(p.showcase);
    const owned = catalog.cards.filter((c) => p.collection[c.id]);
    const box = $("#showEditor");
    if (!owned.length) { box.innerHTML = `<p class="empty">Ouvre d'abord un booster pour avoir des cartes à exposer.</p>`; return; }
    box.innerHTML = `<div class="editor">
      <p class="muted">Clique sur tes cartes préférées (<strong id="selCount"></strong> / ${max}).</p>
      <div id="pick" class="cards"></div>
      <div class="actions" style="margin-top:16px">
        <button class="btn small" id="saveShow">Enregistrer</button>
        <button class="btn small ghost" id="cancelShow">Annuler</button>
      </div></div>`;
    const draw = () => {
      $("#selCount").textContent = sel.size;
      $("#pick").innerHTML = owned.map((c) => cardHtml(c, { count: p.collection[c.id], pick: true, selected: sel.has(c.id) })).join("");
      $$("#pick .card").forEach((el) => (el.onclick = () => {
        const id = Number(el.dataset.id);
        if (sel.has(id)) sel.delete(id);
        else if (sel.size < max) sel.add(id);
        else toast(`${max} cartes maximum dans la vitrine`, true);
        draw();
      }));
    };
    draw();
    $("#cancelShow").onclick = () => (box.innerHTML = "");
    $("#saveShow").onclick = async () => {
      try {
        const res = await api("/api/showcase", "PUT", { cardIds: [...sel] });
        p.showcase = res.showcase;
        me.showcase = res.showcase;
        box.innerHTML = "";
        drawShowcase();
        toast("Vitrine enregistrée ✨");
      } catch (err) {
        toast(err.message, true);
      }
    };
  };
}

// ---------- Page : Tickets ----------
const STATUS = { open: "En attente", accepted: "Acceptée", refused: "Refusée" };

const TICKET_KEEP = { open: "En attente", accepted: "Acceptée", refused: "Refusée" };
let ticketCtx = { map: new Map(), admin: false, reload: () => {} };
const ticketNum = (id) => String(id).padStart(4, "0");

// Ligne compacte dans une liste : un clic ouvre la fiche complète.
function ticketListItem(t, admin) {
  const who = admin ? (t.player.pid ? `<a href="#/joueur/${esc(t.player.pid)}">${esc(t.player.name)}</a>` : esc(t.player.name)) + " · " : "";
  const msg = t.message.length > 140 ? t.message.slice(0, 140) + "…" : t.message;
  return `<div class="ticket" data-tid="${t.id}" tabindex="0" role="button" aria-label="Ouvrir le ticket ${esc(t.subject)}">
    <div class="head"><strong>${esc(t.subject)}</strong><span class="status ${esc(t.status)}">${TICKET_KEEP[t.status] || esc(t.status)}</span></div>
    <span class="muted"><small>${who}${fmtDate(t.createdAt)}</small></span>
    <p class="tk-preview">${esc(msg)}</p>
    <span class="tk-hint">Ouvrir le ticket ›</span>
  </div>`;
}

function closeTicketModal() {
  const m = $("#ticketModal");
  if (m) m.remove();
  if (!$("#cardModal")) document.body.classList.remove("no-scroll");
}

function openTicketModal(id) {
  const t = ticketCtx.map.get(id);
  if (!t) return;
  closeTicketModal();
  XII.Sound.play("open");
  const admin = ticketCtx.admin;
  const granted = t.grantedCardId ? catalog.cards.find((c) => c.id === t.grantedCardId) : null;
  const done = t.status !== "open";
  const from = t.player.pid && admin ? `<a href="#/joueur/${esc(t.player.pid)}" data-tk-link>${esc(t.player.name)}</a>` : esc(t.player.name);
  const m = document.createElement("div");
  m.id = "ticketModal";
  m.className = "modal";
  m.innerHTML = `<div class="tk-wrap"><div class="tk ${esc(t.status)}" role="dialog" aria-modal="true" aria-label="Ticket ${ticketNum(t.id)}">
    <button class="modal-x" aria-label="Fermer">×</button>
    <div class="tk-stub">
      <span class="tk-mark">XII</span>
      <span class="tk-label">Demande de carte</span>
      <span class="tk-n"><small>N°</small>${ticketNum(t.id)}</span>
      <span class="tk-bar" aria-hidden="true"></span>
    </div>
    <div class="tk-main">
      <div class="tk-top"><span class="status ${esc(t.status)}">${TICKET_KEEP[t.status] || esc(t.status)}</span></div>
      <h2 class="${done ? "stamped" : ""}">${esc(t.subject)}</h2>
      <dl class="tk-meta">
        <dt>De</dt><dd>${from}</dd>
        <dt>Ouvert le</dt><dd>${fmtDate(t.createdAt)}</dd>
        ${t.resolvedAt ? `<dt>Traité le</dt><dd>${fmtDate(t.resolvedAt)}</dd>` : ""}
      </dl>
      <p class="tk-msg">${esc(t.message)}</p>
      ${granted ? `<button type="button" class="tk-gift" data-gift="${granted.id}"><span class="tk-gift-art">${artHtml(granted)}</span><span>🎁 Carte accordée<strong>${esc(granted.name)}</strong></span></button>` : ""}
      ${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}
      ${done ? `<div class="tk-stamp" aria-hidden="true">${esc(TICKET_KEEP[t.status] || t.status)}</div>` : ""}
      ${admin && !done ? `<div class="resolve">
        <select class="input grant"><option value="">Ne donner aucune carte</option>${cardOptions()}</select>
        <input class="input note-in" maxlength="300" placeholder="Message pour le joueur (optionnel)">
        <div class="actions"><button class="btn small ok" data-a="accept">Accepter</button><button class="btn small danger" data-a="refuse">Refuser</button></div>
      </div>` : ""}
      ${done || admin ? `<div class="tk-foot"><button class="btn small danger" data-del>🗑 Supprimer ce ticket</button></div>` : ""}
    </div>
  </div></div>`;
  document.body.appendChild(m);
  document.body.classList.add("no-scroll");
  m.onclick = (e) => { if (e.target === m) closeTicketModal(); };
  $(".modal-x", m).onclick = closeTicketModal;
  const link = $("[data-tk-link]", m);
  if (link) link.onclick = closeTicketModal;
  const gift = $("[data-gift]", m);
  if (gift) gift.onclick = () => { const cid = Number(gift.dataset.gift); closeTicketModal(); openCardModal(cid); };

  $$("[data-a]", m).forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/admin/tickets/${t.id}/resolve`, "POST", {
        action: b.dataset.a,
        grantCardId: $(".grant", m).value || undefined,
        note: $(".note-in", m).value,
      });
      toast(b.dataset.a === "accept" ? "Ticket accepté ✅" : "Ticket refusé");
      closeTicketModal();
      try { me = (await api("/api/me")).user; } catch (_) {}
      ticketCtx.reload();
    } catch (err) { toast(err.message, true); }
  }));

  const del = $("[data-del]", m);
  if (del) del.onclick = async () => {
    if (!confirm(`Supprimer définitivement le ticket « ${t.subject} » ?`)) return;
    try {
      await api(ticketCtx.admin ? `/api/admin/tickets/${t.id}` : `/api/tickets/${t.id}`, "DELETE");
      toast("Ticket supprimé");
      closeTicketModal();
      ticketCtx.reload();
    } catch (err) { toast(err.message, true); }
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTicketModal();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".ticket[data-tid]")) {
    e.preventDefault();
    openTicketModal(Number(e.target.dataset.tid));
  }
});
document.addEventListener("click", (e) => {
  const el = e.target.closest(".ticket[data-tid]");
  if (!el || e.target.closest("button, a, input, select, label")) return;
  openTicketModal(Number(el.dataset.tid));
});

async function pageTickets() {
  view.innerHTML = `
    <section class="panel narrow">
      <h2>Demander une carte</h2>
      <p class="muted">Explique ce que tu voudrais : un admin lira ta demande et te répondra ici.</p>
      <form id="tform" class="form">
        <label>Sujet<input class="input" id="tsubject" maxlength="80" required placeholder="Ex. : Je voudrais une carte pour mon personnage"></label>
        <label>Message<textarea class="input" id="tmsg" maxlength="600" rows="4" required></textarea></label>
        <button class="btn" type="submit">Envoyer le ticket</button>
      </form>
    </section>
    <section class="panel">
      <h2>Mes tickets</h2>
      <div id="tlist"></div>
    </section>`;
  const load = async () => {
    const { tickets } = await api("/api/tickets");
    ticketCtx = { map: new Map(tickets.map((t) => [t.id, t])), admin: false, reload: load };
    $("#tlist").innerHTML = tickets.length
      ? tickets.map((t) => ticketListItem(t, false)).join("")
      : `<p class="empty">Tu n'as pas encore envoyé de ticket.</p>`;
  };
  $("#tform").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/tickets", "POST", { subject: $("#tsubject").value, message: $("#tmsg").value });
      $("#tform").reset();
      toast("Ticket envoyé ✅");
      load();
    } catch (err) {
      toast(err.message, true);
    }
  };
  await load();
}

// ---------- Page : Réglages ----------
const SET_PRESETS = {
  full:   { label: "Complet",  icon: "⚡", desc: "Tous les sons et effets", v: { muted: false, master: 70, booster: 85, ui: 40, jingles: true, ready: true, uiSounds: true, particles: true, slashes: true, glow: true, calm: false } },
  soft:   { label: "Discret",  icon: "🌙", desc: "Sons bas, moins d'effets", v: { muted: false, master: 40, booster: 55, ui: 15, jingles: true, ready: false, uiSounds: false, particles: true, slashes: false, glow: true, calm: false } },
  silent: { label: "Silence",  icon: "🔇", desc: "Aucun son", v: { muted: true } },
};
const SET_TOGGLES = {
  audio: [
    ["jingles", "Jingle de rareté", "Un son différent pour chaque carte : commune, rare, épique, légendaire, mythique."],
    ["ready", "Carillon « booster prêt »", "Te prévient quand le délai de 4 h est terminé."],
    ["uiSounds", "Sons d'interface", "Petits clics sur les boutons, onglets et cartes."],
  ],
  fx: [
    ["particles", "Braises de reiatsu", "Les particules néon qui montent en arrière-plan."],
    ["slashes", "Coups de sabre", "Traits lumineux qui traversent l'écran."],
    ["glow", "Aura des cartes", "Halo pulsant sur les cartes rares, épiques, légendaires et mythiques."],
    ["calm", "Mode calme", "Coupe les animations et les particules (utile sur un petit appareil)."],
  ],
};

async function pageSettings() {
  const { Settings, Sound } = XII;
  const draft = { blur: me.wallpaper.blur, dim: me.wallpaper.dim };
  const toggleRow = ([k, t, d]) => `
    <label class="sw-row"><span class="sw-txt"><b>${esc(t)}</b><small>${esc(d)}</small></span>
      <input type="checkbox" data-k="${k}"><i class="sw" aria-hidden="true"></i></label>`;
  const slider = (k, label, snd) => `
    <div class="vol" data-vol="${k}">
      <div class="vol-h"><span>${esc(label)}</span><b data-out></b></div>
      <input type="range" class="neon-range" min="0" max="100" step="1" data-k="${k}" data-snd="${snd}" aria-label="${esc(label)}">
    </div>`;

  view.innerHTML = `
    <section class="set-hero">
      <div>
        <span class="kicker">Centre de contrôle</span>
        <h1>Réglages</h1>
        <p class="muted">Son, effets et apparence. Tout est enregistré sur cet appareil et appliqué tout de suite.</p>
      </div>
      <div class="presets" id="presets">
        ${Object.entries(SET_PRESETS).map(([id, p]) => `<button type="button" class="preset" data-p="${id}"><span class="pi">${p.icon}</span><b>${p.label}</b><small>${p.desc}</small></button>`).join("")}
      </div>
    </section>

    <div class="set-grid">
      <section class="panel set-card sound-card">
        <h2>Son</h2>
        <button type="button" class="mute" id="mute" data-nosound aria-pressed="false">
          <span class="spk" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><b id="muteTitle">Son activé</b><small id="muteSub">Touche pour couper tout le son</small></span>
        </button>
        ${slider("master", "Volume général", "rare")}
        ${slider("booster", "Boosters & cartes", "tear")}
        ${slider("ui", "Interface", "nav")}
        <div class="sw-list">${SET_TOGGLES.audio.map(toggleRow).join("")}</div>
        <div class="test">
          <span class="test-h">Écouter</span>
          <div class="test-row">
            <button type="button" class="test-btn" data-nosound data-snd="tear">Ouverture</button>
            <button type="button" class="test-btn common" data-nosound data-snd="common">Commune</button>
            <button type="button" class="test-btn rare" data-nosound data-snd="rare">Rare</button>
            <button type="button" class="test-btn epic" data-nosound data-snd="epic">Épique</button>
            <button type="button" class="test-btn legendary" data-nosound data-snd="legendary">Légendaire</button>
            <button type="button" class="test-btn mythic" data-nosound data-snd="mythic">Mythique</button>
            <button type="button" class="test-btn" data-nosound data-snd="ready">Prêt</button>
          </div>
        </div>
      </section>

      <section class="panel set-card">
        <h2>Effets visuels</h2>
        <div class="sw-list">${SET_TOGGLES.fx.map(toggleRow).join("")}</div>
        <div class="actions" style="margin-top:18px">
          <button type="button" class="btn small ghost" id="setReset">Rétablir son et effets par défaut</button>
        </div>
      </section>

      <section class="panel set-card wide">
        <h2>Fond d'écran</h2>
        <p class="muted">Choisis un fond parmi la galerie ou mets ta propre photo (toi seul la vois). Flou et assombrissement sont enregistrés sur ton compte.</p>
        <div class="wp-preview" id="wpPrev"></div>
        <div class="wp-gallery" id="wpGallery" role="radiogroup" aria-label="Fonds d'écran"></div>
        <div class="wp-info" id="wpInfo"></div>
        <div class="two">
          <div class="vol"><div class="vol-h"><span>Flou</span><b><span id="blurVal"></span> px</b></div><input type="range" class="neon-range" id="blur" min="0" max="20" step="1" aria-label="Flou"></div>
          <div class="vol"><div class="vol-h"><span>Assombrir</span><b><span id="dimVal"></span> %</b></div><input type="range" class="neon-range" id="dim" min="0" max="90" step="1" aria-label="Assombrir"></div>
        </div>
        <div class="actions">
          <label class="btn small file">🖼️ <span id="chgLabel"></span><input type="file" id="wpFile" accept="image/png,image/jpeg,image/webp" hidden></label>
          <button class="btn small ghost" id="wpRemove">Supprimer ma photo</button>
        </div>
        <ul class="wp-tips" id="wpTips"></ul>
      </section>

      <section class="panel set-card wide">
        <h2>Couleur du texte</h2>
        <p class="muted">Choisis la teinte du texte et des titres (toi seul la vois).</p>
        <div class="themes" id="themes"></div>
      </section>
    </div>`;

  // ----- Son & effets : synchronise l'écran avec les réglages -----
  const paint = (el) => el.style.setProperty("--p", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");
  const sync = () => {
    const s = Settings.all();
    $$("input[type=checkbox][data-k]").forEach((i) => (i.checked = !!s[i.dataset.k]));
    $$("input[type=range][data-k]").forEach((i) => { i.value = s[i.dataset.k]; paint(i); i.closest(".vol").querySelector("[data-out]").textContent = s[i.dataset.k] + " %"; });
    const m = $("#mute");
    m.classList.toggle("is-muted", s.muted);
    m.setAttribute("aria-pressed", String(s.muted));
    $("#muteTitle").textContent = s.muted ? "Son coupé" : "Son activé";
    $("#muteSub").textContent = s.muted ? "Touche pour réactiver" : "Touche pour couper tout le son";
    $(".sound-card").classList.toggle("is-muted", s.muted);
    $$("#presets .preset").forEach((b) => {
      const v = SET_PRESETS[b.dataset.p].v;
      b.classList.toggle("active", Object.keys(v).every((k) => s[k] === v[k]));
    });
  };
  Settings.on(sync);
  sync();

  $$("input[type=checkbox][data-k]").forEach((i) => {
    i.onchange = () => { Settings.set(i.dataset.k, i.checked); Sound.preview(i.checked ? "on" : "off"); };
  });
  let lastTick = 0;
  $$("input[type=range][data-k]").forEach((i) => {
    i.oninput = () => {
      Settings.set(i.dataset.k, Number(i.value));
      const now = performance.now();
      if (now - lastTick > 110) { lastTick = now; Sound.preview("tick"); }
    };
    i.onchange = () => Sound.preview(i.dataset.snd);
  });
  $("#mute").onclick = () => {
    const was = Settings.get("muted");
    Settings.set("muted", !was);
    if (was) Sound.preview("on");
  };
  $$(".test-btn").forEach((b) => (b.onclick = () => {
    if (Settings.get("muted")) { toast("Le son est coupé — réactive-le plus haut.", true); return; }
    Sound.preview(b.dataset.snd);
  }));
  $$("#presets .preset").forEach((b) => (b.onclick = () => {
    Settings.patch(SET_PRESETS[b.dataset.p].v);
    if (!Settings.get("muted")) Sound.preview("ok");
  }));
  $("#setReset").onclick = () => { Settings.reset(); Sound.preview("ok"); toast("Réglages rétablis"); };

  // ----- Couleur du texte -----
  const drawThemes = () => {
    $("#themes").innerHTML = TEXT_THEMES.map((t) => `
      <button class="theme-btn ${me.textTheme === t.id || (!me.textTheme && t.id === "os") ? "active" : ""}" data-id="${t.id}" type="button">
        <span class="sw-name" style="color:${t.accent}">${esc(t.label)}</span>
        <span class="sw2" style="color:${t.text}">Texte exemple</span>
      </button>`).join("");
    $("#themes").querySelectorAll(".theme-btn").forEach((b) => {
      b.onclick = async () => {
        const prev = me.textTheme;
        me.textTheme = b.dataset.id;
        applyTextTheme(); drawThemes();
        try { await api("/api/text-theme", "PUT", { theme: b.dataset.id }); }
        catch (err) { me.textTheme = prev; applyTextTheme(); drawThemes(); toast(err.message, true); }
      };
    });
  };
  drawThemes();

  // ----- Fond d'écran -----
  const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
  const pconf = config.wallpaperPhoto || { maxMB: 4, recommended: "1920 × 1080", minWidth: 1280 };
  const presets = config.wallpaperPresets || [{ id: "default", label: "Soleil rouge" }];
  let lastInfo = ""; // détail de la dernière photo envoyée pendant cette visite

  // Détails de ma photo : taille en pixels, poids, format ; avertit si elle est petite ou en hauteur.
  const photoDetails = () => {
    const ph = me.wallpaper.photo;
    if (!ph) return "";
    const parts = [];
    if (ph.width && ph.height) parts.push(`${ph.width} × ${ph.height} px`);
    if (ph.bytes) parts.push(fmtBytes(ph.bytes));
    let msg = `<b>Ma photo</b> : ${parts.join(" · ")}`;
    if (ph.width && ph.height) {
      const ratio = ph.width / ph.height;
      if (ph.width < pconf.minWidth) msg += `<span class="warn">⚠ Un peu petite : elle sera agrandie et paraîtra floue sur un grand écran.</span>`;
      if (ratio < 1.2) msg += `<span class="warn">⚠ Photo en hauteur : elle sera recadrée (haut et bas coupés) pour remplir l'écran.</span>`;
      else if (ratio > 2.2) msg += `<span class="warn">⚠ Très large : les côtés seront coupés pour remplir l'écran.</span>`;
    }
    return msg + (lastInfo ? `<span class="note">${lastInfo}</span>` : "");
  };

  const drawGallery = () => {
    const w = me.wallpaper;
    const tile = (id, label, img, extra = "") => `<button type="button" class="wp-tile ${w.source === id ? "active" : ""}" role="radio" aria-checked="${w.source === id}" data-src="${esc(id)}" title="${esc(label)}">
      <span class="wp-thumb" style="background-image:url('${esc(img)}')"></span><span class="wp-name">${esc(label)}${extra}</span></button>`;
    const mine = w.custom
      ? tile("custom", "Ma photo", `/api/wallpaper?v=${w.v}`)
      : `<button type="button" class="wp-tile mine-empty" data-add><span class="wp-thumb plus">＋</span><span class="wp-name">Ma photo</span></button>`;
    $("#wpGallery").innerHTML = presets.map((p) => tile(p.id, p.label, p.id === "default" ? "/wallpapers/default-thumb.jpg" : `/wallpapers/${p.id}-thumb.jpg`)).join("") + mine;
    $$(".wp-tile[data-src]", $("#wpGallery")).forEach((b) => (b.onclick = () => pickSource(b.dataset.src)));
    const add = $("[data-add]", $("#wpGallery"));
    if (add) add.onclick = () => $("#wpFile").click();
  };

  const pickSource = async (src) => {
    if (me.wallpaper.source === src) return;
    const prev = me.wallpaper.source;
    me.wallpaper.source = src;
    applyWallpaper(); refresh();
    try { await api("/api/wallpaper", "PUT", { source: src, blur: draft.blur, dim: draft.dim }); Sound.play("ok"); }
    catch (err) { me.wallpaper.source = prev; applyWallpaper(); refresh(); toast(err.message, true); }
  };

  const refresh = () => {
    const w = me.wallpaper;
    const prev = $("#wpPrev");
    prev.style.backgroundImage = `url(${wallpaperUrl(w)})`;
    prev.textContent = "";
    $("#chgLabel").textContent = w.custom ? "Changer ma photo" : "Choisir ma photo";
    $("#wpRemove").disabled = !w.custom;
    $("#blur").value = draft.blur;
    $("#dim").value = draft.dim;
    $("#blurVal").textContent = draft.blur;
    $("#dimVal").textContent = draft.dim;
    paint($("#blur")); paint($("#dim"));
    drawGallery();
    const info = photoDetails();
    $("#wpInfo").innerHTML = info;
    $("#wpInfo").hidden = !info;
    $("#wpTips").innerHTML = `
      <li><b>Taille idéale</b> : ${esc(pconf.recommended)} px (16:9), au minimum ${pconf.minWidth} px de large.</li>
      <li><b>Formats</b> : JPG, PNG ou WebP · <b>poids max</b> ${String(pconf.maxMB).replace(".", ",")} Mo (ta photo est réduite automatiquement à 1920 px de large max).</li>
      <li><b>Cadrage</b> : l'image remplit tout l'écran, centrée ; si elle n'est pas en 16:9, les bords sont coupés. Prends une photo horizontale avec le sujet au centre.</li>`;
  };
  refresh();

  const onInput = () => {
    draft.blur = Number($("#blur").value);
    draft.dim = Number($("#dim").value);
    $("#blurVal").textContent = draft.blur;
    $("#dimVal").textContent = draft.dim;
    paint($("#blur")); paint($("#dim"));
    me.wallpaper.blur = draft.blur;
    me.wallpaper.dim = draft.dim;
    applyWallpaper();
  };
  const onChange = async () => {
    try { await api("/api/wallpaper", "PUT", { blur: draft.blur, dim: draft.dim }); }
    catch (err) { toast(err.message, true); }
  };
  $("#blur").oninput = onInput; $("#dim").oninput = onInput;
  $("#blur").onchange = onChange; $("#dim").onchange = onChange;

  $("#wpFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const img = await loadImage(file);
      const ow = img.naturalWidth, oh = img.naturalHeight;
      const image = await fileToDataUrl(file, 1920, "image/jpeg", 0.82);
      const scale = Math.min(1, 1920 / Math.max(ow, oh));
      const width = Math.round(ow * scale), height = Math.round(oh * scale);
      const res = await api("/api/wallpaper", "PUT", { image, width, height, blur: draft.blur, dim: draft.dim });
      me.wallpaper = res.wallpaper;
      lastInfo = `Photo d'origine : ${ow} × ${oh} px · ${fmtBytes(file.size)}${scale < 1 ? ` → réduite à ${width} × ${height} px` : ""}.`;
      applyWallpaper();
      refresh();
      toast("Fond d'écran enregistré ✨");
      Sound.play("ok");
    } catch (err) {
      toast(err.message, true);
    }
    e.target.value = "";
  };
  $("#wpRemove").onclick = async () => {
    if (!confirm("Supprimer ta photo perso ?")) return;
    try {
      const res = await api("/api/wallpaper", "DELETE");
      me.wallpaper = res.wallpaper;
      lastInfo = "";
      applyWallpaper();
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- Page : Code cadeau ----------
function pageCode() {
  view.innerHTML = `
    <section class="panel">
      <h2>Code cadeau</h2>
      <p class="muted">Tu as un code donné par un admin ? Entre-le ici pour recevoir des boosters. Chaque code ne s'utilise qu'une fois par joueur.</p>
      <form class="code-form" id="codeForm">
        <input class="input" id="codeIn" placeholder="TON-CODE" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Code">
        <button class="btn" type="submit">Valider</button>
      </form>
      <p id="codeMsg" class="code-msg" aria-live="polite"></p>
      <p class="muted">🎁 Boosters en réserve : <b id="codeStock">${me.bonusBoosters || 0}</b> — ouvre-les depuis l'<a href="#/">accueil</a>.</p>
    </section>`;
  $("#codeForm").onsubmit = async (e) => {
    e.preventDefault();
    const code = $("#codeIn").value.trim();
    if (!code) return;
    const msg = $("#codeMsg");
    try {
      const res = await api("/api/codes/redeem", "POST", { code });
      me.bonusBoosters = res.bonusBoosters;
      $("#codeStock").textContent = res.bonusBoosters;
      $("#codeIn").value = "";
      msg.className = "code-msg ok";
      msg.textContent = `✅ Code accepté : +${res.boosters} booster${res.boosters > 1 ? "s" : ""} !`;
      XII.Sound.play("ok");
    } catch (err) {
      msg.className = "code-msg bad";
      msg.textContent = err.message;
    }
  };
}

// ---------- Page : Admin ----------
function cardOptions(selected) {
  return Object.entries(catalog.rarities)
    .map(([k, r]) => {
      const cards = catalog.cards.filter((c) => c.rarity === k);
      if (!cards.length) return "";
      return `<optgroup label="${esc(r.label)}">${cards.map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`;
    })
    .join("");
}

async function pageAdmin() {
  const tabs = [["dashboard", "Tableau de bord"], ["cards", "Cartes"], ["players", "Joueurs"], ["codes", "Codes"], ["tickets", "Tickets"], ["logo", "Logo"]];
  if (me.isFounder) { tabs.push(["access", "Accès"]); tabs.push(["backups", "Sauvegardes"]); }
  if (!tabs.some(([k]) => k === adminTab)) adminTab = "dashboard";
  view.innerHTML = `
    <section class="panel">
      <h2>Espace admin</h2>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="chip ${adminTab === k ? "active" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
      <div id="adminBox"></div>
    </section>`;
  $$(".tabs .chip").forEach((b) => (b.onclick = () => { adminTab = b.dataset.t; pageAdmin(); }));
  const box = $("#adminBox");
  if (adminTab === "dashboard") await adminDashboard(box);
  else if (adminTab === "cards") await adminCards(box);
  else if (adminTab === "players") await adminPlayers(box);
  else if (adminTab === "codes") await adminCodes(box);
  else if (adminTab === "tickets") await adminTickets(box);
  else if (adminTab === "logo") adminLogo(box);
  else if (adminTab === "access" && me.isFounder) await adminAccess(box);
  else if (adminTab === "backups" && me.isFounder) await adminBackups(box);
}

async function adminDashboard(box) {
  const [st, { tickets }] = await Promise.all([api("/api/admin/stats"), api("/api/admin/tickets")]);
  const tiles = [["Joueurs", st.players], ["Cartes au catalogue", st.cards], ["Exemplaires en circulation", st.copies], ["Boosters ouverts", st.boosters], ["Tickets en attente", st.openTickets], ["Admins", st.admins]];
  const max = Math.max(1, ...Object.values(st.byRarity));
  box.innerHTML = `
    <div class="stat-grid">${tiles.map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("")}</div>
    <div class="admin-grid">
      <div class="panel inner"><h3>Cartes par rareté</h3>
        ${Object.entries(catalog.rarities).map(([k, r]) => `<div class="bar-row"><span>${esc(r.label)}</span><div class="bar ${esc(k)}"><i style="width:${((st.byRarity[k] || 0) / max) * 100}%"></i></div><b>${st.byRarity[k] || 0}</b></div>`).join("")}
      </div>
      <div class="panel inner"><h3>Meilleurs collectionneurs</h3>
        ${st.top.length ? st.top.map((p, i) => `<a class="mini-row" href="#/joueur/${esc(p.pid)}"><span>${i + 1}.</span>${avatarHtml(p, "sm")}<strong>${esc(p.name)}</strong><small class="muted">${p.unique} cartes · ${p.mythic ? p.mythic + " ✦ · " : ""}${p.legendary} ★</small></a>`).join("") : `<p class="empty">Aucun joueur.</p>`}
      </div>
    </div>
    <div class="panel inner"><h3>Tickets en attente (${tickets.length})</h3>
      ${tickets.length ? tickets.slice(0, 5).map((t) => `<div class="mini-row"><strong>${esc(t.subject)}</strong><small class="muted">${esc(t.player.name)} · ${fmtDate(t.createdAt)}</small></div>`).join("") + `<button class="btn small" id="goTickets">Traiter les tickets</button>` : `<p class="empty">Rien à traiter 🎉</p>`}
    </div>
    ${st.cards ? "" : `<p class="empty">Le catalogue est vide : crée ta première carte dans l'onglet « Cartes ».</p>`}`;
  const g = $("#goTickets");
  if (g) g.onclick = () => { adminTab = "tickets"; pageAdmin(); };
}

function applyLogo() {
  const mark = $(".brand .mark");
  if (!mark) return;
  mark.classList.toggle("has-logo", Boolean(config.logo));
  mark.innerHTML = config.logo ? `<img src="${esc(config.logo)}" alt="">` : "XII";
}

function adminLogo(box) {
  box.innerHTML = `<div class="panel inner" style="max-width:560px">
    <h3>Logo du site</h3>
    <p class="muted">Il remplace le sceau « XII » en haut à gauche. Une image carrée (PNG avec fond transparent, par exemple) rend le mieux.</p>
    <div class="logo-preview"><span class="mark ${config.logo ? "has-logo" : ""}">${config.logo ? `<img src="${esc(config.logo)}" alt="">` : "XII"}</span><strong>Douzième Division</strong></div>
    <div class="actions">
      <label class="btn small file">🖼️ Choisir une image<input type="file" id="logoFile" accept="image/*" hidden></label>
      ${config.logo ? `<button class="btn small danger" id="logoDel">Retirer le logo</button>` : ""}
    </div></div>`;
  $("#logoFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const image = await fileToDataUrl(file, 256, "image/webp", 0.92);
      config.logo = (await api("/api/admin/logo", "PUT", { image })).logo;
      applyLogo(); adminLogo(box); toast("Logo mis à jour ✅");
    } catch (err) { toast(err.message, true); }
  };
  const del = $("#logoDel");
  if (del) del.onclick = async () => {
    try {
      await api("/api/admin/logo", "DELETE");
      config.logo = null; applyLogo(); adminLogo(box); toast("Logo retiré");
    } catch (err) { toast(err.message, true); }
  };
}

async function adminAccess(box) {
  const { players } = await api("/api/founder/access");
  box.innerHTML = `<div class="panel inner" style="max-width:560px">
    <h3>Accès admin</h3>
    <p class="muted">Seul le fondateur donne ou retire les droits d'admin. Le joueur doit s'être connecté au moins une fois.</p>
    ${players.map((p) => `<div class="row" style="display:flex;align-items:center;gap:10px;margin:8px 0">
      ${avatarHtml(p, "sm")}<span style="flex:1">${esc(p.name)}${p.isFounder ? " 👑 Fondateur" : ""}</span>
      ${p.isFounder ? "" : `<button class="btn small" data-pid="${esc(p.pid)}" data-admin="${p.isAdmin ? 0 : 1}">${p.isAdmin ? "Retirer l'accès" : "Donner l'accès admin"}</button>`}
    </div>`).join("")}
  </div>`;
  box.querySelectorAll("button[data-pid]").forEach((b) => (b.onclick = async () => {
    try {
      await api("/api/founder/access", "PUT", { pid: b.dataset.pid, admin: b.dataset.admin === "1" });
      await adminAccess(box);
    } catch (err) { toast(err.message, true); }
  }));
}

async function adminBackups(box) {
  const d = await api("/api/founder/backups");
  const kinds = { auto: "Auto", daily: "Quotidienne", manual: "Manuelle", "pre-restore": "Avant restauration" };
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " Mo" : Math.max(1, Math.round(n / 1024)) + " Ko");
  box.innerHTML = `
    <div class="panel inner" style="margin-bottom:18px">
      <h3>Sauvegardes</h3>
      <p class="muted">${d.players} joueurs · ${d.cards} cartes. Une copie des données <strong>et des images</strong> est faite automatiquement au démarrage, à chaque arrêt, toutes les 10 min en cas de changement et chaque jour. Si <code>data.json</code> ou des images sont perdus, le site se restaure tout seul au redémarrage depuis la dernière copie valide.</p>
      <p class="muted" style="margin-top:8px">🖼 Images : ${d.images.live} en ligne, ${d.images.mirrored} dans la copie de secours.</p>
      ${d.offsite.enabled
        ? `<p class="muted" style="margin-top:8px">☁️ Copie hors du site (Discord) : ${d.offsite.lastAt ? `dernier envoi le ${fmtDate(d.offsite.lastAt)}${d.offsite.lastWithImages === false ? " (images dans des fichiers séparés : à importer aussi)" : ""}` : "pas encore envoyée"}${d.offsite.lastOk === false ? ` — <strong>dernier essai échoué : ${esc(d.offsite.lastError || "erreur")}</strong>` : ""}. Envoi automatique à chaque arrêt ou plantage du site et au plus toutes les ${d.offsite.gapMin >= 60 ? Math.round(d.offsite.gapMin / 60) + " h" : d.offsite.gapMin + " min"} quand quelque chose change.</p>`
        : `<p class="status refused" style="display:block;margin:10px 0">☁️ Aucune copie hors du site. Si l'hébergeur efface le disque, tout est perdu. Ajoute la variable <code>BACKUP_WEBHOOK_URL</code> (URL d'un webhook Discord : Salon → Intégrations → Webhooks) pour recevoir automatiquement les sauvegardes dans un salon privé.</p>`}
      <div class="actions">
        <button class="btn small" id="bkNow">Sauvegarder maintenant</button>
        ${d.offsite.enabled ? `<button class="btn small" id="bkOffsite">Envoyer sur Discord maintenant</button>` : ""}
        <a class="btn small" href="/api/founder/export">Télécharger la sauvegarde complète (données + images)</a>
        <label class="btn small" style="cursor:pointer">Importer une sauvegarde complète<input type="file" id="bkImport" accept="application/json,application/gzip,.json,.gz" multiple hidden></label>
      </div>
    </div>
    <div class="admin-table">
      ${d.backups.length ? d.backups.map((b) => `<div class="trow">
        <div class="tinfo"><strong>${fmtDate(b.time)}</strong><span class="muted">${kinds[b.kind] || b.kind} · ${fmtSize(b.size)}</span></div>
        <div class="actions">
          <a class="btn small" href="/api/founder/backups/${encodeURIComponent(b.name)}">Télécharger</a>
          <button class="btn small danger" data-restore="${esc(b.name)}">Restaurer</button>
        </div></div>`).join("") : `<p class="empty">Aucune sauvegarde pour l'instant.</p>`}
    </div>`;
  $("#bkNow").onclick = async () => {
    try { await api("/api/founder/backups", "POST"); toast("Sauvegarde créée ✅"); await adminBackups(box); } catch (err) { toast(err.message, true); }
  };
  const offBtn = $("#bkOffsite");
  if (offBtn) offBtn.onclick = async () => {
    offBtn.disabled = true;
    try { await api("/api/founder/offsite", "POST"); toast("Sauvegarde envoyée sur Discord ✅"); } catch (err) { toast(err.message, true); }
    await adminBackups(box);
  };
  $$("[data-restore]", box).forEach((b) => (b.onclick = async () => {
    if (!confirm("Restaurer cette sauvegarde ? L'état actuel sera lui-même sauvegardé avant (type « Avant restauration ») pour pouvoir revenir en arrière.")) return;
    try {
      await api("/api/founder/backups/restore", "POST", { name: b.dataset.restore });
      catalog = await api("/api/catalog");
      me = (await api("/api/me")).user;
      toast("Sauvegarde restaurée ✅");
      await adminBackups(box);
    } catch (err) { toast(err.message, true); }
  }));
  $("#bkImport").onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    if (!confirm("Importer ce(s) fichier(s) ? Un fichier de données remplace toutes les données actuelles (une copie de l'état actuel est gardée). Tu peux choisir plusieurs fichiers d'un coup : « données » + « images ».")) { e.target.value = ""; return; }
    try {
      // Les copies envoyées sur Discord sont en .json.gz : on les décompresse ici dans le navigateur.
      let images = 0, last = null;
      for (const f of files) {
        const text = /\.gz$/i.test(f.name) ? await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await f.text();
        const r = await api("/api/founder/import", "POST", JSON.parse(text));
        images += r.images || 0;
        if (!r.imagesOnly) last = r;
      }
      catalog = await api("/api/catalog");
      me = (await api("/api/me")).user;
      toast(last ? `Importé : ${last.players} joueurs, ${last.cards} cartes, ${images} images ✅` : `${images} images importées ✅`);
      e.target.value = "";
      await adminBackups(box);
    } catch (err) { toast(err.message || "Fichier invalide", true); }
  };
}

async function adminTickets(box) {
  let showAll = false;
  const load = async () => {
    const { tickets } = await api(`/api/admin/tickets?status=${showAll ? "all" : "open"}`);
    ticketCtx = { map: new Map(tickets.map((t) => [t.id, t])), admin: true, reload: load };
    const finished = tickets.filter((t) => t.status !== "open").length;
    box.innerHTML = `<div class="filters">
        <button class="chip ${!showAll ? "active" : ""}" data-f="open">En attente</button>
        <button class="chip ${showAll ? "active" : ""}" data-f="all">Tous</button>
        ${finished ? `<button class="btn small danger" id="purgeTickets" style="margin-left:auto">🗑 Supprimer les ${finished} terminé${finished > 1 ? "s" : ""}</button>` : ""}</div>
      <div>${tickets.length ? tickets.map((t) => ticketListItem(t, true)).join("") : `<p class="empty">Aucun ticket ${showAll ? "" : "en attente"}.</p>`}</div>`;
    $$("[data-f]", box).forEach((b) => (b.onclick = () => { showAll = b.dataset.f === "all"; load(); }));
    const purge = $("#purgeTickets", box);
    if (purge) purge.onclick = async () => {
      if (!confirm("Supprimer définitivement tous les tickets acceptés et refusés ? Les tickets en attente sont conservés.")) return;
      try {
        const { removed } = await api("/api/admin/tickets/purge", "POST", {});
        toast(`${removed} ticket${removed > 1 ? "s" : ""} supprimé${removed > 1 ? "s" : ""}`);
        load();
      } catch (err) { toast(err.message, true); }
    };
  };
  await load();
}

async function adminCards(box) {
  const stats = (await api("/api/admin/stats")).byCard;
  const blank = () => ({ id: null, name: "", rarity: Object.keys(catalog.rarities)[0], desc: "", hue: 260, sets: ["douzieme"], image: null, newImage: null });
  let st = blank();
  let q = "", rf = "all", sort = "id", sf = "all";
  const selected = new Set();

  const setsVal = (s) => (s.length > 1 ? "both" : s[0] || "douzieme");
  const setsLabel = (s) => (s || ["douzieme"]).map((id) => (catalog.sets.find((x) => x.id === id) || { label: id }).label).join(" + ");
  const draw = () => {
    box.innerHTML = `
      <div class="admin-grid">
        <form id="cform" class="form panel inner">
          <h3>${st.id ? `Modifier la carte #${st.id}` : "Nouvelle carte"}</h3>
          <label>Nom<input class="input" id="cName" maxlength="40" required value="${esc(st.name)}"></label>
          <label>Rareté<select class="input" id="cRarity">${Object.entries(catalog.rarities).map(([k, r]) => `<option value="${esc(k)}">${esc(r.label)}</option>`).join("")}</select></label>
          <label>Booster<select class="input" id="cSets">${catalog.sets.map((s) => `<option value="${esc(s.id)}">${esc(s.label)} seulement</option>`).join("")}<option value="both">Les deux boosters</option></select></label>
          <label>Description<textarea class="input" id="cDesc" maxlength="160" rows="3">${esc(st.desc)}</textarea></label>
          <label>Teinte du cadre : <b id="cHueVal">${st.hue}</b><input type="range" id="cHue" min="0" max="359" value="${st.hue}"></label>
          <label>Image de la carte ${st.id ? "(laisse vide pour garder l'actuelle)" : "(obligatoire)"}<input class="input" type="file" id="cImage" accept="image/*"></label>
          <div class="actions">
            <button class="btn" type="submit">${st.id ? "Enregistrer" : "Créer la carte"}</button>
            ${st.id ? `<button type="button" class="btn ghost" id="cCancel">Annuler</button>` : ""}
          </div>
        </form>
        <div><h3>Aperçu</h3><div id="cPreview" class="cards one"></div></div>
      </div>
      <h3>Catalogue (${catalog.cards.length})</h3>
      <div class="toolbar">
        <input class="input" id="cSearch" placeholder="Rechercher une carte…" value="${esc(q)}">
        <select class="input" id="cFilter"><option value="all">Toutes les raretés</option>${Object.entries(catalog.rarities).map(([k, r]) => `<option value="${esc(k)}" ${rf === k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
        <select class="input" id="cSetF"><option value="all">Tous les boosters</option>${catalog.sets.map((s) => `<option value="${esc(s.id)}" ${sf === s.id ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
        <select class="input" id="cSort">${[["id", "Numéro"], ["name", "Nom"], ["rarity", "Rareté"], ["owners", "Plus possédées"]].map(([k, l]) => `<option value="${k}" ${sort === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <button class="btn small danger" id="bulkDel" ${selected.size ? "" : "disabled"}>Supprimer la sélection (${selected.size})</button>
      </div>
      <div id="adminList" class="admin-table"></div>`;

    $("#cRarity").value = st.rarity;
    $("#cSets").value = setsVal(st.sets);
    const preview = () => $("#cPreview").innerHTML = cardHtml({ id: 0, name: st.name || "Nom de la carte", rarity: st.rarity, emoji: "🎴", hue: st.hue, desc: st.desc || "Description", image: st.newImage || st.image });
    preview();

    const rarityOrder = Object.keys(catalog.rarities);
    const list = () => {
      const rows = catalog.cards
        .filter((c) => (rf === "all" || c.rarity === rf) && (sf === "all" || (c.sets || ["douzieme"]).includes(sf)) && (!q || c.name.toLowerCase().includes(q.toLowerCase())))
        .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "rarity" ? rarityOrder.indexOf(b.rarity) - rarityOrder.indexOf(a.rarity) || a.id - b.id : sort === "owners" ? ((stats[b.id] || {}).owners || 0) - ((stats[a.id] || {}).owners || 0) : a.id - b.id);
      $("#adminList").innerHTML = rows.length ? rows.map((c) => {
        const s = stats[c.id] || { owners: 0, copies: 0 };
        return `<div class="trow" data-id="${c.id}">
          <input type="checkbox" data-sel="${c.id}" ${selected.has(c.id) ? "checked" : ""}>
          <div class="thumb">${artHtml(c)}</div>
          <div class="tinfo"><strong>${esc(c.name)}</strong><small class="muted">#${c.id} · ${esc((catalog.rarities[c.rarity] || {}).label || c.rarity)} · ${esc(setsLabel(c.sets))} · ${s.owners} joueur(s), ${s.copies} ex.${c.image ? "" : " · ⚠ sans image"}</small></div>
          <div class="actions"><button class="btn small ghost" data-view="${c.id}">Voir</button><button class="btn small" data-edit="${c.id}">Modifier</button><button class="btn small danger" data-del="${c.id}">Supprimer</button></div>
        </div>`;
      }).join("") : `<p class="empty">Aucune carte.</p>`;
      $$("[data-sel]", box).forEach((b) => (b.onchange = () => { const id = Number(b.dataset.sel); b.checked ? selected.add(id) : selected.delete(id); $("#bulkDel").disabled = !selected.size; $("#bulkDel").textContent = `Supprimer la sélection (${selected.size})`; }));
      $$("[data-view]", box).forEach((b) => (b.onclick = () => openCardModal(Number(b.dataset.view))));
      $$("[data-edit]", box).forEach((b) => (b.onclick = () => edit(Number(b.dataset.edit))));
      $$("[data-del]", box).forEach((b) => (b.onclick = async () => {
        const c = catalog.cards.find((x) => x.id === Number(b.dataset.del));
        if (!confirm(`Supprimer « ${c.name} » ? Elle disparaîtra aussi des collections et des vitrines.`)) return;
        try { await api(`/api/admin/cards/${c.id}`, "DELETE"); catalog = await api("/api/catalog"); toast("Carte supprimée"); pageAdmin(); }
        catch (err) { toast(err.message, true); }
      }));
    };
    list();

    $("#cSearch").oninput = (e) => { q = e.target.value; list(); };
    $("#cFilter").onchange = (e) => { rf = e.target.value; list(); };
    $("#cSetF").onchange = (e) => { sf = e.target.value; list(); };
    $("#cSort").onchange = (e) => { sort = e.target.value; list(); };
    $("#bulkDel").onclick = async () => {
      if (!confirm(`Supprimer ${selected.size} carte(s) ? Elles disparaîtront aussi des collections et des vitrines.`)) return;
      try { await api("/api/admin/cards/bulk-delete", "POST", { ids: [...selected] }); catalog = await api("/api/catalog"); toast("Cartes supprimées"); pageAdmin(); }
      catch (err) { toast(err.message, true); }
    };

    $("#cName").oninput = (e) => { st.name = e.target.value; preview(); };
    $("#cRarity").onchange = (e) => { st.rarity = e.target.value; preview(); };
    $("#cSets").onchange = (e) => { st.sets = e.target.value === "both" ? catalog.sets.map((s) => s.id) : [e.target.value]; };
    $("#cDesc").oninput = (e) => { st.desc = e.target.value; preview(); };
    $("#cHue").oninput = (e) => { st.hue = Number(e.target.value); $("#cHueVal").textContent = st.hue; preview(); };
    $("#cImage").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { st.newImage = await fileToDataUrl(file, 700, "image/webp", 0.85); preview(); }
      catch (err) { toast(err.message, true); }
    };
    if ($("#cCancel")) $("#cCancel").onclick = () => { st = blank(); draw(); };

    $("#cform").onsubmit = async (e) => {
      e.preventDefault();
      if (!st.id && !st.newImage) return toast("Une image est obligatoire pour créer une carte", true);
      const body = { name: st.name, rarity: st.rarity, desc: st.desc, hue: st.hue, sets: st.sets };
      if (st.newImage) body.image = st.newImage;
      try {
        if (st.id) await api(`/api/admin/cards/${st.id}`, "PUT", body);
        else await api("/api/admin/cards", "POST", body);
        catalog = await api("/api/catalog");
        toast(st.id ? "Carte modifiée ✅" : "Carte créée ✅");
        pageAdmin();
      } catch (err) { toast(err.message, true); }
    };
  };
  const edit = (id) => {
    const c = catalog.cards.find((x) => x.id === id);
    if (!c) return;
    st = { id: c.id, name: c.name, rarity: c.rarity, desc: c.desc, hue: c.hue, sets: c.sets || ["douzieme"], image: c.image, newImage: null };
    draw();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  if (pendingEdit) { const id = pendingEdit; pendingEdit = null; const c = catalog.cards.find((x) => x.id === id); if (c) st = { id: c.id, name: c.name, rarity: c.rarity, desc: c.desc, hue: c.hue, sets: c.sets || ["douzieme"], image: c.image, newImage: null }; }
  draw();
}

async function adminCodes(box) {
  let { codes } = await api("/api/admin/codes");
  const draw = () => {
    box.innerHTML = `
      <form class="code-create" id="codeNew">
        <input class="input" id="cCode" placeholder="Code (ex. BIENVENUE)" maxlength="32" autocomplete="off" required>
        <input class="input num" id="cBoost" type="number" min="1" max="100" value="1" required aria-label="Nombre de boosters" title="Nombre de boosters">
        <input class="input num" id="cMax" type="number" min="0" placeholder="∞" aria-label="Utilisations max" title="Nombre max de joueurs (vide = illimité)">
        <button class="btn" type="submit">Créer le code</button>
      </form>
      <p class="muted">Boosters offerts par code (1 à 100) · utilisations max : nombre de joueurs qui peuvent l'utiliser (vide = illimité). Chaque joueur ne peut l'utiliser qu'une fois.</p>
      <div class="admin-table">${codes.length ? codes.map((c) => `
        <div class="prow"><div class="trow">
          <div class="tinfo"><strong class="code-tag">${esc(c.code)}</strong>
            <small class="muted">🎁 ${c.boosters} booster${c.boosters > 1 ? "s" : ""} · utilisé ${c.uses}${c.maxUses ? ` / ${c.maxUses}` : ""} fois · créé le ${fmtDate(c.createdAt)}</small></div>
          <div class="actions"><button class="btn small ghost" data-del="${esc(c.code)}">Supprimer</button></div>
        </div></div>`).join("") : `<p class="empty">Aucun code pour le moment.</p>`}</div>`;
    $("#codeNew").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/admin/codes", "POST", { code: $("#cCode").value, boosters: $("#cBoost").value, maxUses: $("#cMax").value });
        ({ codes } = await api("/api/admin/codes"));
        toast("Code créé ✅");
        draw();
      } catch (err) { toast(err.message, true); }
    };
    $$("[data-del]", box).forEach((b) => (b.onclick = async () => {
      if (!confirm(`Supprimer le code ${b.dataset.del} ?`)) return;
      try { await api(`/api/admin/codes/${encodeURIComponent(b.dataset.del)}`, "DELETE"); ({ codes } = await api("/api/admin/codes")); draw(); }
      catch (err) { toast(err.message, true); }
    }));
  };
  draw();
}

async function adminPlayers(box) {
  let { players, total } = await api("/api/admin/players");
  let q = "", open = null;
  const draw = () => {
    box.innerHTML = `<div class="toolbar"><input class="input" id="pSearch" placeholder="Rechercher un joueur…" value="${esc(q)}"></div><div id="pList" class="admin-table"></div>`;
    const list = () => {
      const rows = players.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
      $("#pList").innerHTML = rows.length ? rows.map((p) => {
        const isOpen = open === p.pid;
        const owned = catalog.cards.filter((c) => p.collection[c.id]);
        return `<div class="prow ${isOpen ? "open" : ""}" data-pid="${esc(p.pid)}">
          <div class="trow">${avatarHtml(p, "sm")}
            <div class="tinfo"><strong>${esc(p.name)}</strong>${p.isFounder ? ` <span class="chip-mini">Fondateur</span>` : p.isAdmin ? ` <span class="chip-mini">Admin</span>` : ""}
              <small class="muted">${p.unique}/${total} cartes · ${p.copies} ex. · ${p.mythic ? p.mythic + " ✦ · " : ""}${p.legendary} ★${p.bonusBoosters ? ` · 🎁 ${p.bonusBoosters} booster${p.bonusBoosters > 1 ? "s" : ""}` : ""}</small></div>
            <div class="actions"><button class="btn small ghost" data-toggle>${isOpen ? "Fermer" : "Gérer"}</button></div></div>
          ${isOpen ? `<div class="pdetail">
            <div class="actions">
              <select class="input" data-gcard><option value="">Donner une carte…</option>${cardOptions()}</select>
              <button class="btn small" data-give>Donner</button>
              <button class="btn small ghost" data-reset>Réinitialiser le booster</button>
              <a class="btn small ghost" href="#/joueur/${esc(p.pid)}">Voir le profil</a>
            </div>
            <div class="actions booster-give">
              <span class="muted">🎁 Boosters en réserve : <b>${p.bonusBoosters || 0}</b></span>
              <input class="input num" type="number" min="1" max="100" value="1" data-bcount aria-label="Nombre de boosters">
              <button class="btn small" data-bgive>Donner</button>
              <button class="btn small ghost" data-btake ${p.bonusBoosters ? "" : "disabled"}>Retirer</button>
              <button class="btn small ghost" data-ball>Donner à tous les joueurs</button>
            </div>
            ${owned.length ? `<div class="chips-list">${owned.map((c) => `<span class="owned ${esc(c.rarity)}">${esc(c.name)} ×${p.collection[c.id]}<button title="Retirer un exemplaire" data-rm="${c.id}">−</button><button title="Retirer toutes les copies" data-rmall="${c.id}">×</button></span>`).join("")}</div>` : `<p class="empty">Ce joueur n'a aucune carte.</p>`}
          </div>` : ""}
        </div>`;
      }).join("") : `<p class="empty">Aucun joueur.</p>`;
      $$(".prow", box).forEach((row) => {
        const pid = row.dataset.pid;
        const act = async (url, body, msg) => {
          try { await api(url, "POST", body); toast(msg); ({ players, total } = await api("/api/admin/players")); list(); }
          catch (err) { toast(err.message, true); }
        };
        $("[data-toggle]", row).onclick = () => { open = open === pid ? null : pid; list(); };
        const give = $("[data-give]", row);
        if (give) {
          give.onclick = () => { const id = Number($("[data-gcard]", row).value); if (!id) return toast("Choisis une carte", true); act("/api/admin/grant", { pid, cardId: id }, "Carte donnée ✅"); };
          $("[data-reset]", row).onclick = () => act("/api/admin/reset-booster", { pid }, "Booster réinitialisé ✅");
          const bcount = () => { const n = Math.trunc(Number($("[data-bcount]", row).value)); return n >= 1 && n <= 100 ? n : 0; };
          $("[data-bgive]", row).onclick = () => { const n = bcount(); if (!n) return toast("Entre un nombre de 1 à 100", true); act("/api/admin/grant-boosters", { pid, count: n }, `${n} booster${n > 1 ? "s" : ""} donné${n > 1 ? "s" : ""} ✅`); };
          $("[data-btake]", row).onclick = () => { const n = bcount(); if (!n) return toast("Entre un nombre de 1 à 100", true); act("/api/admin/grant-boosters", { pid, count: -n }, `${n} booster${n > 1 ? "s" : ""} retiré${n > 1 ? "s" : ""}`); };
          $("[data-ball]", row).onclick = () => { const n = bcount(); if (!n) return toast("Entre un nombre de 1 à 100", true); if (confirm(`Donner ${n} booster${n > 1 ? "s" : ""} à TOUS les joueurs ?`)) act("/api/admin/grant-boosters", { all: true, count: n }, `${n} booster${n > 1 ? "s" : ""} donné${n > 1 ? "s" : ""} à tous ✅`); };
          $$("[data-rm]", row).forEach((b) => (b.onclick = () => act("/api/admin/revoke", { pid, cardId: Number(b.dataset.rm) }, "Exemplaire retiré")));
          $$("[data-rmall]", row).forEach((b) => (b.onclick = () => { if (confirm("Retirer toutes les copies de cette carte à ce joueur ?")) act("/api/admin/revoke", { pid, cardId: Number(b.dataset.rmall), all: true }, "Carte retirée"); }));
        }
      });
    };
    list();
    $("#pSearch").oninput = (e) => { q = e.target.value; list(); };
  };
  draw();
}

async function render() {
  clearInterval(timerInterval);
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  setActiveNav(name, arg);
  try {
    if (name === "joueurs") await pagePlayers();
    else if (name === "joueur") await pageProfile(arg || me.pid);
    else if (name === "tickets") await pageTickets();
    else if (name === "code") pageCode();
    else if (name === "reglages") await pageSettings();
    else if (name === "admin" && me.isAdmin) await pageAdmin();
    else await pageHome();
  } catch (err) {
    view.innerHTML = `<section class="panel"><p>${esc(err.message)}</p></section>`;
  }
}

window.addEventListener("hashchange", () => { if (me) render(); });

async function boot() {
  [config, catalog] = await Promise.all([api("/api/config"), api("/api/catalog")]);
  me = (await api("/api/me")).user;
  renderNav();
  applyLogo();
  applyWallpaper();
  applyTextTheme();
  if (!me) {
    clearInterval(timerInterval);
    view.classList.add("hidden");
    $("#landing").classList.remove("hidden");
    renderLogin();
    return;
  }
  $("#landing").classList.add("hidden");
  view.classList.remove("hidden");
  render();
}

boot();

// ---------- Reiatsu : particules néon + traînées ----------
(function embers() {
  const cv = document.getElementById("embers");
  if (!cv || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = cv.getContext("2d");
  let w, h, dots = [], slashes = [];
  const COLORS = ["0,229,255", "255,106,0", "180,77,255", "255,255,255"];
  const size = () => { w = cv.width = innerWidth; h = cv.height = innerHeight; };
  size();
  addEventListener("resize", size);
  const make = (fresh) => ({
    x: Math.random() * w, y: fresh ? Math.random() * h : h + 10,
    r: Math.random() * 2.2 + .5, v: Math.random() * .6 + .2, d: Math.random() * 2 - 1,
    a: Math.random() * .6 + .25, c: COLORS[Math.floor(Math.random() * COLORS.length)],
  });
  for (let i = 0; i < 70; i++) dots.push(make(true));
  // Coups de sabre : un trait lumineux qui traverse l'écran de temps en temps
  setInterval(() => {
    if (document.hidden || !XII.Settings.get("slashes") || XII.Settings.get("calm")) return;
    const y = Math.random() * h * .8 + h * .1;
    slashes.push({ x: -200, y, vx: 38 + Math.random() * 20, vy: (Math.random() - .5) * 8, life: 1, c: Math.random() > .5 ? "0,229,255" : "255,106,0" });
  }, 4500);
  (function tick() {
    ctx.clearRect(0, 0, w, h);
    if (!XII.Settings.get("particles") || XII.Settings.get("calm") || document.hidden) { slashes = []; requestAnimationFrame(tick); return; }
    ctx.globalCompositeOperation = "lighter";
    for (const p of dots) {
      p.y -= p.v; p.x += Math.sin(p.y / 60) * .3 + p.d * .06;
      if (p.y < -10) Object.assign(p, make(false));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
      g.addColorStop(0, `rgba(${p.c},${p.a})`);
      g.addColorStop(1, `rgba(${p.c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 5, 0, 6.283); ctx.fill();
    }
    slashes = slashes.filter((s) => s.life > 0 && s.x < w + 400);
    for (const s of slashes) {
      s.x += s.vx; s.y += s.vy; s.life -= .012;
      const len = 260;
      const g = ctx.createLinearGradient(s.x - len, s.y - s.vy * 6, s.x, s.y);
      g.addColorStop(0, `rgba(${s.c},0)`);
      g.addColorStop(1, `rgba(${s.c},${Math.max(0, s.life)})`);
      ctx.strokeStyle = g; ctx.lineWidth = 3; ctx.shadowColor = `rgb(${s.c})`; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.moveTo(s.x - len, s.y - s.vy * 6); ctx.lineTo(s.x, s.y); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(tick);
  })();
})();
