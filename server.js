const express = require("express");
const cookieSession = require("cookie-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const gzip = promisify(zlib.gzip);
const { DEFAULT_CARDS, RARITIES } = require("./cards");

// ---------- Configuration ----------
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// Adresse du site (sans « / » final). Elle sert aussi au callback Discord : {BASE_URL}/auth/discord/callback
const BASE_URL = (process.env.BASE_URL || "https://12e-division-deck-production-29b8ed26.up.railway.app").replace(/\/+$/, "");
// Fondateur : toujours admin, quoi qu'il arrive (compte Discord fixe, non modifiable via l'interface).
const FOUNDER_ID = "discord:653263485362503693";
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 heures
const BOOSTER_SIZE = 3;
// Boosters (séries) : chaque carte appartient à une ou plusieurs séries ; un booster tire dans la série choisie.
const SETS = [
  { id: "douzieme", label: "12e Division" },
  { id: "yamato", label: "Yamato" },
];
const SET_IDS = SETS.map((x) => x.id);
const BONUS_MAX = 1000; // boosters en réserve (donnés par les admins) : maximum par joueur
const GRANT_MAX = 100; // boosters donnés d'un coup par un admin : maximum
const SHOWCASE_MAX = 6;
const MAX_OPEN_TICKETS = 5;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const UPLOAD_DIR = path.join(path.dirname(DATA_FILE), "uploads");

const discordEnabled = Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET);

// Pas de mode test : le site ne démarre que si la connexion Discord et le secret de session sont configurés.
{
  const missing = [];
  if (!DISCORD_CLIENT_ID) missing.push("DISCORD_CLIENT_ID");
  if (!DISCORD_CLIENT_SECRET) missing.push("DISCORD_CLIENT_SECRET");
  if (!SESSION_SECRET || SESSION_SECRET.length < 16) missing.push("SESSION_SECRET (16 caractères minimum)");
  if (missing.length) {
    console.error("❌ Configuration incomplète. Variables manquantes : " + missing.join(", "));
    console.error("   Voir le README (section « Configuration »).");
    process.exit(1);
  }
}

for (const d of ["cards", "wallpapers", "logo"]) fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true });

// ---------- Utilitaires ----------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const newPid = () => crypto.randomBytes(5).toString("hex");

// ---------- Stockage (fichier JSON) + sauvegardes automatiques ----------
// data.json est écrit de façon atomique. En plus, des copies datées sont gardées dans le dossier « backups »
// (à côté de data.json) : récentes (toutes les 10 min si ça change), quotidiennes, manuelles.
// Au démarrage, si data.json est absent ou illisible, la dernière sauvegarde valide est restaurée automatiquement.
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), "backups");
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_GAP_MS = 10 * 60 * 1000;
const BACKUP_KEEP = { auto: 30, daily: 14, manual: 20, "pre-restore": 10 };
const BACKUP_RE = /^(auto|daily|manual|pre-restore)-[0-9A-Za-z_-]+\.json$/;

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => BACKUP_RE.test(f))
      .map((f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, time: st.mtimeMs, kind: f.split("-")[0] }; })
      .sort((a, b) => b.time - a.time);
  } catch (_) { return []; }
}

let db = {};
(function loadDb() {
  const fileExisted = fs.existsSync(DATA_FILE);
  const candidates = [DATA_FILE, DATA_FILE + ".tmp", ...listBackups().map((b) => path.join(BACKUP_DIR, b.name))];
  let from = null;
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (d && typeof d === "object" && !Array.isArray(d)) { db = d; from = f; break; }
    } catch (e) { console.error(`⚠️  ${path.basename(f)} illisible : ${e.message}`); }
  }
  if (!from && fileExisted) {
    // Fichier présent mais illisible, et aucune sauvegarde valide : on ne l'écrase surtout pas.
    const keep = `${DATA_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, keep);
    console.error(`❌ data.json est illisible et aucune sauvegarde n'est utilisable. Copie conservée : ${keep}`);
    process.exit(1);
  }
  if (from && from !== DATA_FILE) {
    if (fileExisted) fs.copyFileSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`);
    console.warn(`♻️  Données restaurées automatiquement depuis ${path.basename(from)}`);
  }
})();

function normalizeDb() {
  if (!db || typeof db !== "object" || Array.isArray(db)) db = {};
  db.users ||= {};
  db.tickets ||= [];
  db.nextTicketId ||= 1;
  db.logo ||= null; // { file, v } : logo du site (remplace le sceau XII)
  db.admins ||= []; // ids des admins nommés par le fondateur
  if (!Array.isArray(db.codes)) db.codes = []; // codes cadeaux : { code, boosters, maxUses (0 = illimité), usedBy: [ids], createdAt }
  db.stats ||= { boosters: 0 };
  if (!Array.isArray(db.cards)) {
    db.cards = DEFAULT_CARDS.map((c) => ({ ...c, image: null }));
  }
  db.nextCardId ||= Math.max(0, ...db.cards.map((c) => c.id)) + 1;
  // Anciennes cartes (avant Yamato) : elles sont dans le booster 12e Division.
  for (const c of db.cards) {
    const sets = Array.isArray(c.sets) ? c.sets.filter((x) => SET_IDS.includes(x)) : [];
    c.sets = sets.length ? [...new Set(sets)] : ["douzieme"];
  }
  for (const u of Object.values(db.users)) {
    u.pid ||= newPid();
    u.collection ||= {};
    u.showcase ||= [];
    u.wallpaper ||= null;
    u.bonusBoosters = clamp(Math.floor(Number(u.bonusBoosters)) || 0, 0, BONUS_MAX);
    if (u.wallpaper) {
      // anciens comptes : une photo perso = source « custom », sinon fond par défaut
      if (!u.wallpaper.source) u.wallpaper.source = u.wallpaper.file ? "custom" : "default";
      if (u.wallpaper.source === "custom" && !u.wallpaper.file) u.wallpaper.source = "default";
    }
    u.textTheme ||= "os";
    delete u.isAdmin; // ancien flag du mode test : les droits viennent désormais du fondateur / accès donnés par le fondateur
  }
}
normalizeDb();

function writeAtomic(file, content) {
  const tmp = file + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
let dirty = false;
let lastBackupAt = 0;

function pruneBackups() {
  for (const [kind, max] of Object.entries(BACKUP_KEEP)) {
    for (const b of listBackups().filter((x) => x.kind === kind).slice(max)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch (_) {}
    }
  }
}

// kind : auto | manual | pre-restore. Ne lève jamais d'erreur (une sauvegarde ratée ne doit pas bloquer le site).
function makeBackup(kind = "auto") {
  try {
    if (!Object.keys(db.users).length && !db.cards.length) return null; // rien à sauvegarder
    const json = JSON.stringify(db);
    const name = `${kind}-${stamp()}.json`;
    writeAtomic(path.join(BACKUP_DIR, name), json);
    const daily = path.join(BACKUP_DIR, `daily-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(daily)) writeAtomic(daily, json);
    lastBackupAt = Date.now();
    dirty = false;
    pruneBackups();
    syncMirror(); // les images sont copiées aussi
    return name;
  } catch (e) {
    console.error("Sauvegarde échouée :", e.message);
    return null;
  }
}

