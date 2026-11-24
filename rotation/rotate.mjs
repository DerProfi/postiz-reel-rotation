// Reel-Rotation für Postiz
// Plant Reels aus ./reels in festen Slots als Instagram Trial Reels ein und
// rotiert dabei durch Caption-Varianten (Original + von Claude erzeugte Varianten).
//
// Start:   node rotate.mjs             (Dauerbetrieb, prüft alle CHECK_INTERVAL_MINUTES)
//          node rotate.mjs --once      (ein Durchlauf)
//          node rotate.mjs --dry-run   (nichts einplanen, nur anzeigen; Varianten werden trotzdem erzeugt)
//          node rotate.mjs --post-now  (nächstes Reel sofort als Trial Reel posten, dann beenden;
//                                       mit --reel=Name ein bestimmtes Reel)
//          node rotate.mjs --replan    (künftige Slots in Postiz löschen und neu einplanen, dann beenden)
//
// Hardlinks: Ist UPLOADS_DIR gesetzt, ersetzt die Rotation die Upload-Kopie in Postiz durch einen
// Hardlink auf das Reel (spart den doppelten Platz). Dafür müssen reels/ und uploads/ im selben
// Docker-Mount liegen (Hardlinks gehen nicht über Mount-Grenzen) und die Rotation braucht
// Schreibrechte in uploads/ (gehört root). FILE_OWNER="uid:gid" gibt eigene Dateien an diesen User zurück.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

const REELS_DIR = process.env.REELS_DIR || path.join(here, "reels");
const VARIANTS_DIR = process.env.VARIANTS_DIR || path.join(here, "variants");
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const UPLOADS_DIR = process.env.UPLOADS_DIR || "";
// Instagram (Graph API) verlangt max. 1920 px Breite, ≤ 25 Mbit/s und lädt das Video selbst von
// unserem Server. 4K-Reels mit 60 Mbit/s scheitern dort mit „Video download failed“.
// Deshalb wird vor dem Upload eine Fassung in IG_DIR gerechnet; die Originale bleiben unangetastet.
const IG_DIR = process.env.IG_DIR || path.join(REELS_DIR, ".instagram");
const TRANSCODE = process.env.TRANSCODE !== "false";
const IG_PROFILE = "ig1080-10M"; // ändern, wenn sich die ffmpeg-Parameter ändern → alles wird neu gerechnet
const [OWNER_UID, OWNER_GID] = (process.env.FILE_OWNER || "").split(":").map((n) => (n === "" ? NaN : Number(n)));

const API = (process.env.POSTIZ_API_URL || "http://postiz:5000/api/public/v1").replace(/\/$/, "");
const API_KEY = process.env.POSTIZ_API_KEY || "";
const INTEGRATION_ID = process.env.INSTAGRAM_INTEGRATION_ID || "";

const SLOTS = (process.env.SLOTS || "12:00,18:00").split(",").map((s) => s.trim()).filter(Boolean);
const TZ = process.env.TIMEZONE || "Europe/Berlin";
const LOOKAHEAD_HOURS = Number(process.env.LOOKAHEAD_HOURS || 36);
const MIN_LEAD_MINUTES = Number(process.env.MIN_LEAD_MINUTES || 20);
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES || 10);
const GRADUATION_STRATEGY = process.env.GRADUATION_STRATEGY || "MANUAL";
const CAPTION_VARIANTS = Number(process.env.CAPTION_VARIANTS || 4);
// Original-Caption mitrotieren? Standard: ja (für neue Videos gedacht). Lief ein Reel schon mit
// dem Original auf deinem Account, auf "false" setzen: Instagram stuft dieselbe Caption sonst als „zu ähnlich“ ein.
const USE_ORIGINAL_CAPTION = process.env.USE_ORIGINAL_CAPTION !== "false";

const DRY_RUN = process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");
const POST_NOW = process.argv.includes("--post-now");
const REPLAN = process.argv.includes("--replan");
const ONCE = process.argv.includes("--once") || DRY_RUN;

const VIDEO_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime" };

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---------- Zeitzonen / Slots ----------

function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz); // zweiter Durchlauf für Sommer-/Winterzeit-Grenzen
  return new Date(utc);
}

function localYmd(date, tz) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date).split("-").map(Number);
  return { y, m, d };
}