// ---------- Copie des images (miroir) ----------
// Les sauvegardes .json ne contiennent pas les images. On en garde donc une copie dans backups/files,
// mise à jour à chaque sauvegarde. Au démarrage, toute image utilisée mais absente est remise en place.
const UPLOAD_SUBDIRS = ["cards", "wallpapers", "logo"];
const SAFE_FILE = /^(cards|wallpapers|logo)\/[A-Za-z0-9._-]+$/;
const MIRROR_DIR = path.join(BACKUP_DIR, "files");

function listFiles(root) {
  const out = [];
  for (const d of UPLOAD_SUBDIRS) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch (_) {}
    for (const n of names) if (SAFE_FILE.test(`${d}/${n}`)) out.push(`${d}/${n}`);
  }
  return out;
}

function referencedFiles() {
  const used = new Set();
  for (const c of db.cards || []) {
    const m = /^\/uploads\/(cards\/[A-Za-z0-9._-]+)/.exec(c.image || "");
    if (m) used.add(m[1]);
  }
  if (db.logo && db.logo.file) used.add(`logo/${db.logo.file}`);
  for (const u of Object.values(db.users || {})) if (u.wallpaper && u.wallpaper.file) used.add(`wallpapers/${u.wallpaper.file}`);
  return used;
}

function syncMirror() {
  try {
    for (const rel of listFiles(UPLOAD_DIR)) {
      const src = path.join(UPLOAD_DIR, rel), dst = path.join(MIRROR_DIR, rel);
      let same = false;
      try { const a = fs.statSync(src), b = fs.statSync(dst); same = a.size === b.size && b.mtimeMs >= a.mtimeMs; } catch (_) {}
      if (same) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    // Ménage : copies d'images qui ne servent plus (carte supprimée…) depuis plus de 7 jours.
    if (db.cards && db.cards.length) {
      const used = referencedFiles(), limit = Date.now() - 7 * 864e5;
      for (const rel of listFiles(MIRROR_DIR)) {
        if (used.has(rel)) continue;
        const p = path.join(MIRROR_DIR, rel);
        try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch (_) {}
      }
    }
  } catch (e) {
    console.error("Copie des images échouée :", e.message);
  }
}

function restoreMissingImages() {
  let n = 0;
  try {
    const used = referencedFiles();
    for (const rel of listFiles(MIRROR_DIR)) {
      const dst = path.join(UPLOAD_DIR, rel);
      if (!used.has(rel) || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(MIRROR_DIR, rel), dst);
      n++;
    }
  } catch (e) {
    console.error("Restauration des images échouée :", e.message);
  }
  if (n) console.warn(`♻️  ${n} image(s) remise(s) en place depuis la copie de sauvegarde`);
}

// Fichier unique « données + images » (utilisé par le téléchargement et l'envoi hors site).
function buildFullExport(withImages = true) {
  const files = {};
  if (withImages) {
    for (const rel of listFiles(UPLOAD_DIR)) {
      try { files[rel] = fs.readFileSync(path.join(UPLOAD_DIR, rel)).toString("base64"); } catch (_) {}
    }
  }
  return JSON.stringify({ app: "douzieme-division", version: 1, exportedAt: new Date().toISOString(), db, files });
}

// Signature des images (noms + tailles) : sert à n'envoyer les images hors site que si elles ont changé.
function imagesSignature() {
  return crypto.createHash("sha1").update(listFiles(UPLOAD_DIR).sort().map((rel) => {
    try { return `${rel}:${fs.statSync(path.join(UPLOAD_DIR, rel)).size}`; } catch (_) { return rel; }
  }).join("|")).digest("hex");
}

// Découpe les images en lots compressés qui tiennent chacun sous la limite d'envoi.
async function buildImageParts(maxBytes) {
  const all = [];
  for (const rel of listFiles(UPLOAD_DIR)) {
    try { all.push([rel, fs.readFileSync(path.join(UPLOAD_DIR, rel)).toString("base64")]); } catch (_) {}
  }
  const parts = [];
  const pack = async (entries) => {
    if (!entries.length) return;
    const buf = await gzip(JSON.stringify({ app: "douzieme-division", version: 1, kind: "images", exportedAt: new Date().toISOString(), files: Object.fromEntries(entries) }), { level: 9 });
    if (buf.length <= maxBytes) { parts.push(buf); return; }
    if (entries.length === 1) { console.error(`Image trop lourde pour Discord, ignorée : ${entries[0][0]}`); return; }
    const mid = entries.length >> 1;
    await pack(entries.slice(0, mid));
    await pack(entries.slice(mid));
  };
  // pré-découpage grossier pour éviter de compresser un énorme bloc d'un coup
  let cur = [], size = 0;
  for (const e of all) {
    if (cur.length && size + e[1].length > maxBytes) { await pack(cur); cur = []; size = 0; }
    cur.push(e); size += e[1].length;
  }
  await pack(cur);
  return parts;
}

// ---------- Copie hors du site (webhook Discord, optionnel) ----------
// Si le disque du site disparaît, les copies locales disparaissent avec lui. BACKUP_WEBHOOK_URL envoie donc
// automatiquement la sauvegarde dans un salon Discord : elle survit à tout ce qui peut arriver à l'hébergeur.
const WEBHOOK_URL = process.env.BACKUP_WEBHOOK_URL || "";
const WEBHOOK_MAX = (Number(process.env.BACKUP_WEBHOOK_MAX_MB) || 9) * 1048576; // limite d'envoi Discord (prudente)
const OFFSITE_GAP_MS = Math.max(5, Number(process.env.BACKUP_OFFSITE_MINUTES) || 60) * 60 * 1000; // au plus un envoi par heure (réglable)
const OFFSITE_STATE = path.join(BACKUP_DIR, "offsite-state.json");
const offsite = {
  enabled: /^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/i.test(WEBHOOK_URL),
  lastAt: 0, lastOk: null, lastError: null, lastWithImages: null,
};
let offsiteImagesSig = null;
try { const st = JSON.parse(fs.readFileSync(OFFSITE_STATE, "utf8")); offsite.lastAt = st.at || 0; offsiteImagesSig = st.imagesSig || null; } catch (_) {}
if (WEBHOOK_URL && !offsite.enabled) console.error("⚠️  BACKUP_WEBHOOK_URL n'est pas une URL de webhook Discord valide : envoi hors site désactivé.");
let offsiteBusy = false;
let offsiteDirty = true;

async function postWebhook(buf, filename, content, timeoutMs) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ username: "Douzième Division – sauvegardes", content, allowed_mentions: { parse: [] } }));
  form.append("files[0]", new Blob([buf], { type: "application/gzip" }), filename);
  const r = await fetch(WEBHOOK_URL, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Discord a répondu ${r.status}`);
}

// Envoie toujours un fichier « données » complet (petit). Les images y sont jointes si ça tient ;
// sinon elles partent à part, en plusieurs fichiers, uniquement quand elles ont changé.
async function sendOffsite(reason = "auto", timeoutMs = 60000) {
  if (!offsite.enabled || offsiteBusy) return false;
  offsiteBusy = true;
  try {
    const counts = `${Object.keys(db.users).length} joueur(s) · ${db.cards.length} carte(s)`;
    let withImages = true, extraParts = 0;
    let buf = await gzip(buildFullExport(true), { level: 9 });
    const sig = imagesSignature();
    let sentSig = sig;
    if (buf.length > WEBHOOK_MAX) {
      withImages = false;
      buf = await gzip(buildFullExport(false), { level: 9 });
      if (buf.length > WEBHOOK_MAX) throw new Error("données trop lourdes pour Discord");
      const stamped = stamp();
      if (sig !== offsiteImagesSig) {
        const parts = await buildImageParts(WEBHOOK_MAX);
        for (let i = 0; i < parts.length; i++) {
          await postWebhook(parts[i], `douzieme-division-images-${stamped}-${i + 1}sur${parts.length}.json.gz`,
            `🖼 Images (${reason}) · partie ${i + 1}/${parts.length} · à importer avec le fichier « données » du ${stamped}`, timeoutMs);
        }
        extraParts = parts.length;
      } else sentSig = offsiteImagesSig;
    }
    await postWebhook(buf, `douzieme-division-${withImages ? "complet" : "donnees"}-${stamp()}.json.gz`,
      `💾 Sauvegarde (${reason}) · ${counts}` + (withImages ? "" : "\n🖼 Images envoyées dans des fichiers séparés « images » (à importer aussi en cas de restauration)."), timeoutMs);
    offsite.lastAt = Date.now(); offsite.lastOk = true; offsite.lastError = null; offsite.lastWithImages = withImages;
    offsiteImagesSig = sentSig;
    offsiteDirty = false;
    try { writeAtomic(OFFSITE_STATE, JSON.stringify({ at: offsite.lastAt, imagesSig: offsiteImagesSig })); } catch (_) {}
    return true;
  } catch (e) {
    offsite.lastOk = false; offsite.lastError = e.name === "TimeoutError" ? "délai dépassé" : e.message;
    console.error("Envoi hors site échoué :", offsite.lastError);
    return false;
  } finally {
    offsiteBusy = false;
  }
}

function save() {
  writeAtomic(DATA_FILE, JSON.stringify(db));
  dirty = true;
  offsiteDirty = true;
  if (Date.now() - lastBackupAt > BACKUP_GAP_MS) makeBackup("auto");
}
restoreMissingImages(); // images perdues mais présentes dans la copie
save();
makeBackup("auto"); // une copie à chaque démarrage
setInterval(() => { if (dirty) makeBackup("auto"); }, 5 * 60 * 1000).unref();

// Envoi hors site : au démarrage (si la dernière copie a plus de 6 h), puis dès que quelque chose change, au plus toutes les 6 h.
const offsiteDue = () => offsite.enabled && offsiteDirty && Date.now() - offsite.lastAt > OFFSITE_GAP_MS;
if (!offsite.enabled) console.warn("⚠️  Pas de BACKUP_WEBHOOK_URL : aucune copie hors du site. Si l'hébergeur efface le disque, les données sont perdues.");
if (!process.env.DATA_FILE) console.warn("⚠️  DATA_FILE n'est pas défini : les données sont stockées dans le dossier du site (perdues à chaque redéploiement sans Volume).");
setTimeout(() => { if (offsiteDue()) sendOffsite("démarrage"); }, 30 * 1000).unref();
setInterval(() => { if (offsiteDue()) sendOffsite("auto"); }, 10 * 60 * 1000).unref();

// Arrêt propre (redéploiement, Ctrl+C, plantage) : dernière écriture + dernière sauvegarde + copie hors site si possible.
let shuttingDown = false;
async function finalSave(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { writeAtomic(DATA_FILE, JSON.stringify(db)); makeBackup("auto"); } catch (_) {}
  if (offsite.enabled) {
    // on attend un éventuel envoi en cours, puis on envoie l'état final
    for (let i = 0; i < 30 && offsiteBusy; i++) await new Promise((r) => setTimeout(r, 100));
    await Promise.race([sendOffsite(reason, 6000), new Promise((r) => setTimeout(r, 7000))]);
  }
  process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => finalSave("arrêt du site", 0));
process.on("uncaughtException", (e) => { console.error("Erreur fatale :", e); finalSave("plantage du site", 1); });
// Une erreur isolée ne doit pas faire tomber tout le site.
process.on("unhandledRejection", (e) => console.error("Promesse rejetée :", e));

const WP_DEFAULT = { blur: 6, dim: 45 };
// Fonds prédéfinis (fichiers dans public/wallpapers, miniatures « -thumb »). « default » = public/default-wallpaper.jpg.
const WP_PRESETS = [
  { id: "default", label: "Soleil rouge" },
  { id: "neon-cyan", label: "Ville néon" },
  { id: "violet", label: "Nuit violette" },
  { id: "jade", label: "Forêt de jade" },
  { id: "or", label: "Aube dorée" },
  { id: "azur", label: "Lune d'azur" },
];
const WP_SOURCES = WP_PRESETS.map((p) => p.id).concat("custom");
const WP_PHOTO_MAX = 4 * 1024 * 1024;
function wallpaperJson(u) {
  const w = u.wallpaper;
  const hasFile = !!(w && w.file);
  const source = w && WP_SOURCES.includes(w.source) && (w.source !== "custom" || hasFile) ? w.source : "default";
  return {
    custom: hasFile, // une photo perso est enregistrée (elle reste disponible même si un fond prédéfini est choisi)
    source,
    blur: w ? w.blur : WP_DEFAULT.blur,
    dim: w ? w.dim : WP_DEFAULT.dim,
    v: w ? w.v : 0,
    photo: hasFile ? { width: w.width || null, height: w.height || null, bytes: w.bytes || null } : null,
  };
}

const TEXT_THEMES = ["os", "or", "blanc", "vermillon", "jade", "azur", "lavande", "rose"];

const cardById = (id) => db.cards.find((c) => c.id === id);
const userByPid = (pid) => Object.values(db.users).find((u) => u.pid === pid);
const isFounder = (u) => u.id === FOUNDER_ID;
const isAdmin = (u) => isFounder(u) || db.admins.includes(u.id);

function createUser(id, name, avatar) {
  const u = {
    id,
    pid: newPid(),
    name,
    avatar: avatar || null,
    collection: {},
    lastBooster: 0,
    bonusBoosters: 0,
    showcase: [],
    wallpaper: null,
    textTheme: "os",
    createdAt: Date.now(),
  };
  db.users[id] = u;
  return u;
}

// ---------- Images ----------
function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

function decodeImage(dataUrl, maxBytes) {
  const s = String(dataUrl || "");
  const comma = s.indexOf(",");
  if (comma < 0 || comma > 40 || !/^data:image\/(png|jpeg|webp);base64$/.test(s.slice(0, comma))) {
    throw httpError(400, "Image invalide (png, jpeg ou webp)");
  }
  const buf = Buffer.from(s.slice(comma + 1), "base64");
  if (buf.length > maxBytes) throw httpError(413, "Image trop lourde");
  const ext = sniffImage(buf);
  if (!ext) throw httpError(400, "Fichier image invalide");
  return { buf, ext };
}

function removeFile(dir, file) {
  if (!file) return;
  fs.unlink(path.join(UPLOAD_DIR, dir, path.basename(file)), () => {});
}

function saveCardImage(card, dataUrl) {
  const { buf, ext } = decodeImage(dataUrl, 1.5 * 1024 * 1024);
  const file = `card-${card.id}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, "cards", file), buf);
  removeFile("cards", card.image);
  card.image = `/uploads/cards/${file}`;
}