function upcomingSlots(now) {
  const { y, m, d } = localYmd(now, TZ);
  const earliest = now.getTime() + MIN_LEAD_MINUTES * 60_000;
  const latest = now.getTime() + LOOKAHEAD_HOURS * 3_600_000;
  const out = new Map();
  for (let off = 0; off <= Math.ceil(LOOKAHEAD_HOURS / 24) + 1; off++) {
    const day = new Date(Date.UTC(y, m - 1, d + off));
    for (const slot of SLOTS) {
      const [hh, mm] = slot.split(":").map(Number);
      const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm || 0, TZ);
      if (t.getTime() > earliest && t.getTime() <= latest) out.set(t.toISOString(), t);
    }
  }
  return [...out.values()].sort((a, b) => a - b);
}

const fmtLocal = (date) =>
  new Intl.DateTimeFormat("de-DE", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(date);

// ---------- Dateien ----------

// Läuft die Rotation als root, gehören neue Dateien sonst root und sind per SSH nicht mehr editierbar.
function giveBack(p) {
  if (process.getuid?.() !== 0 || Number.isNaN(OWNER_UID)) return;
  try { fs.chownSync(p, OWNER_UID, Number.isNaN(OWNER_GID) ? OWNER_UID : OWNER_GID); } catch {}
}

function writeOwned(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  giveBack(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content);
  giveBack(tmp);
  fs.renameSync(tmp, file);
}

// ---------- State ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function loadState() {
  const s = readJson(STATE_FILE) || {};
  s.slots ||= {};
  s.reels ||= {};
  s.media ||= {};
  return s;
}

function saveState(state) {
  const cutoff = Date.now() - 30 * 24 * 3_600_000;
  for (const iso of Object.keys(state.slots)) if (Date.parse(iso) < cutoff) delete state.slots[iso];
  writeOwned(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Reels & Captions ----------

async function listReels() {
  const files = await fsp.readdir(REELS_DIR).catch(() => []);
  const reels = [];
  for (const file of files.sort()) {
    const ext = path.extname(file).toLowerCase();
    if (!VIDEO_TYPES[ext]) continue;
    const base = file.slice(0, -ext.length);
    const txt = path.join(REELS_DIR, base + ".txt");
    const caption = fs.existsSync(txt) ? fs.readFileSync(txt, "utf8").trim() : "";
    if (!caption) {
      log(`WARN ${file}: keine Caption (${base}.txt fehlt oder ist leer) – wird übersprungen`);
      continue;
    }
    reels.push({ file, base, ext, full: path.join(REELS_DIR, file), caption });
  }
  return reels;
}

const VARIANT_SYSTEM = `Du schreibst Varianten von Instagram-Reel-Captions für A/B-Tests mit Trial Reels.

Regeln für jede Variante:
- Gleiche Sprache, gleiche Kernaussage und gleiche Fakten wie das Original. Erfinde nichts dazu (keine neuen Zahlen, Versprechen, Links oder @-Handles).
- Variiere spürbar: vor allem die erste Zeile (Hook), dazu Satzbau, Reihenfolge und Call-to-Action. Die Varianten sollen sich auch untereinander deutlich unterscheiden.
- Behalte Tonalität, Stil und Emoji-Dichte des Originals bei.
- Hashtags: übernimm die Hashtags des Originals (Reihenfolge darf sich ändern), füge keine neuen hinzu. Hat das Original keine, verwende keine.
- Höchstens 2200 Zeichen pro Variante. Zeilenumbrüche sind erlaubt.`;

async function generateVariants(caption) {
  const response = await anthropic.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { variants: { type: "array", items: { type: "string" } } },
          required: ["variants"],
          additionalProperties: false,
        },
      },
    },
    system: VARIANT_SYSTEM,
    messages: [{
      role: "user",
      content: `Original-Caption:\n<caption>\n${caption}\n</caption>\n\nSchreibe genau ${CAPTION_VARIANTS} Varianten.`,
    }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude hat die Anfrage abgelehnt (refusal)");
  if (response.stop_reason === "max_tokens") throw new Error("Antwort abgeschnitten (max_tokens)");

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.variants)) throw new Error("Unerwartetes Antwortformat");

  const seen = new Set([caption.trim()]);
  const out = [];
  for (const v of parsed.variants) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t.length > 2200 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, CAPTION_VARIANTS);
}

// Liefert [Original, ...Varianten]. Die Datei variants/<reel>.json darf von Hand bearbeitet werden;
// ohne "source_hash" wird sie nie überschrieben.
async function getCaptions(reel) {
  const file = path.join(VARIANTS_DIR, reel.base + ".json");
  const hash = sha(reel.caption);
  const existing = readJson(file);
  if (existing && Array.isArray(existing.captions) && (!existing.source_hash || existing.source_hash === hash)) {
    const caps = existing.captions.filter((c) => typeof c === "string" && c.trim());
    if (caps.length) return caps;
  }
  if (!anthropic || CAPTION_VARIANTS <= 0) return [reel.caption];

  let variants;
  try {
    variants = await generateVariants(reel.caption);
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? ` (HTTP ${err.status})` : "";
    log(`WARN ${reel.file}: Caption-Varianten konnten nicht erzeugt werden${status}: ${err.message} – nutze nur das Original`);
    return [reel.caption];
  }
  const captions = [reel.caption, ...variants];
  writeOwned(file, JSON.stringify({
    hinweis: "captions[0] ist das Original. Du kannst Einträge ändern/löschen. Entfernst du source_hash, wird die Datei nie automatisch neu erzeugt.",
    source_hash: hash,
    generated_at: new Date().toISOString(),
    captions,
  }, null, 2));
  log(`${reel.file}: ${variants.length} Caption-Varianten erzeugt → variants/${reel.base}.json`);
  return captions;
}

// ---------- Postiz API ----------

async function api(method, p, body, isForm = false) {
  const headers = { Authorization: API_KEY };
  if (body && !isForm) headers["Content-Type"] = "application/json";
  const res = await fetch(API + p, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const detail = typeof json === "string" ? json : JSON.stringify(json);
    throw new Error(`Postiz ${method} ${p} → HTTP ${res.status}: ${String(detail).slice(0, 400)}`);
  }
  return json;
}