// Migration : les anciennes illustrations générées par le site sont retirées (seules les images des admins comptent).
for (const c of db.cards) {
  if (/card-\d+-ph\d+-/.test(c.image || "")) { removeFile("cards", c.image); c.image = null; }
}
save();

const logoUrl = () => (db.logo ? `/uploads/logo/${db.logo.file}?v=${db.logo.v}` : null);

// ---------- Tirage des cartes ----------
function drawCard(setId = "douzieme") {
  const byRarity = {};
  for (const c of db.cards) if ((c.sets || ["douzieme"]).includes(setId)) (byRarity[c.rarity] ||= []).push(c);
  const entries = Object.entries(RARITIES).filter(([k]) => byRarity[k]);
  if (!entries.length) return null;
  const total = entries.reduce((s, [, r]) => s + r.weight, 0);
  let roll = crypto.randomInt(0, total * 100) / 100;
  let chosen = entries[entries.length - 1][0];
  for (const [k, r] of entries) {
    if (roll < r.weight) {
      chosen = k;
      break;
    }
    roll -= r.weight;
  }
  const pool = byRarity[chosen];
  return pool[crypto.randomInt(0, pool.length)];
}

function cleanCardInput(b) {
  const name = String(b.name || "").trim().slice(0, 40);
  if (name.length < 2) throw httpError(400, "Nom trop court (2 caractères min.)");
  const rarity = String(b.rarity || "");
  if (!RARITIES[rarity]) throw httpError(400, "Rareté invalide");
  const desc = String(b.desc || "").trim().slice(0, 160);
  const emoji = Array.from(String(b.emoji || "").trim()).slice(0, 4).join("") || "🎴";
  let hue = parseInt(b.hue, 10);
  if (!Number.isFinite(hue)) hue = crypto.randomInt(0, 360);
  hue = ((hue % 360) + 360) % 360;
  const rawSets = Array.isArray(b.sets) ? b.sets : [];
  const sets = SET_IDS.filter((id) => rawSets.includes(id));
  if (!sets.length) throw httpError(400, "Choisis au moins un booster (12e Division, Yamato ou les deux)");
  return { name, rarity, desc, emoji, hue, sets };
}

// ---------- Vues JSON ----------
function playerStats(u) {
  const owned = Object.keys(u.collection).map(Number).filter((id) => u.collection[id] > 0 && cardById(id));
  return {
    unique: owned.length,
    legendary: owned.filter((id) => cardById(id).rarity === "legendary").length,
    mythic: owned.filter((id) => cardById(id).rarity === "mythic").length,
  };
}

function cleanCollection(u) {
  const out = {};
  for (const [id, n] of Object.entries(u.collection)) if (n > 0 && cardById(Number(id))) out[id] = n;
  return out;
}

function cleanShowcase(u) {
  return u.showcase.filter((id) => u.collection[id] > 0 && cardById(id)).slice(0, SHOWCASE_MAX);
}

function meJson(u) {
  const nextAt = u.lastBooster + COOLDOWN_MS;
  return {
    pid: u.pid,
    name: u.name,
    avatar: u.avatar || null,
    isAdmin: isAdmin(u),
    isFounder: isFounder(u),
    collection: cleanCollection(u),
    showcase: cleanShowcase(u),
    nextBoosterAt: nextAt,
    bonusBoosters: u.bonusBoosters || 0,
    canOpen: Date.now() >= nextAt || (u.bonusBoosters || 0) > 0,
    wallpaper: wallpaperJson(u),
    textTheme: TEXT_THEMES.includes(u.textTheme) ? u.textTheme : "os",
  };
}

function ticketJson(t) {
  const u = db.users[t.userId];
  return {
    id: t.id,
    subject: t.subject,
    message: t.message,
    status: t.status,
    note: t.note || "",
    grantedCardId: t.grantedCardId || null,
    createdAt: t.createdAt,
    resolvedAt: t.resolvedAt || null,
    player: { pid: u ? u.pid : null, name: u ? u.name : t.userName },
  };
}

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
const jsonSmall = express.json({ limit: "6mb" });
app.use((req, res, next) => (req.path === "/api/founder/import" ? next() : jsonSmall(req, res, next)));
app.use(
  cookieSession({
    name: "session",
    secret: SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
    httpOnly: true,
    secure: BASE_URL.startsWith("https://"),
  })
);
// Seules les images de cartes sont publiques ; les fonds d'écran restent privés.
app.use("/uploads/logo", express.static(path.join(UPLOAD_DIR, "logo"), { maxAge: "1h" }));
app.use("/uploads/cards", express.static(path.join(UPLOAD_DIR, "cards"), { maxAge: "7d" }));
app.use(express.static(path.join(__dirname, "public")));