async function getIntegrationId() {
  if (INTEGRATION_ID) return INTEGRATION_ID;
  const res = await api("GET", "/integrations");
  const list = Array.isArray(res) ? res : res?.integrations || [];
  const ig = list.filter((i) => i.identifier === "instagram" && !i.disabled);
  if (!ig.length) throw new Error("Kein aktiver Instagram-Kanal (Facebook Business) in Postiz gefunden");
  if (ig.length > 1) log(`WARN mehrere Instagram-Kanäle gefunden, nutze "${ig[0].name}" – setze INSTAGRAM_INTEGRATION_ID zum Festlegen`);
  return ig[0].id;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`))));
  });
}

// Liefert den Pfad der Datei, die zu Postiz hochgeladen wird (Instagram-Fassung oder Original).
async function prepareVideo(reel) {
  if (!TRANSCODE) return reel.full;
  const out = path.join(IG_DIR, reel.base + ".mp4");
  const src = fs.statSync(reel.full);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src.mtimeMs) return out;

  fs.mkdirSync(IG_DIR, { recursive: true });
  giveBack(IG_DIR);
  const tmp = out + ".tmp.mp4";
  const t0 = Date.now();
  log(`${reel.file}: rechne Instagram-Fassung (1080p, 10 Mbit/s) …`);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", reel.full,
    "-map", "0:v:0", "-map", "0:a:0?",
    // Hochformat → 1080 breit, Querformat → 1920 breit; nie hochskalieren.
    "-vf", "scale=w=if(gte(ih\\,iw)\\,min(1080\\,iw)\\,min(1920\\,iw)):h=-2",
    "-fpsmax", "60",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-b:v", "10M", "-maxrate", "12M", "-bufsize", "24M",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart", tmp,
  ]);
  giveBack(tmp);
  fs.renameSync(tmp, out);
  log(`${reel.file}: Instagram-Fassung fertig (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s)`);
  return out;
}

async function ensureMedia(reel, state) {
  const stat = fs.statSync(reel.full);
  const profile = TRANSCODE ? IG_PROFILE : "original";
  const cached = state.media[reel.file];
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && (cached.profile || "original") === profile) return cached;

  const file = await prepareVideo(reel);
  const up = fs.statSync(file);
  log(`${reel.file}: lade Video zu Postiz hoch (${(up.size / 1e6).toFixed(1)} MB) …`);
  const form = new FormData();
  form.append("file", await fs.openAsBlob(file, { type: "video/mp4" }), reel.base + ".mp4");
  const media = await api("POST", "/upload", form, true);
  if (!media?.id || !media?.path) throw new Error(`Upload-Antwort ohne id/path: ${JSON.stringify(media).slice(0, 200)}`);
  state.media[reel.file] = {
    id: media.id, path: media.path, size: stat.size, mtimeMs: stat.mtimeMs,
    profile, local: path.relative(REELS_DIR, file),
  };
  saveState(state);
  await linkUpload(reel.file, state);
  return state.media[reel.file];
}

// ---------- Hardlinks uploads/ → reels/ ----------

function uploadFileFor(mediaPath) {
  let p = mediaPath;
  try { p = new URL(mediaPath).pathname; } catch {}
  const i = p.indexOf("/uploads/");
  if (i < 0) return null;
  const rel = decodeURIComponent(p.slice(i + "/uploads/".length));
  const full = path.resolve(UPLOADS_DIR, rel);
  return full.startsWith(path.resolve(UPLOADS_DIR) + path.sep) ? full : null;
}

async function filesEqual(a, b) {
  const [ha, hb] = await Promise.all([fsp.open(a), fsp.open(b)]);
  try {
    const size = 1 << 20;
    const ba = Buffer.alloc(size), bb = Buffer.alloc(size);
    for (let pos = 0; ; pos += size) {
      const [ra, rb] = await Promise.all([ha.read(ba, 0, size, pos), hb.read(bb, 0, size, pos)]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await Promise.all([ha.close(), hb.close()]);
  }
}

// Ersetzt die Upload-Kopie eines Reels durch einen Hardlink auf die hochgeladene Datei
// (reels/.instagram/<name>.mp4 oder bei alten Einträgen das Original reels/<file>).
// Gibt die gesparten Bytes zurück. Fehler werden nur geloggt, die Rotation läuft weiter.
async function linkUpload(file, state) {
  if (!UPLOADS_DIR) return 0;
  const media = state.media[file];
  if (!media || media.linkSkipped) return 0;
  const src = path.join(REELS_DIR, media.local || file);
  const dst = uploadFileFor(media.path);
  try {
    if (!dst) throw new Error(`unerwarteter Upload-Pfad ${media.path}`);
    const [s, d] = [fs.statSync(src), fs.statSync(dst)];
    if (s.ino === d.ino && s.dev === d.dev) return 0;
    if (s.size !== d.size || !(await filesEqual(src, dst))) {
      log(`WARN ${file}: Upload-Datei weicht vom Reel ab – kein Hardlink`);
      media.linkSkipped = true;
      saveState(state);
      return 0;
    }
    const tmp = `${dst}.link-${process.pid}`;
    fs.linkSync(src, tmp);
    fs.renameSync(tmp, dst); // atomar: Postiz sieht nie eine fehlende Datei
    log(`${file}: Upload-Kopie durch Hardlink ersetzt (${(d.size / 1e6).toFixed(1)} MB gespart)`);
    return d.size;
  } catch (err) {
    log(`WARN ${file}: Hardlink nicht möglich: ${err.message}`);
    return 0;
  }
}

async function linkAllUploads(state) {
  if (!UPLOADS_DIR) return;
  for (const [file, media] of Object.entries(state.media)) {
    if (fs.existsSync(path.join(REELS_DIR, media.local || file))) await linkUpload(file, state);
  }
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toPostizHtml = (caption) => caption.split(/\r?\n/).map((l) => `<p>${escapeHtml(l)}</p>`).join("");

// ---------- Rotation ----------

function pickReel(reels, state) {
  // Das Reel, das am längsten nicht dran war (nie gepostete zuerst), bei Gleichstand alphabetisch.
  return [...reels].sort((a, b) => {
    const la = state.reels[a.file]?.lastSlot || "";
    const lb = state.reels[b.file]?.lastSlot || "";
    return la.localeCompare(lb) || a.file.localeCompare(b.file);
  })[0];
}

async function tick() {
  if (!API_KEY) {
    log("POSTIZ_API_KEY fehlt in der .env – nichts zu tun");
    return;
  }
  const state = loadState();
  const open = upcomingSlots(new Date()).filter((t) => !state.slots[t.toISOString()]);
  if (!open.length) return;

  const reels = await listReels();
  if (!reels.length) {
    log(`Keine Reels mit Caption in ${REELS_DIR} – ${open.length} Slot(s) bleiben frei`);
    return;
  }
  const integrationId = await getIntegrationId();

  for (const slot of open) {
    await postReel(pickReel(reels, state), slot, state, integrationId, "schedule");
  }
}

// type "schedule": zum Slot einplanen. type "now": sofort veröffentlichen (Slot = jetzt).
async function postReel(reel, slot, state, integrationId, type) {
  const iso = slot.toISOString();
  const all = await getCaptions(reel);
  // captions[0] ist das Original; ohne Varianten bleibt nur das Original übrig.
  const offset = !USE_ORIGINAL_CAPTION && all.length > 1 ? 1 : 0;
  if (offset === 0 && !USE_ORIGINAL_CAPTION) log(`WARN ${reel.file}: keine Caption-Varianten vorhanden – nutze das Original`);
  const captions = all.slice(offset);
  const stats = (state.reels[reel.file] ||= { count: 0 });
  const idx = offset + (stats.count % captions.length);
  const caption = all[idx];
  const label = `${type === "now" ? "sofort" : fmtLocal(slot)}: ${reel.file}, ${idx === 0 ? "Original" : `Variante ${idx}/${all.length - 1}`}`;

  if (DRY_RUN) {
    log(`[DRY-RUN] würde ${type === "now" ? "posten" : "einplanen"} → ${label}\n----\n${caption}\n----`);
    stats.count++;
    stats.lastSlot = iso;
    return;
  }

  const media = await ensureMedia(reel, state);
  const result = await api("POST", "/posts", {
    type,
    date: iso,
    shortLink: false,
    tags: [],
    posts: [{
      integration: { id: integrationId },
      value: [{ content: toPostizHtml(caption), image: [{ id: media.id, path: media.path }] }],
      settings: { post_type: "post", is_trial_reel: true, graduation_strategy: GRADUATION_STRATEGY },
    }],
  });

  stats.count++;
  stats.lastSlot = iso;
  if (type === "schedule") {
    state.slots[iso] = { reel: reel.file, captionIndex: idx, createdAt: new Date().toISOString(), postiz: result };
  } else {
    (state.manual ||= []).push({ at: iso, reel: reel.file, captionIndex: idx, postiz: result });
  }
  saveState(state);
  log(`${type === "now" ? "gepostet" : "eingeplant"} → ${label}`);
}

// Löscht alle künftigen, von der Rotation eingeplanten Posts in Postiz und plant die Slots neu
// (z. B. nachdem sich das Upload-Format geändert hat).
async function replan() {
  if (!API_KEY) throw new Error("POSTIZ_API_KEY fehlt in der .env");
  const state = loadState();
  const now = Date.now();
  for (const [iso, slot] of Object.entries(state.slots)) {
    if (Date.parse(iso) <= now) continue;
    for (const p of slot.postiz || []) {
      if (p?.postId) await api("DELETE", `/posts/${p.postId}`);
    }
    delete state.slots[iso];
    const stats = state.reels[slot.reel];
    if (stats) {
      stats.count = Math.max(0, stats.count - 1);
      const prev = Object.entries(state.slots).filter(([, s]) => s.reel === slot.reel).map(([i]) => i).sort().pop();
      if (prev) stats.lastSlot = prev; else delete stats.lastSlot;
    }
    log(`gelöscht → ${fmtLocal(new Date(iso))}: ${slot.reel}`);
  }
  saveState(state);
  await tick();
}

async function postNow() {
  if (!API_KEY) throw new Error("POSTIZ_API_KEY fehlt in der .env");
  const state = loadState();
  const reels = await listReels();
  if (!reels.length) throw new Error(`Keine Reels mit Caption in ${REELS_DIR}`);
  // Reels, die schon in einem kommenden Slot stehen, nicht doppelt nehmen.
  const planned = new Set(Object.entries(state.slots).filter(([iso]) => Date.parse(iso) > Date.now()).map(([, s]) => s.reel));
  const pool = reels.filter((r) => !planned.has(r.file));
  const wanted = process.argv.find((a) => a.startsWith("--reel="))?.slice("--reel=".length);
  const reel = wanted ? reels.find((r) => r.file === wanted || r.base === wanted) : pickReel(pool.length ? pool : reels, state);
  if (!reel) throw new Error(`Reel "${wanted}" nicht gefunden (oder ohne Caption)`);
  await postReel(reel, new Date(), state, await getIntegrationId(), "now");
}

async function main() {
  log(`Reel-Rotation gestartet: Slots ${SLOTS.join(", ")} (${TZ}), Vorlauf ${LOOKAHEAD_HOURS} h, ` +
      `Trial Reels (${GRADUATION_STRATEGY}), Caption-Varianten: ${anthropic ? CAPTION_VARIANTS : "aus (kein ANTHROPIC_API_KEY)"}` +
      (DRY_RUN ? ", DRY-RUN" : "") + (UPLOADS_DIR ? ", Hardlinks an" : ""));
  if (POST_NOW || REPLAN) {
    try {
      await (REPLAN ? replan() : postNow());
    } catch (err) {
      log(`FEHLER: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    await linkAllUploads(loadState());
  } catch (err) {
    log(`WARN Hardlink-Durchlauf: ${err.message}`);
  }
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`FEHLER: ${err.message}`);
    }
    if (ONCE) break;
    await sleep(CHECK_INTERVAL_MINUTES * 60_000);
  }
}

main();