function currentUser(req) {
  return req.session && req.session.userId ? db.users[req.session.userId] : null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Non connecté" });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: "Réservé aux admins" });
    next();
  });
}

// ---------- API publique / joueur ----------
app.get("/api/config", (req, res) => {
  res.json({
    logo: logoUrl(), cooldownMs: COOLDOWN_MS, boosterSize: BOOSTER_SIZE, showcaseMax: SHOWCASE_MAX,
    wallpaperPresets: WP_PRESETS,
    sets: SETS,
    wallpaperPhoto: { maxMB: WP_PHOTO_MAX / 1048576, recommended: "1920 × 1080", minWidth: 1280 },
  });
});

app.get("/api/catalog", (req, res) => {
  const cards = [...db.cards].sort((a, b) => a.id - b.id);
  res.json({ cards, rarities: RARITIES, sets: SETS });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  res.json({ user: u ? meJson(u) : null });
});

app.post("/api/booster", requireAuth, (req, res) => {
  const user = req.user;
  const nextAt = user.lastBooster + COOLDOWN_MS;
  const freeReady = Date.now() >= nextAt;
  const stock = user.bonusBoosters || 0;
  if (!freeReady && stock <= 0) {
    return res.status(429).json({ error: "Booster pas encore prêt", nextBoosterAt: nextAt, bonusBoosters: stock });
  }
  const setId = req.body && req.body.set ? String(req.body.set) : "douzieme";
  if (!SET_IDS.includes(setId)) return res.status(400).json({ error: "Booster inconnu" });
  const drawn = [];
  for (let i = 0; i < BOOSTER_SIZE; i++) {
    const c = drawCard(setId);
    if (!c) return res.status(400).json({ error: `Aucune carte disponible dans le booster ${SETS.find((x) => x.id === setId).label} pour le moment` });
    drawn.push(c);
  }
  // Les cartes les plus communes sortent en premier, les plus rares à la fin.
  drawn.sort((a, b) => RARITIES[b.rarity].weight - RARITIES[a.rarity].weight);
  for (const c of drawn) user.collection[c.id] = (user.collection[c.id] || 0) + 1;
  // Le booster gratuit (toutes les 4 h) part en premier : le délai repart tout de suite ; sinon on puise dans la réserve.
  if (freeReady) user.lastBooster = Date.now();
  else user.bonusBoosters = stock - 1;
  db.stats.boosters = (db.stats.boosters || 0) + 1;
  save();
  res.json({
    cards: drawn,
    nextBoosterAt: user.lastBooster + COOLDOWN_MS,
    bonusBoosters: user.bonusBoosters || 0,
    collection: cleanCollection(user),
  });
});

// ---------- Joueurs, collections, vitrines ----------
app.get("/api/players", requireAuth, (req, res) => {
  const total = db.cards.length;
  const players = Object.values(db.users)
    .map((u) => ({
      pid: u.pid,
      name: u.name,
      avatar: u.avatar || null,
      ...playerStats(u),
      total,
      showcase: cleanShowcase(u),
    }))
    .sort((a, b) => b.mythic - a.mythic || b.legendary - a.legendary || b.unique - a.unique || a.name.localeCompare(b.name));
  res.json({ players });
});

app.get("/api/players/:pid", requireAuth, (req, res) => {
  const u = userByPid(req.params.pid);
  if (!u) return res.status(404).json({ error: "Joueur introuvable" });
  res.json({
    pid: u.pid,
    name: u.name,
    avatar: u.avatar || null,
    ...playerStats(u),
    total: db.cards.length,
    collection: cleanCollection(u),
    showcase: cleanShowcase(u),
  });
});

app.put("/api/showcase", requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.cardIds) ? req.body.cardIds.map(Number) : null;
  if (!ids) throw httpError(400, "Liste de cartes invalide");
  const unique = [...new Set(ids)];
  if (unique.length > SHOWCASE_MAX) throw httpError(400, `${SHOWCASE_MAX} cartes maximum dans la vitrine`);
  for (const id of unique) {
    if (!Number.isInteger(id) || !(req.user.collection[id] > 0) || !cardById(id)) {
      throw httpError(400, "Tu ne peux mettre en vitrine que des cartes que tu possèdes");
    }
  }
  req.user.showcase = unique;
  save();
  res.json({ showcase: unique });
});

// ---------- Fond d'écran (privé) ----------
app.get("/api/wallpaper", requireAuth, (req, res) => {
  const w = req.user.wallpaper;
  if (!w || !w.file) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=3600");
  res.sendFile(path.join(UPLOAD_DIR, "wallpapers", path.basename(w.file)));
});

app.put("/api/wallpaper", requireAuth, (req, res) => {
  const u = req.user;
  const blur = clamp(parseInt(req.body.blur, 10) || 0, 0, 20);
  const dim = clamp(parseInt(req.body.dim, 10) || 0, 0, 90);
  const w = u.wallpaper || (u.wallpaper = { file: null, source: "default", blur, dim, v: 0 });
  if (req.body.source !== undefined) {
    const src = String(req.body.source);
    if (!WP_SOURCES.includes(src)) throw httpError(400, "Fond inconnu");
    if (src === "custom" && !w.file && !req.body.image) throw httpError(400, "Tu n'as pas encore de photo perso");
    w.source = src;
  }
  if (req.body.image) {
    const { buf, ext } = decodeImage(req.body.image, WP_PHOTO_MAX);
    const file = `${u.pid}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, "wallpapers", file), buf);
    if (w.file) removeFile("wallpapers", w.file);
    w.file = file;
    w.bytes = buf.length;
    w.width = clamp(parseInt(req.body.width, 10) || 0, 0, 20000) || null; // affichage seulement
    w.height = clamp(parseInt(req.body.height, 10) || 0, 0, 20000) || null;
    w.source = "custom"; // envoyer une photo l'active aussitôt
    w.v = Date.now();
  }
  w.blur = blur;
  w.dim = dim;
  save();
  res.json({ wallpaper: wallpaperJson(u) });
});

app.put("/api/text-theme", requireAuth, (req, res) => {
  const t = String(req.body.theme || "");
  if (!TEXT_THEMES.includes(t)) throw httpError(400, "Couleur inconnue");
  req.user.textTheme = t;
  save();
  res.json({ textTheme: t });
});

// Supprime la photo perso ; si elle était affichée, on revient au fond par défaut.
app.delete("/api/wallpaper", requireAuth, (req, res) => {
  const w = req.user.wallpaper;
  if (w && w.file) removeFile("wallpapers", w.file);
  if (w) {
    w.file = null; w.bytes = w.width = w.height = null;
    if (w.source === "custom") w.source = "default";
    w.v = Date.now();
  }
  save();
  res.json({ wallpaper: wallpaperJson(req.user) });
});

// ---------- Tickets (demandes de cartes) ----------
app.get("/api/tickets", requireAuth, (req, res) => {
  const mine = db.tickets.filter((t) => t.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ tickets: mine.map(ticketJson) });
});

app.post("/api/tickets", requireAuth, (req, res) => {
  const subject = String(req.body.subject || "").trim().slice(0, 80);
  const message = String(req.body.message || "").trim().slice(0, 600);
  if (subject.length < 2) throw httpError(400, "Sujet trop court");
  if (message.length < 2) throw httpError(400, "Message trop court");
  const open = db.tickets.filter((t) => t.userId === req.user.id && t.status === "open").length;
  if (open >= MAX_OPEN_TICKETS) throw httpError(429, `Tu as déjà ${MAX_OPEN_TICKETS} tickets en attente`);
  const t = {
    id: db.nextTicketId++,
    userId: req.user.id,
    userName: req.user.name,
    subject,
    message,
    status: "open",
    note: "",
    createdAt: Date.now(),
  };
  db.tickets.push(t);
  save();
  res.json({ ticket: ticketJson(t) });
});


// Un joueur peut supprimer ses propres tickets une fois traités.
app.delete("/api/tickets/:id", requireAuth, (req, res) => {
  const i = db.tickets.findIndex((x) => x.id === Number(req.params.id) && x.userId === req.user.id);
  if (i < 0) throw httpError(404, "Ticket introuvable");
  if (db.tickets[i].status === "open") throw httpError(409, "Ce ticket est encore en attente");
  db.tickets.splice(i, 1);
  save();
  res.json({ ok: true });
});

// ---------- Admin ----------
app.get("/api/admin/tickets", requireAdmin, (req, res) => {
  const onlyOpen = req.query.status !== "all";
  const list = db.tickets
    .filter((t) => !onlyOpen || t.status === "open")
    .sort((a, b) => (onlyOpen ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  res.json({ tickets: list.map(ticketJson) });
});

app.post("/api/admin/tickets/:id/resolve", requireAdmin, (req, res) => {
  const t = db.tickets.find((x) => x.id === Number(req.params.id));
  if (!t) throw httpError(404, "Ticket introuvable");
  if (t.status !== "open") throw httpError(409, "Ticket déjà traité");
  const action = req.body.action;
  if (!["accept", "refuse"].includes(action)) throw httpError(400, "Action invalide");
  const note = String(req.body.note || "").trim().slice(0, 300);
  if (action === "accept" && req.body.grantCardId) {
    const card = cardById(Number(req.body.grantCardId));
    const target = db.users[t.userId];
    if (!card) throw httpError(400, "Carte introuvable");
    if (!target) throw httpError(400, "Joueur introuvable");
    target.collection[card.id] = (target.collection[card.id] || 0) + 1;
    t.grantedCardId = card.id;
  }
  t.status = action === "accept" ? "accepted" : "refused";
  t.note = note;
  t.resolvedAt = Date.now();
  t.resolvedBy = req.user.pid;
  save();
  res.json({ ticket: ticketJson(t) });
});

// Supprimer un ticket (admin) ou tous les tickets terminés d'un coup.
app.delete("/api/admin/tickets/:id", requireAdmin, (req, res) => {
  const i = db.tickets.findIndex((x) => x.id === Number(req.params.id));
  if (i < 0) throw httpError(404, "Ticket introuvable");
  db.tickets.splice(i, 1);
  save();
  res.json({ ok: true });
});

app.post("/api/admin/tickets/purge", requireAdmin, (req, res) => {
  const before = db.tickets.length;
  db.tickets = db.tickets.filter((t) => t.status === "open");
  const removed = before - db.tickets.length;
  if (removed) save();
  res.json({ removed });
});

app.post("/api/admin/cards", requireAdmin, (req, res) => {
  const data = cleanCardInput(req.body);
  if (!req.body.image) throw httpError(400, "Une image est obligatoire pour créer une carte");
  const card = { id: db.nextCardId, ...data, image: null };
  saveCardImage(card, req.body.image);
  db.nextCardId++;
  db.cards.push(card);
  save();
  res.json({ card });
});

app.put("/api/admin/cards/:id", requireAdmin, (req, res) => {
  const card = cardById(Number(req.params.id));
  if (!card) throw httpError(404, "Carte introuvable");
  const data = cleanCardInput(req.body);
  if (!req.body.image && !card.image) throw httpError(400, "Une image est obligatoire pour cette carte");
  Object.assign(card, data);
  if (req.body.image) saveCardImage(card, req.body.image);
  save();
  res.json({ card });
});

app.delete("/api/admin/cards/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const card = cardById(id);
  if (!card) throw httpError(404, "Carte introuvable");
  removeFile("cards", card.image);
  db.cards = db.cards.filter((c) => c.id !== id);
  for (const u of Object.values(db.users)) {
    delete u.collection[id];
    u.showcase = u.showcase.filter((x) => x !== id);
  }
  save();
  res.json({ ok: true });
});

app.post("/api/admin/grant", requireAdmin, (req, res) => {
  const target = userByPid(String(req.body.pid || ""));
  const card = cardById(Number(req.body.cardId));
  if (!target) throw httpError(404, "Joueur introuvable");
  if (!card) throw httpError(404, "Carte introuvable");
  target.collection[card.id] = (target.collection[card.id] || 0) + 1;
  save();
  res.json({ ok: true, player: target.name, card: card.name });
});

// ---------- Admin : tableau de bord, joueurs, statistiques ----------
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const users = Object.values(db.users);
  const byCard = {};
  let copies = 0;
  for (const u of users) {
    for (const [id, n] of Object.entries(u.collection)) {
      if (n > 0 && cardById(Number(id))) {
        const b = (byCard[id] ||= { owners: 0, copies: 0 });
        b.owners++; b.copies += n; copies += n;
      }
    }
  }
  const byRarity = {};
  for (const c of db.cards) byRarity[c.rarity] = (byRarity[c.rarity] || 0) + 1;
  const top = users
    .map((u) => ({ pid: u.pid, name: u.name, avatar: u.avatar || null, ...playerStats(u) }))
    .sort((a, b) => b.mythic - a.mythic || b.legendary - a.legendary || b.unique - a.unique)
    .slice(0, 5);
  res.json({
    players: users.length,
    cards: db.cards.length,
    copies,
    boosters: db.stats.boosters || 0,
    openTickets: db.tickets.filter((t) => t.status === "open").length,
    admins: users.filter(isAdmin).length,
    byRarity,
    byCard,
    top,
  });
});

app.get("/api/admin/players", requireAdmin, (req, res) => {
  const players = Object.values(db.users)
    .map((u) => ({
      pid: u.pid,
      name: u.name,
      avatar: u.avatar || null,
      isAdmin: isAdmin(u),
      isFounder: isFounder(u),
      copies: Object.entries(u.collection).reduce((s, [id, n]) => s + (cardById(Number(id)) ? n : 0), 0),
      lastBooster: u.lastBooster || 0,
      bonusBoosters: u.bonusBoosters || 0,
      collection: cleanCollection(u),
      ...playerStats(u),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ players, total: db.cards.length });
});

app.post("/api/admin/revoke", requireAdmin, (req, res) => {
  const target = userByPid(String(req.body.pid || ""));
  const card = cardById(Number(req.body.cardId));
  if (!target) throw httpError(404, "Joueur introuvable");
  if (!card) throw httpError(404, "Carte introuvable");
  const all = req.body.all === true;
  const have = target.collection[card.id] || 0;
  if (have <= 0) throw httpError(400, "Le joueur n'a pas cette carte");
  target.collection[card.id] = all ? 0 : have - 1;
  if (target.collection[card.id] <= 0) {
    delete target.collection[card.id];
    target.showcase = target.showcase.filter((x) => x !== card.id);
  }
  save();
  res.json({ ok: true, player: target.name, card: card.name });
});

app.post("/api/admin/reset-booster", requireAdmin, (req, res) => {
  const target = userByPid(String(req.body.pid || ""));
  if (!target) throw httpError(404, "Joueur introuvable");
  target.lastBooster = 0;
  save();
  res.json({ ok: true, player: target.name });
});

// ---------- Codes cadeaux ----------
const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const normCode = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");
const codeJson = (c) => ({ code: c.code, boosters: c.boosters, maxUses: c.maxUses || 0, uses: c.usedBy.length, createdAt: c.createdAt });
const codeFails = new Map(); // userId -> { n, until } : freine les essais au hasard
function codeThrottle(userId) {
  const f = codeFails.get(userId);
  return f && f.n >= 8 && Date.now() < f.until;
}

app.get("/api/admin/codes", requireAdmin, (req, res) => {
  res.json({ codes: db.codes.map(codeJson).sort((a, b) => b.createdAt - a.createdAt) });
});

app.post("/api/admin/codes", requireAdmin, (req, res) => {
  const code = normCode(req.body.code);
  if (!CODE_RE.test(code)) throw httpError(400, "Code invalide : 3 à 32 caractères (lettres, chiffres, - ou _)");
  const boosters = Math.trunc(Number(req.body.boosters));
  if (!Number.isFinite(boosters) || boosters < 1 || boosters > GRANT_MAX) throw httpError(400, `Nombre de boosters invalide (1 à ${GRANT_MAX})`);
  const maxUses = req.body.maxUses === "" || req.body.maxUses == null ? 0 : Math.trunc(Number(req.body.maxUses));
  if (!Number.isFinite(maxUses) || maxUses < 0 || maxUses > 100000) throw httpError(400, "Nombre d'utilisations invalide");
  if (db.codes.some((c) => c.code === code)) throw httpError(409, "Ce code existe déjà");
  db.codes.push({ code, boosters, maxUses, usedBy: [], createdAt: Date.now(), createdBy: req.user.id });
  save();
  res.json({ ok: true, code: codeJson(db.codes[db.codes.length - 1]) });
});

app.delete("/api/admin/codes/:code", requireAdmin, (req, res) => {
  const code = normCode(req.params.code);
  const before = db.codes.length;
  db.codes = db.codes.filter((c) => c.code !== code);
  if (db.codes.length === before) throw httpError(404, "Code introuvable");
  save();
  res.json({ ok: true });
});

// Un joueur utilise un code : il reçoit les boosters en réserve (une seule fois par code).
app.post("/api/codes/redeem", requireAuth, (req, res) => {
  const u = req.user;
  if (codeThrottle(u.id)) throw httpError(429, "Trop d'essais. Réessaie dans quelques minutes.");
  const fail = (status, msg) => {
    const f = codeFails.get(u.id);
    codeFails.set(u.id, !f || Date.now() >= f.until ? { n: 1, until: Date.now() + 10 * 60 * 1000 } : { n: f.n + 1, until: f.until });
    throw httpError(status, msg);
  };
  const c = db.codes.find((x) => x.code === normCode(req.body.code));
  if (!c) fail(404, "Code invalide");
  if (c.usedBy.includes(u.id)) throw httpError(400, "Tu as déjà utilisé ce code");
  if (c.maxUses && c.usedBy.length >= c.maxUses) throw httpError(400, "Ce code n'est plus disponible");
  c.usedBy.push(u.id);
  u.bonusBoosters = clamp((u.bonusBoosters || 0) + c.boosters, 0, BONUS_MAX);
  save();
  res.json({ ok: true, boosters: c.boosters, bonusBoosters: u.bonusBoosters });
});

// Donne (count > 0) ou retire (count < 0) des boosters en réserve à un joueur, ou à tous (all: true).
app.post("/api/admin/grant-boosters", requireAdmin, (req, res) => {
  const count = Math.trunc(Number(req.body.count));
  if (!Number.isFinite(count) || count === 0 || Math.abs(count) > GRANT_MAX) {
    throw httpError(400, `Nombre de boosters invalide (1 à ${GRANT_MAX})`);
  }
  const apply = (u) => { u.bonusBoosters = clamp((u.bonusBoosters || 0) + count, 0, BONUS_MAX); };
  if (req.body.all === true) {
    if (count < 0) throw httpError(400, "Le retrait groupé n'existe pas : choisis un joueur");
    const users = Object.values(db.users);
    users.forEach(apply);
    save();
    return res.json({ ok: true, players: users.length, count });
  }
  const target = userByPid(String(req.body.pid || ""));
  if (!target) throw httpError(404, "Joueur introuvable");
  apply(target);
  save();
  res.json({ ok: true, player: target.name, bonusBoosters: target.bonusBoosters });
});

app.post("/api/admin/cards/bulk-delete", requireAdmin, (req, res) => {
  const ids = new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number));
  if (!ids.size) throw httpError(400, "Aucune carte sélectionnée");
  let n = 0;
  for (const c of db.cards) if (ids.has(c.id)) { removeFile("cards", c.image); n++; }
  db.cards = db.cards.filter((c) => !ids.has(c.id));
  for (const u of Object.values(db.users)) {
    for (const id of ids) delete u.collection[id];
    u.showcase = u.showcase.filter((x) => !ids.has(x));
  }
  save();
  res.json({ ok: true, deleted: n });
});

// ---------- Logo du site ----------
app.put("/api/admin/logo", requireAdmin, (req, res) => {
  const { buf, ext } = decodeImage(req.body.image, 1024 * 1024);
  const file = `logo-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, "logo", file), buf);
  if (db.logo) removeFile("logo", db.logo.file);
  db.logo = { file, v: Date.now() };
  save();
  res.json({ logo: logoUrl() });
});

app.delete("/api/admin/logo", requireAdmin, (req, res) => {
  if (db.logo) removeFile("logo", db.logo.file);
  db.logo = null;
  save();
  res.json({ logo: null });
});

// ---------- Fondateur : gestion des accès admin ----------
function requireFounder(req, res, next) {
  requireAuth(req, res, () => {
    if (!isFounder(req.user)) return res.status(403).json({ error: "Réservé au fondateur" });
    next();
  });
}

app.get("/api/founder/access", requireFounder, (req, res) => {
  const players = Object.values(db.users)
    .map((u) => ({ pid: u.pid, name: u.name, avatar: u.avatar || null, isFounder: isFounder(u), isAdmin: isAdmin(u) }))
    .sort((a, b) => b.isAdmin - a.isAdmin || a.name.localeCompare(b.name));
  res.json({ players });
});

app.put("/api/founder/access", requireFounder, (req, res) => {
  const target = userByPid(String(req.body.pid || ""));
  if (!target) throw httpError(404, "Joueur introuvable");
  if (isFounder(target)) throw httpError(400, "Le fondateur est toujours admin");
  const set = new Set(db.admins);
  if (req.body.admin === true) set.add(target.id);
  else set.delete(target.id);
  db.admins = [...set];
  save();
  res.json({ pid: target.pid, isAdmin: isAdmin(target) });
});

// ---------- Fondateur : sauvegardes ----------
const backupPath = (name) => {
  if (!BACKUP_RE.test(String(name)) || !listBackups().some((b) => b.name === name)) throw httpError(404, "Sauvegarde introuvable");
  return path.join(BACKUP_DIR, name);
};

app.get("/api/founder/backups", requireFounder, (req, res) => {
  res.json({
    backups: listBackups(),
    persistent: Boolean(process.env.DATA_FILE),
    dataFile: DATA_FILE,
    images: { mirrored: listFiles(MIRROR_DIR).length, live: listFiles(UPLOAD_DIR).length },
    offsite: { enabled: offsite.enabled, gapMin: Math.round(OFFSITE_GAP_MS / 60000), lastAt: offsite.lastAt || null, lastOk: offsite.lastOk, lastError: offsite.lastError, lastWithImages: offsite.lastWithImages },
    players: Object.keys(db.users).length,
    cards: db.cards.length,
  });
});

app.post("/api/founder/backups", requireFounder, (req, res) => {
  const name = makeBackup("manual");
  if (!name) throw httpError(500, "Sauvegarde impossible");
  res.json({ name });
});

app.post("/api/founder/offsite", requireFounder, async (req, res) => {
  if (!offsite.enabled) throw httpError(400, "BACKUP_WEBHOOK_URL n'est pas configurée");
  if (!(await sendOffsite("manuelle"))) throw httpError(502, "Envoi échoué : " + (offsite.lastError || "erreur inconnue"));
  res.json({ ok: true, withImages: offsite.lastWithImages });
});

app.get("/api/founder/backups/:name", requireFounder, (req, res) => {
  res.download(backupPath(req.params.name), req.params.name);
});

app.post("/api/founder/backups/restore", requireFounder, (req, res) => {
  const file = backupPath(String(req.body.name || ""));
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { throw httpError(400, "Sauvegarde illisible"); }
  if (!data || typeof data.users !== "object") throw httpError(400, "Sauvegarde invalide");
  makeBackup("pre-restore"); // on garde l'état actuel au cas où
  db = data;
  normalizeDb();
  save();
  res.json({ ok: true });
});

// Sauvegarde complète : données + toutes les images, dans un seul fichier à télécharger.
app.get("/api/founder/export", requireFounder, (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="douzieme-division-complet-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(buildFullExport(true));
});

app.post("/api/founder/import", requireFounder, express.json({ limit: "250mb" }), (req, res) => {
  const b = req.body || {};
  if (b.app === "douzieme-division" && b.kind === "images" && b.files && typeof b.files === "object") {
    // Lot d'images seul (fichier « images » envoyé sur Discord) : on remet les images en place, sans toucher aux données.
    let n = 0;
    for (const [rel, b64] of Object.entries(b.files)) {
      if (!SAFE_FILE.test(rel) || typeof b64 !== "string") continue;
      try { fs.writeFileSync(path.join(UPLOAD_DIR, rel), Buffer.from(b64, "base64")); n++; } catch (_) {}
    }
    syncMirror();
    return res.json({ ok: true, imagesOnly: true, images: n, players: Object.keys(db.users).length, cards: db.cards.length });
  }
  if (b.app !== "douzieme-division" || !b.db || typeof b.db.users !== "object" || !Array.isArray(b.db.cards)) {
    throw httpError(400, "Ce fichier n'est pas une sauvegarde complète valide");
  }
  makeBackup("pre-restore");
  let restored = 0;
  for (const [rel, b64] of Object.entries(b.files || {})) {
    if (!SAFE_FILE.test(rel) || typeof b64 !== "string") continue;
    try { fs.writeFileSync(path.join(UPLOAD_DIR, rel), Buffer.from(b64, "base64")); restored++; } catch (_) {}
  }
  db = b.db;
  normalizeDb();
  save();
  syncMirror();
  res.json({ ok: true, images: restored, players: Object.keys(db.users).length, cards: db.cards.length });
});

// ---------- Connexion Discord (OAuth2) ----------
app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/discord/callback`,
    response_type: "code",
    scope: "identify",
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Requête invalide");
  }
  req.session.oauthState = null;
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: `${BASE_URL}/auth/discord/callback`,
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error("Pas de token");

    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const me = await meRes.json();
    const id = "discord:" + me.id;
    const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null;
    const name = me.global_name || me.username;

    if (!db.users[id]) {
      createUser(id, name, avatar);
    } else {
      db.users[id].name = name;
      db.users[id].avatar = avatar;
    }
    save();
    req.session.userId = id;
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur pendant la connexion Discord");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---------- Erreurs ----------
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Image trop lourde" });
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.expose ? err.message : "Requête invalide" });
  }
  console.error(err);
  res.status(500).json({ error: "Erreur serveur" });
});

app.listen(PORT, () => {
  console.log(`Douzième Division lancé sur http://localhost:${PORT}`);
  console.log("Connexion Discord activée");
});
