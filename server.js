// ---- early diagnostics (optional) ----
process.on("uncaughtException", e => { console.error("UNCaught", e); process.exit(1); });
process.on("unhandledRejection", e => { console.error("UNhandled", e); process.exit(1); });
console.log("Booting server.js...");

// ---- imports ----
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "child_process";
import { nanoid } from "nanoid";
import { JSDOM } from "jsdom";
import mime from "mime-types";
import { Readability } from "@mozilla/readability";
import session from "express-session";

// Use a browser-like User-Agent for external fetches to avoid 403 errors
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

// If you're on Node < 18, polyfill fetch by uncommenting the next 3 lines and:
//   npm i node-fetch@3
// if (typeof fetch !== "function") {
//   global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
// }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// sessions
app.use(session({
  name: "myot.sid",
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: "lax" }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Auth required" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user?.is_admin) return res.status(403).json({ error: "Admin only" });
  next();
}

function parseVersion(v) { // "v3" or "v3.2"
  const m = /^v(\d+)(?:\.(\d+))?$/.exec(v || "v1");
  return { major: Number(m?.[1] || 1), minor: m?.[2] ? Number(m[2]) : null };
}
function versionToText(major, minor = null) {
  return minor == null ? `v${major}` : `v${major}.${minor}`;
}

// ---- dirs (ENV override; avoid iCloud by setting MYOT_DATA_DIR) ----
const DATA_DIR    = process.env.MYOT_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH     = path.join(DATA_DIR, "db.sqlite");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const TMP_DIR     = path.join(DATA_DIR, "tmp");

for (const d of [DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, TMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ---- sqlite ----
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  author_username TEXT,
  original_author_username TEXT,
  version_text TEXT,
  original_major INTEGER,
  parent_project_id TEXT,
  is_copy INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT,
  local_path TEXT,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

db.exec(`
UPDATE items
SET options_json='{}'
WHERE options_json IS NULL OR TRIM(options_json) = '';
UPDATE projects
SET options_json='{}'
WHERE options_json IS NULL OR TRIM(options_json) = '';
`);

// ---- NEW: users & versioning schema ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name  TEXT NOT NULL DEFAULT '',
  affiliation TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS version_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  action TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// Seed dev admin 'andrew' (password: P@ssword) if missing
const haveAndrew = db.prepare(`SELECT 1 FROM users WHERE username='andrew'`).get();
if (!haveAndrew) {
  db.prepare(`
    INSERT INTO users (username,password,first_name,last_name,affiliation,email,is_admin,created_at,updated_at)
    VALUES (@u,@p,@fn,@ln,@aff,@em,1,@now,@now)
  `).run({
    u: 'andrew',
    p: 'P@ssword',
    fn: 'Andrew',
    ln: '',
    aff: '',
    em: '',
    now: new Date().toISOString()
  });
}

// Seed version_log for projects missing entries
const projects = db.prepare('SELECT id, author_username, original_author_username, version_text, original_major FROM projects').all();
const hasLog = db.prepare('SELECT 1 FROM version_log WHERE project_id=? LIMIT 1');
for (const p of projects) {
  if (!hasLog.get(p.id)) {
    db.prepare(`INSERT INTO version_log (id,project_id,actor_username,action,from_version,to_version,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      nanoid(12), p.id, p.author_username || 'andrew', 'create', null, p.version_text || 'v1', new Date().toISOString()
    );
  }
}
const insertProject = db.prepare(`
  INSERT INTO projects (id,name,options_json,created_at,updated_at)
  VALUES (@id,@name,@options,@now,@now)
`);
const updateProject = db.prepare(`
  UPDATE projects SET name=@name, options_json=@options, updated_at=@now WHERE id=@id
`);
const getProject    = db.prepare(`SELECT * FROM projects WHERE id=?`);
const listProjects  = db.prepare(`SELECT id,name,options_json,created_at,updated_at,author_username FROM projects ORDER BY updated_at DESC`);
const deleteProject = db.prepare(`DELETE FROM projects WHERE id=?`);

const insertItem = db.prepare(`
  INSERT INTO items (id,project_id,position,type,title,source_url,local_path,options_json,created_at,updated_at)
  VALUES (@id,@project_id,@position,@type,@title,@source_url,@local_path,@options,@now,@now)
`);
const getItems            = db.prepare(`SELECT * FROM items WHERE project_id=? ORDER BY position ASC`);
const getItemById         = db.prepare(`SELECT * FROM items WHERE id=? AND project_id=?`);
const updateItemPositions = db.prepare(`UPDATE items SET position=? WHERE id=?`);
const deleteItem          = db.prepare(`DELETE FROM items WHERE id=?`);

const updateItemRow = db.prepare(`
  UPDATE items
  SET title=@title,
      type=@type,
      source_url=@source_url,
      options_json=@options_json,
      updated_at=@now
  WHERE id=@id AND project_id=@project_id
`);

// ---- uploads ----
// We will store file.filename in DB (just the name), not absolute file.path
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) { cb(null, UPLOADS_DIR); },
  filename: function (_req, file, cb) {
    const ext = mime.extension(file.mimetype) || path.extname(file.originalname).replace(".", "");
    cb(null, `${Date.now()}-${nanoid(6)}.${ext || "bin"}`);
  }
});
const upload = multer({ storage });

// ---- utils ----
const nowISO = () => new Date().toISOString();

// Diagnostic: log all image files and references before Pandoc
function logImageDiagnostics(workdir) {
  const imageFiles = fs.readdirSync(workdir).filter(f => /img-[a-zA-Z0-9]+\.(png|jpg|jpeg|gif)/.test(f));
  const mdFiles = fs.readdirSync(workdir).filter(f => f.endsWith('.md'));
  const imageRefs = [];
  for (const f of mdFiles) {
    const p = path.join(workdir, f);
    const txt = fs.readFileSync(p, 'utf8');
    // Markdown image refs
    const mdMatches = [...txt.matchAll(/!\[[^\]]*\]\((img-[a-zA-Z0-9]+\.(png|jpg|jpeg|gif))\)/g)];
    mdMatches.forEach(m => imageRefs.push(m[1]));
    // HTML image refs
    const htmlMatches = [...txt.matchAll(/<img[^>]*src=["'](img-[a-zA-Z0-9]+\.(png|jpg|jpeg|gif))["']/g)];
    htmlMatches.forEach(m => imageRefs.push(m[1]));
  }
  console.log("[DIAGNOSTIC] Image files in workspace:", imageFiles);
  console.log("[DIAGNOSTIC] Image references in markdown:", imageRefs);
  const missing = imageRefs.filter(ref => !imageFiles.includes(ref));
  if (missing.length) {
    console.warn("[DIAGNOSTIC] Missing image files for references:", missing);
  }
}

// Small helper must be defined before use in routes
function safeParseJSON(s, fallback = {}) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function setProgress(id, patch) {
  const cur = PROGRESS.get(id) || {};
  const next = { ...cur, ...patch };
  PROGRESS.set(id, next);
  return next;
}

const PROGRESS = new Map(); // id -> { step, total, message, done, error, output }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore","pipe","pipe"], ...opts });
    let out = "", err = "";
    child.stdout.on("data", d => (out += d.toString()));
    child.stderr.on("data", d => (err += d.toString()));
    child.on("close", code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(" ")}\n${err}`));
    });
  });
}

function runOk(cmd, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore","pipe","pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => (out += d.toString()));
    child.stderr.on("data", d => (err += d.toString()));
    child.on("close", code => {
      if (okCodes.includes(code)) resolve({ out, err, code });
      else reject(new Error(`${cmd} ${args.join(" ")}\n${err}`));
    });
  });
}

function isWikipedia(url) {
  try {
    const u = new URL(url);
    return /(^|\.)wikipedia\.org$/i.test(u.hostname) && /^\/wiki\//.test(u.pathname);
  } catch { return false; }
}

function wikipediaTitleFromUrl(url) {
  const u = new URL(url);
  const title = decodeURIComponent(u.pathname.replace(/^\/wiki\//, ""));
  const oldid = u.searchParams.get("oldid") || null;
  return { title, lang: u.hostname.split(".")[0] || "en", oldid };
}

function cleanWikipediaHtml(html) {
  html = html.replace(/[\u0000-\u001F\u007F-\u009F\uFDD0-\uFDEF\uFFF0-\uFFFF]/g, "");
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const selectors = [
    ".hatnote", ".shortdescription", ".ambox", ".mbox-small", ".messagebox",
    "#toc", ".toc",
    ".navbox", ".vertical-navbox", ".sidebar", ".metadata",
    ".sistersitebox", ".sisterproject", ".portal", ".dablink",
    ".mw-editsection", ".mw-empty-elt",
    "sup.reference"
  ];
  selectors.forEach(sel => doc.querySelectorAll(sel).forEach(n => n.remove()));
  doc.querySelectorAll("table").forEach(t => {
    const cls = (t.getAttribute("class") || "").toLowerCase();
    if (/(infobox|navbox|vertical-navbox|sidebar|metadata|ambox|mbox|tmbox|ombox|cmbox|fmbox)/.test(cls)) t.remove();
  });
  doc.querySelectorAll('[role="region"], [role="navigation"], [role="note"]').forEach(n => {
    const cls = (n.getAttribute("class") || "").toLowerCase();
    if (/infobox|navbox|sidebar|metadata/.test(cls)) n.remove();
  });
  doc.querySelectorAll("p").forEach(p => {
    if (!p.textContent.trim() && p.querySelectorAll("img,svg,video,table,ul,ol").length === 0) p.remove();
  });
  return doc.body.innerHTML;
}

function normalizeUrlMaybe(u) {
  if (!u) return u;
  try { new URL(u); return u; } catch {}
  if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(u)) return `https://${u}`;
  return `https://${u}`;
}

function whichExists(cmd) {
  try {
    const isWin = process.platform === "win32";
    const r = spawnSync(isWin ? "where" : "command", isWin ? [cmd] : ["-v", cmd], { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

function safeExtFromUrl(u, fallback = "bin") {
  try {
    const ext = path.extname(new URL(u).pathname).toLowerCase().replace(".", "");
    return ext || fallback;
  } catch { return fallback; }
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
      "Referer": "https://www.google.com/",
      "Upgrade-Insecure-Requests": "1"
    }
  });
  if (!res.ok) throw new Error(`Download failed ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(ab));
  return destPath;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
      "Referer": "https://www.google.com/",
      "Upgrade-Insecure-Requests": "1"
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}\n${txt.slice(0,512)}`);
  }
  const html = await res.text();
  return { html, headers: res.headers };
}

// Extract the main article content using Readability; fall back to cleaned <main/article/body>
function extractMainFromHtml(rawHtml, baseUrl = "") {
  const rough = rawHtml.replace(/<\/?(nav|aside|footer|header|iframe|noscript|template)[\s\S]*?>/gi, "");
  const dom = new JSDOM(rough, { url: baseUrl });
  const doc = dom.window.document;
  const junkSel = [
    "[role='navigation']","[role='complementary']","[role='banner']",
    ".sidebar",".side-bar",".widget",".ad",".ads",".advert",".share",".social",
    ".menu",".nav",".breadcrumbs",".cookie",".gdpr",".newsletter",".subscribe",
    ".pagination",".comments",".related",".recirc",".footer",".header",".hero"
  ].join(",");
  doc.querySelectorAll(junkSel).forEach(n => n.remove());
  const reader = new Readability(doc);
  const art = reader.parse();
  if (art && art.content) return { html: art.content, title: art.title || "", byline: art.byline || "" };
  const main = doc.querySelector("main, article") || doc.body;
  return { html: main?.innerHTML || "", title: doc.title || "", byline: "" };
}

// Static UI
app.use(express.static(path.join(__dirname, "public")));

async function fetchWikipediaHtmlByTitle(title, lang = "en") {
  const rest = `https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`;
  const res = await fetch(rest, { headers: { "User-Agent": USER_AGENT, "Accept": "text/html" }, redirect: "follow" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Wikipedia REST failed ${res.status} ${res.statusText}\n${txt.slice(0,512)}`);
  }
  const rawHtml = await res.text();
  const cleanedHtml = cleanWikipediaHtml(rawHtml);
  const etag = res.headers.get("etag");
  const rev = etag ? etag.replace(/W\/"?|"?/g, "").split("/")[0] : null;
  const canonical = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}` + (rev ? `?oldid=${rev}` : "");
  return { html: cleanedHtml, canonical, revision: rev };
}

function resolveLocalPath(p) {
  if (!p) return null;
  if (path.isAbsolute(p) && fs.existsSync(p)) return p; // legacy absolute path that still exists
  const base = path.basename(p);
  const candidate = path.join(UPLOADS_DIR, base);
  return fs.existsSync(candidate) ? candidate : null;
}

async function convertHtmlToMd(html, outPath, workdir) {
  const tempHtml = outPath.replace(/\.md$/, ".html");
  fs.writeFileSync(tempHtml, html, "utf8");
  await run("pandoc", [
    tempHtml, "-f", "html", "-t", "gfm",
    "--extract-media", workdir,
    "-o", outPath, "--wrap=none"
  ]);
  fs.unlinkSync(tempHtml);
}

function normalizeSvgUrl(u) {
  if (!u) return u;
  if (u.startsWith("//")) return "https:" + u;
  return u;
}

async function svgToPng(svgPath, outPngPath) {
  let magick = null;
  if (whichExists("magick")) magick = "magick";
  else if (whichExists("convert")) magick = "convert";
  if (!magick) return false;
  const args = magick === "magick" ? ["convert", svgPath, outPngPath] : [svgPath, outPngPath];
  try { await run(magick, args); return fs.existsSync(outPngPath); } catch { return false; }
}

async function maybeDownscaleImage(localPath, maxPx = 4000) {
  if (!whichExists("magick") && !whichExists("convert")) return false;
  const cmd = whichExists("magick") ? "magick" : "convert";
  const args = whichExists("magick")
    ? ["convert", localPath, "-resize", `${maxPx}x${maxPx}>`, localPath]
    : [localPath, "-resize", `${maxPx}x${maxPx}>`, localPath];
  try { await run(cmd, args); return true; } catch { return false; }
}

async function scrubMarkdownForPdf(mdPath, workdir) {
  let txt = fs.readFileSync(mdPath, "utf8");
  let hadSvg = false;
  const svgBlockRe = /<svg[\s\S]*?<\/svg>/gi;
  if (svgBlockRe.test(txt)) {
    hadSvg = true;
    txt = txt.replace(/^\s*\{=latex\}\s*$/gmi, "").replace(/^\s*\{=html\}\s*$/gmi, "");
  }
  const svgToLocalPngMd = async (orig, altText = "") => {
    try {
      let src = normalizeSvgUrl(orig);
      let svgPath;
      if (/^https?:\/\//i.test(src) || src.startsWith("//")) {
        const tmpSvg = path.join(workdir, `${nanoid(6)}.svg`);
        await downloadToFile(src, tmpSvg);
        svgPath = tmpSvg;
      } else {
        svgPath = path.isAbsolute(src) ? src : path.join(path.dirname(mdPath), src);
      }
      const tmpPng = path.join(workdir, `${nanoid(6)}.png`);
      const ok = await svgToPng(svgPath, tmpPng);
      if (ok) return `![${altText}](${path.basename(tmpPng)})`;
    } catch {}
    return altText ? `*${altText}*` : "";
  };
  const mdImgRe = /!\[([^\]]*)\]\(([^)]+?\.svg(?:\?[^)]*)?)\)/gi;
  const mdSubs = [];
  let m;
  while ((m = mdImgRe.exec(txt)) !== null) {
    hadSvg = true;
    const [, alt, url] = m;
    mdSubs.push({ from: m[0], to: await svgToLocalPngMd(url, alt) });
  }
  for (const {from,to} of mdSubs) txt = txt.split(from).join(to);
  const htmlImgRe = /<img\b([^>]*?)\bsrc\s*=\s*["']([^"']+?\.svg(?:\?[^"']*)?)["']([^>]*)>/gi;
  const htmlSubs = [];
  let h;
  while ((h = htmlImgRe.exec(txt)) !== null) {
    hadSvg = true;
    const full = h[0];
    const src  = h[2];
    const altMatch = /alt\s*=\s*["']([^"']*)["']/i.exec(full);
    const alt = altMatch ? altMatch[1] : "";
    htmlSubs.push({ from: full, to: await svgToLocalPngMd(src, alt) });
  }
  for (const {from,to} of htmlSubs) txt = txt.split(from).join(to);
  const refDefRe = /^\s*\(([^\]]+)\):\s*(\S+?\.svg(?:\S*)?)\s*$/gmi; // rarely used, kept for completeness
  if (refDefRe.test(txt)) hadSvg = true;
  fs.writeFileSync(mdPath, txt, "utf8");
  return { hadSvg };
}

async function convertUrlToMdSmart(inputUrl, outPath, wikipediaAttributionCollector, workdir) {
  if (isWikipedia(inputUrl)) {
    const { title, lang, oldid } = wikipediaTitleFromUrl(inputUrl);
    const { html, canonical, revision } = await fetchWikipediaHtmlByTitle(title, lang);
    await convertHtmlToMd(html, outPath, workdir);
    const finalUrl = oldid ? `${canonical.split("?")[0]}?oldid=${oldid}` : canonical;
    wikipediaAttributionCollector.push({ title: title.replace(/_/g, " "), url: finalUrl, revision: oldid || revision || null });
    return;
  }
  const url = normalizeUrlMaybe(inputUrl);
  const { html: raw } = await fetchHtml(url);
  const { html: mainHtml, title } = extractMainFromHtml(raw, url);
  const docHtml = `\n    <article>\n      ${title ? `<h1>${title}</h1>` : ""}\n      ${mainHtml}\n    </article>\n  `;
  await convertHtmlToMd(docHtml, outPath, workdir);
}

function ensureCss(workdir) {
  const css = `\nh1 { break-before: page; }\n.pagebreak { break-before: page; }\nbody { widows: 2; orphans: 2; }\n`;
  const cssPath = path.join(workdir, "epub.css");
  fs.writeFileSync(cssPath, css);
  return cssPath;
}

function metaYaml(workdir, { title, showPageNumbers }) {
  const lines = [
    `lang: "en"`,
    `toc: true`,
    `toc-depth: 3`,
  ];
  
  if (!showPageNumbers) {
    lines.push(`header-includes: |`);
    lines.push(`  \\pagenumbering{gobble}`);
  }
  
  const p = path.join(workdir, "meta.yaml");
  fs.writeFileSync(p, lines.join("\n"));
  return p;
}

function mdFile(workdir, name, content) {
  const p = path.join(workdir, name);
  fs.writeFileSync(p, content);
  return p;
}

function buildPandocArgs({ meta, workdir, cssPath, includeToc, format, engine, outPath, inputs }) {
  const args = ["--metadata-file", meta, "--resource-path", workdir, ...(includeToc ? ["--toc"] : [])];
  if (format === "pdf") {
    if (engine) args.push("--pdf-engine", engine);
    if (engine !== "wkhtmltopdf") args.push("-V", "geometry:margin=1in");
  } else {
    args.push("--css", cssPath);
  }
  args.push("-o", outPath, ...inputs);
  return args;
}

// ---- export pipeline (with engine preference, SVG scrub, and PROGRESS) ----
async function exportProjectTo(format, project, items, options = {}, progressCb = () => {}) {
  const failedPages = [];
  const wikipediaAttribution = [];
  const nonWikiAttribution = [];
  let sawAnySvg = false;

  // Output file base and path
  const outBase = `${project.id}-${Date.now()}`;
  const ext = format === "markdown" ? "md" : format;
  const outPath = path.join(EXPORTS_DIR, `${outBase}.${ext}`);

  function authorBanner(md, projectRow) {
    const u1 = db.prepare(`SELECT first_name,last_name,affiliation FROM users WHERE username=?`).get(projectRow.author_username || "andrew") || {};
    const uOrig = db.prepare(`SELECT first_name,last_name,affiliation FROM users WHERE username=?`).get(projectRow.original_author_username || projectRow.author_username || "andrew") || {};
    const a1 = `${u1.first_name||''} ${u1.last_name||''}`.trim();
    const aff1 = (u1.affiliation||'').trim();
    const aO = `${uOrig.first_name||''} ${uOrig.last_name||''}`.trim();
    const affO = (uOrig.affiliation||'').trim();
    const parts = [];
    parts.push(`**Reader collection assembled by ${a1 || (projectRow.author_username||'')}**${aff1 ? ` of ${aff1}` : ""}.`);
    if (projectRow.is_copy) parts.push(`Based on a previous version originally assembled by **${aO || (projectRow.original_author_username||'')}**${affO ? ` of ${affO}` : ""}.`);
    return [md, ...parts].join("\n\n");
  }

  const { showPageNumbers = true, includeToc = true } = options;
  const totalSteps = 4 + items.length + (format === "pdf" ? 1 : 0);
  let step = 0;
  const report = (message) => progressCb({ step: Math.min(++step, totalSteps), total: totalSteps, message });

  report("Preparing workspace");
  const workdir = fs.mkdtempSync(path.join(TMP_DIR, `build-${project.id}-`));
  const inputs = [];
  const pdfsToPrepend = [];
  const pdfsToAppend = [];

  // Check for title page - we'll generate it as a separate PDF and prepend it
  let titlePageItem = items.find(it => it.type === "titlepage");
  
  if (titlePageItem && format === "pdf") {
    const titlePageTitle = (titlePageItem.title || "Untitled").trim();
    const titlePageSubtitle = (titlePageItem.options?.subtitle || "").trim();
    report(`Generating Title Page: ${titlePageTitle}`);
    
    // Create a simple markdown file for the title page
    // Use raw LaTeX without YAML frontmatter to avoid Pandoc's default title formatting
    let titleMd = `---\n`;
    titleMd += `header-includes: |\n`;
    titleMd += `  \\thispagestyle{empty}\n`;
    titleMd += `  \\pagestyle{empty}\n`;
    titleMd += `---\n\n`;
    
    // Add vertical space to position content about 40% down the page
    titleMd += `\\vspace*{0.35\\textheight}\n\n`;
    titleMd += `\\begin{center}\n`;
    titleMd += `{\\Huge\\bfseries ${titlePageTitle.replace(/\\/g, '\\\\').replace(/\$/g, '\\$')}}`;
    
    if (titlePageSubtitle) {
      titleMd += `\\\\[1.5cm]\n`;
      titleMd += `{\\Large ${titlePageSubtitle.replace(/\\/g, '\\\\').replace(/\$/g, '\\$')}}`;
    }
    
    titleMd += `\n\\end{center}\n\n`;
    titleMd += `\\vspace*{\\fill}\n`;
    
    const titleMdPath = path.join(workdir, 'titlepage.md');
    fs.writeFileSync(titleMdPath, titleMd);
    
    // Generate title page PDF
    const titlePdfPath = path.join(workdir, 'titlepage.pdf');
    const titleArgs = ['--pdf-engine', 'tectonic', '-V', 'geometry:margin=1in', '-o', titlePdfPath, titleMdPath];
    try {
      await run("pandoc", titleArgs);
      pdfsToPrepend.push(titlePdfPath);
      report("Title page generated");
    } catch (e) {
      console.warn("Failed to generate title page:", e);
    }
  }

  const meta = metaYaml(workdir, { 
    title: project.name, 
    showPageNumbers
  });
  const cssPath = ensureCss(workdir);

  report("Collecting items");
  let isFirstItem = true;
  let lastWasHeading = false;
  for (const it of items) {
    const accessed = (it.created_at ? new Date(it.created_at) : new Date());
    const accessedDate = accessed.toISOString().split("T")[0];

    if (it.type === "titlepage") {
      // Already handled above
      isFirstItem = false;
      lastWasHeading = false;
      continue;
    }
    
    if (it.type === "heading") {
      // Add heading as a standalone item with page break before it (unless it's first)
      if (!isFirstItem) inputs.push(mdFile(workdir, `pagebreak-${nanoid(4)}.md`, `\\clearpage\n\n<div class="pagebreak"></div>\n`));
      const headingMd = `# ${it.title}\n\n`;
      inputs.push(mdFile(workdir, `heading-${it.id}.md`, headingMd));
      report(`Added Heading: ${it.title}`);
      isFirstItem = false;
      lastWasHeading = true;  // Mark that last item was a heading
      continue;
    }
    
    // Add page break before this item ONLY if it's not first and previous item wasn't a heading
    if (!isFirstItem && !lastWasHeading) {
      inputs.push(mdFile(workdir, `pagebreak-${nanoid(4)}.md`, `\\clearpage\n\n<div class="pagebreak"></div>\n`));
    }
    lastWasHeading = false;  // Reset flag

    let itemMd = "";

    if (it.type === "pdf") {
      const abs = resolveLocalPath(it.local_path);
      if (!abs) { console.warn(`Skipping missing PDF: ${it.local_path}`); report(`Skipped missing PDF`); isFirstItem = false; continue; }
      pdfsToAppend.push(abs);
      report(`Queued PDF: ${path.basename(abs)}`);
      isFirstItem = false;
      continue;
    }

    if (it.type === "docx") {
      const abs = resolveLocalPath(it.local_path);
      if (!abs) { console.warn(`Skipping missing DOCX: ${it.local_path}`); report(`Skipped missing DOCX`); isFirstItem = false; continue; }
      const out = path.join(workdir, `docx-${it.id}.md`);
      // Convert DOCX to Markdown using Pandoc
      async function convertDocxToMd(inputDocx, outputMd) {
        await run("pandoc", [inputDocx, "-f", "docx", "-t", "gfm", "-o", outputMd]);
      }
      await convertDocxToMd(abs, out);
      itemMd += `# ${it.title}\n\n` + fs.readFileSync(out, "utf8");
      const titled = mdFile(workdir, `docx-${it.id}-titled.md`, itemMd);
      const res = await scrubMarkdownForPdf(titled, workdir);
      if (res.hadSvg) sawAnySvg = true;
      inputs.push(titled);
      report(`Added DOCX: ${it.title}`);
      isFirstItem = false;
      continue;
    }

    if (it.type === "url" || it.type === "wikipedia") {
      const out = path.join(workdir, `url-${it.id}.md`);
      try {
        await convertUrlToMdSmart(it.source_url, out, wikipediaAttribution, workdir);
        itemMd += `# ${it.title}\n\n` + fs.readFileSync(out, "utf8");
        const titled = mdFile(workdir, `url-${it.id}-titled.md`, itemMd);
        const res = await scrubMarkdownForPdf(titled, workdir);
        if (res.hadSvg) sawAnySvg = true;
        inputs.push(titled);
        report(`Added URL: ${it.title}`);
        if (it.type === "url" && it.source_url && !isWikipedia(it.source_url)) {
          nonWikiAttribution.push({ kind: "web", title: it.title || "", url: it.source_url, accessed: accessedDate });
        }
      } catch (err) {
        failedPages.push({ title: it.title, url: it.source_url, error: err.message });
        report(`Skipped page (fetch error): ${it.title}`);
        isFirstItem = false;
        continue;
      }
      isFirstItem = false;
      continue;
    }
    if (it.type === "image") {
      let itemMd = "";
      let opts = {};
      if (typeof it.options_json === "string") {
        try { opts = JSON.parse(it.options_json); } catch { opts = {}; }
      } else if (typeof it.options_json === "object" && it.options_json !== null) {
        opts = it.options_json;
      } else if (typeof it.options === "object" && it.options !== null) {
        opts = it.options;
      }
      const caption = (typeof opts.caption === "string" ? opts.caption : "").trim();
      const widthPct = Math.min(100, Math.max(10, Number(opts.widthPct || 80)));
      let filename = `img-${it.id}`; let ext = null;
      if (it.local_path) {
        const abs = resolveLocalPath(it.local_path);
        if (!abs) { console.warn(`Skipping missing image: ${it.local_path}`); report(`Skipped missing image`); isFirstItem = false; continue; }
        ext = (path.extname(abs) || ".bin").toLowerCase();
        filename += ext;
        fs.copyFileSync(abs, path.join(workdir, filename));
      } else if (it.source_url) {
        ext = safeExtFromUrl(it.source_url, "jpg");
        filename += `.${ext}`;
        try {
          await downloadToFile(it.source_url, path.join(workdir, filename));
          await maybeDownscaleImage(path.join(workdir, filename));
          nonWikiAttribution.push({ kind: "image", title: it.title || "", url: it.source_url, accessed: accessedDate });
        } catch (err) {
          console.warn(`Failed to download image from ${it.source_url}:`, err.message);
          report(`Skipped image (download error): ${it.title}`);
          isFirstItem = false;
          continue;
        }
      }
      itemMd += `![${caption || it.title || "Image"}](${filename}){width=${widthPct}%}\n\n`;
      if (caption) itemMd += `*${caption}*\n\n`;
      const imgMd = mdFile(workdir, `image-${it.id}.md`, itemMd);
      inputs.push(imgMd);
      report(`Added image: ${it.title}`);
      isFirstItem = false;
      continue;
    }
  }
  
  // Attribution
  let creditsText = authorBanner("", project);
  if (wikipediaAttribution.length) {
    const a = [
      creditsText,
      "# Attribution",
      "",
      "This document includes content from Wikipedia, available under the Creative Commons Attribution-ShareAlike License (CC BY-SA).",
      "",
      ...wikipediaAttribution.map(e => `- **${e.title}** — ${e.url}${e.revision ? ` (rev ${e.revision})` : ""} (accessed ${new Date().toISOString().split("T")[0]})`),
      ""
    ].join("\n");
    const attr = mdFile(workdir, "attribution.md", a);
    const res = await scrubMarkdownForPdf(attr, workdir);
    if (res.hadSvg) sawAnySvg = true;
    inputs.push(attr);
    report("Added attribution");
  }
  if (nonWikiAttribution.length) {
    const s = [
      creditsText,
      "# Sources",
      "",
      ...nonWikiAttribution.map(e => {
        const label = e.kind === "image" ? "(image)" : "(web)";
        const title = (e.title || "").trim() || "(Untitled)";
        return `- **${title}** — ${e.url} ${label} (accessed ${e.accessed})`;
      }),
      ""
    ].join("\n");
    const src = mdFile(workdir, "sources.md", s);
    const res = await scrubMarkdownForPdf(src, workdir);
    if (res.hadSvg) sawAnySvg = true;
    inputs.push(src);
    report("Added sources");
  }

  let engines = [];
  if (format === "pdf") {
    const haveTe = whichExists("tectonic");
    const haveXe = whichExists("xelatex");
    if (haveTe) engines.push("tectonic");
    if (haveXe) engines.push("xelatex");
    if (!engines.length) throw new Error("No PDF engine detected. Install tectonic or xelatex.");
  }

  function fixAbsoluteImagePaths(workdir) {
    const mdFiles = fs.readdirSync(workdir).filter(f => f.endsWith('.md'));
    for (const f of mdFiles) {
      const p = path.join(workdir, f);
      let txt = fs.readFileSync(p, 'utf8');
      txt = txt.replace(/!\[([^\]]*)\]\((\/[^)]+\/(img-[a-zA-Z0-9]+\.(?:png|jpg|jpeg|gif|svg)))\)/g, (m, alt, _abs, fname) => `![${alt}](${fname})`);
      txt = txt.replace(/(<img[^>]*src=)["'](\/['\w\/-]+\/(img-[a-zA-Z0-9]+\.(?:png|jpg|jpeg|gif|svg)))["']/g, (_m, pre, _abs, fname) => `${pre}"${fname}"`);
      fs.writeFileSync(p, txt, 'utf8');
    }
  }

  async function tryPandoc(engineOrNull) {
    fixAbsoluteImagePaths(workdir);
    logImageDiagnostics(workdir);
    report(`Rendering ${format.toUpperCase()} with ${engineOrNull || "default"} engine`);
    const args = buildPandocArgs({ meta, workdir, cssPath, includeToc, format, engine: engineOrNull, outPath, inputs });
    return run("pandoc", args);
  }

  if (format === "markdown") {
    // For markdown export, just concatenate all the markdown files
    report("Combining markdown files");
    let combined = "";
    
    // Add title if there's a title page
    if (titlePageItem) {
      combined += `# ${titlePageItem.title}\n\n`;
      if (titlePageItem.options?.subtitle) {
        combined += `## ${titlePageItem.options.subtitle}\n\n`;
      }
      combined += `---\n\n`;
    }
    
    // Concatenate all input files
    for (const inputFile of inputs) {
      const content = fs.readFileSync(inputFile, 'utf8');
      combined += content + "\n\n";
    }
    
    fs.writeFileSync(outPath, combined, 'utf8');
    report("Markdown export complete");
  } else if (format !== "pdf") {
    await tryPandoc(null);
    report("Pandoc render complete");
  } else {
    let lastErr = null;
    for (const eng of engines) {
      try { await tryPandoc(eng); lastErr = null; break; } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    report("Pandoc render complete");
  }

  if (format === "pdf" && (pdfsToPrepend.length || pdfsToAppend.length)) {
    const allPdfs = [...pdfsToPrepend, outPath, ...pdfsToAppend];
    if (pdfsToPrepend.length) {
      report("Prepending title page");
    }
    if (pdfsToAppend.length) {
      report("Appending PDFs");
    }
    
    const merged = path.join(EXPORTS_DIR, `${outBase}-merged.pdf`);
    if (whichExists("qpdf")) {
      await runOk("qpdf", ["--warning-exit-0", "--empty", "--pages", ...allPdfs, "--", merged], [0,2,3]);
      fs.renameSync(merged, outPath);
    } else if (whichExists("pdfunite")) {
      await run("pdfunite", allPdfs.concat(merged));
      fs.renameSync(merged, outPath);
    } else if (whichExists("gs")) {
      await run("gs", ["-dBATCH","-dNOPAUSE","-sDEVICE=pdfwrite", `-sOutputFile=${merged}`, ...allPdfs]);
      fs.renameSync(merged, outPath);
    } else {
      console.warn("No PDF merger (qpdf/pdfunite/gs) found; skipping PDF prepend/append/merge.");
    }
  }

  report("Done");
  return outPath;
}

// ---- routes ----
app.get("/api/projects", (_req, res) => {
  const rows = listProjects.all();
  res.json(rows.map(r => ({ ...r, options: safeParseJSON(r.options_json, {}) })));
});

app.post("/api/projects", (req, res) => {
  const id = nanoid(10);
  const name = (req.body.name || "Untitled Project").trim();
  const options = req.body.options || { showPageNumbers: true, includeToc: true };
  const actor = req.session.user?.username || "andrew";
  insertProject.run({ id, name, options: JSON.stringify(options || {}), now: nowISO() });
  db.prepare(`UPDATE projects SET author_username=?, original_author_username=?, version_text=?, original_major=?, is_copy=0 WHERE id=?`)
    .run(actor, actor, 'v1', 1, id);
  db.prepare(`INSERT INTO version_log (id,project_id,actor_username,action,from_version,to_version,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(nanoid(12), id, actor, 'create', null, 'v1', nowISO());
  res.json({ id, name, options, author_username: actor, version_text: 'v1' });
});

app.get("/api/projects/:id", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const items = getItems.all(p.id);
  res.json({
    id: p.id,
    name: p.name,
    options: safeParseJSON(p.options_json, {}),
    items: items.map(i => ({ ...i, options: safeParseJSON(i.options_json, {}) })),
    parent_project_id: p.parent_project_id || null,
    author_username: p.author_username,
    original_author_username: p.original_author_username,
    version_text: p.version_text,
    created_at: p.created_at,
    updated_at: p.updated_at
  });
});

app.put("/api/projects/:id", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Not found" });
  const actor = req.session.user?.username || p.author_username || "andrew";
  const name = (req.body.name ?? p.name).trim();
  const options = req.body.options ?? safeParseJSON(p.options_json, {});
  const cur = parseVersion(p.version_text || 'v1');
  const isOriginalAuthor = actor === (p.original_author_username || p.author_username);
  let next;
  if (isOriginalAuthor) {
    next = versionToText(cur.major + 1, null);
    db.prepare(`UPDATE projects SET original_major=? WHERE id=?`).run(cur.major + 1, p.id);
  } else {
    const baseMajor = p.original_major || cur.major;
    const minor = cur.minor == null ? 1 : (cur.minor + 1);
    next = versionToText(baseMajor, minor);
  }
  updateProject.run({ id: p.id, name, options: JSON.stringify(options || {}), now: nowISO() });
  db.prepare(`UPDATE projects SET author_username=?, version_text=?, updated_at=? WHERE id=?`).run(actor, next, nowISO(), p.id);
  db.prepare(`INSERT INTO version_log (id,project_id,actor_username,action,from_version,to_version,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(nanoid(12), p.id, actor, 'save', p.version_text, next, nowISO());
  res.json({ ok: true, version: next });
});

app.get("/api/projects/:id/version-log", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  
  // Get version log entries for this project
  let versionLogs = db.prepare(`
    SELECT id, project_id, actor_username, action, from_version, to_version, created_at
    FROM version_log 
    WHERE project_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id);
  
  // If this is a copy project, we need to include the original creator's entry
  if (p.is_copy && p.parent_project_id) {
    // Get the original creation entry from the parent project
    const originalCreationEntry = db.prepare(`
      SELECT id, project_id, actor_username, action, from_version, to_version, created_at
      FROM version_log 
      WHERE project_id = ? AND action = 'create'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(p.parent_project_id);
    
    if (originalCreationEntry) {
      // Add the original creation entry at the beginning (oldest)
      versionLogs.unshift(originalCreationEntry);
    }
  }
  
  // Return in reverse chronological order (newest first) for display
  res.json(versionLogs.reverse());
});

app.post("/api/projects/:id/copy", requireAuth, (req, res) => {
  const originalProject = getProject.get(req.params.id);
  if (!originalProject) return res.status(404).json({ error: "Project not found" });
  
  const actor = req.session.user.username;
  const copyId = nanoid(10);
  const now = nowISO();
  
  // Parse original version to determine copy version
  const originalVersion = parseVersion(originalProject.version_text || 'v1');
  const copyVersion = versionToText(originalVersion.major, 1); // e.g., v3 becomes v3.1
  
  try {
    // Create the copy project
    insertProject.run({
      id: copyId,
      name: `${originalProject.name} (Copy)`,
      options: originalProject.options_json,
      now
    });
    
    // Set copy metadata
    db.prepare(`
      UPDATE projects 
      SET author_username=?, original_author_username=?, version_text=?, 
          original_major=?, parent_project_id=?, is_copy=1 
      WHERE id=?
    `).run(
      actor,
      originalProject.original_author_username || originalProject.author_username || "andrew",
      copyVersion,
      originalVersion.major, // This preserves the major version being copied from
      req.params.id,
      copyId
    );
    
    // Copy all items from original project
    const originalItems = getItems.all(req.params.id);
    for (const item of originalItems) {
      insertItem.run({
        id: nanoid(10),
        project_id: copyId,
        position: item.position,
        type: item.type,
        title: item.title,
        source_url: item.source_url,
        local_path: item.local_path,
        options: item.options_json,
        now
      });
    }
    
    // Log copy action in original project's version log
    db.prepare(`
      INSERT INTO version_log (id,project_id,actor_username,action,from_version,to_version,created_at) 
      VALUES (?,?,?,?,?,?,?)
    `).run(
      nanoid(12),
      req.params.id, // Original project ID
      actor,
      'copy',
      originalProject.version_text,
      copyVersion,
      now
    );
    
    // Log creation action in copy project's version log
    db.prepare(`
      INSERT INTO version_log (id,project_id,actor_username,action,from_version,to_version,created_at) 
      VALUES (?,?,?,?,?,?,?)
    `).run(
      nanoid(12),
      copyId, // Copy project ID
      actor,
      'copy',
      originalProject.version_text,
      copyVersion,
      now
    );
    
    res.json({ 
      id: copyId, 
      name: `${originalProject.name} (Copy)`,
      version_text: copyVersion,
      author_username: actor
    });
    
  } catch (error) {
    console.error("Error creating copy:", error);
    res.status(500).json({ error: "Failed to create copy" });
  }
});

app.delete("/api/projects/:id", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  
  // Check if user has permission to delete this project
  const currentUser = req.session.user;
  const isAdmin = currentUser?.is_admin;
  const isOwner = currentUser?.username === p.author_username;
  
  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: "Permission denied. Only project owners or admins can delete projects." });
  }
  
  try {
    // Delete the project (CASCADE will automatically delete associated items)
    const result = deleteProject.run(req.params.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    
    // Log the deletion
    const actor = currentUser?.username || "unknown";
    db.prepare(`INSERT INTO version_log (id,project_id,actor_username,action,from_version,to_version,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(nanoid(12), req.params.id, actor, 'delete', p.version_text, 'deleted', nowISO());
    
    res.json({ ok: true, message: "Project deleted successfully" });
  } catch (error) {
    console.error("Error deleting project:", error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// ---- Auth & Profile ----
app.get("/api/me", (req, res) => {
  const u = req.session.user;
  res.json(u ? { username: u.username, is_admin: !!u.is_admin, first_name: u.first_name, last_name: u.last_name, affiliation: u.affiliation, email: u.email } : null);
});

app.post("/api/auth/login", express.json(), (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare(`SELECT * FROM users WHERE username=?`).get(username || "");
  if (!u || password !== u.password) return res.status(401).json({ error: "Invalid credentials" });
  req.session.user = { username: u.username, is_admin: !!u.is_admin, first_name: u.first_name, last_name: u.last_name, affiliation: u.affiliation, email: u.email };
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get("/api/profile", requireAuth, (req, res) => {
  const u = db.prepare(`SELECT username,first_name,last_name,affiliation,email,is_admin FROM users WHERE username=?`).get(req.session.user.username);
  res.json(u);
});

app.put("/api/profile", requireAuth, (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const current = db.prepare("SELECT first_name, last_name, affiliation FROM users WHERE username=?").get(user.username);
  const { first_name, last_name, affiliation } = req.body || {};
  db.prepare("UPDATE users SET first_name=?, last_name=?, affiliation=? WHERE username=?")
    .run((first_name ?? current.first_name), (last_name ?? current.last_name), (affiliation ?? current.affiliation), user.username);
  res.json({ success: true });
});

// Create item (url, wikipedia, heading, image)
app.post("/api/projects/:id/items", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const items = getItems.all(p.id);
  const position = items.length ? (items[items.length - 1].position + 1) : 1;
  const id = nanoid(10);
  const type = (req.body.type || "").toLowerCase();
  let title = (req.body.title || "").trim() || (type === "heading" ? "Chapter" : "Untitled");
  let source_url = null;
  let initOptions = (req.body.options && typeof req.body.options === "object") ? req.body.options : {};
  if (type === "titlepage") {
    title = req.body.title?.trim() || "";
    // Subtitle is already in initOptions from req.body.options
    if (!initOptions.subtitle) {
      initOptions.subtitle = "";
    }
    // source_url stays null
  } else if (["url", "wikipedia"].includes(type)) {
    const rawUrl = req.body.url || null;
    source_url = rawUrl ? normalizeUrlMaybe(rawUrl.trim()) : null;
  }
  if (!["url","wikipedia","heading","image","titlepage"].includes(type)) return res.status(400).json({ error: "Invalid type" });
  insertItem.run({ id, project_id: p.id, position, type, title, source_url, local_path: null, options: JSON.stringify(initOptions), now: nowISO() });
  res.json({ id, type, title, source_url, position });
});

// Upload item (docx, pdf, image) — store only filename in DB
app.post("/api/projects/:id/items/upload", upload.single("file"), (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file" });
  const mimetype = file.mimetype;
  let type = null;
  if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") type = "docx";
  else if (mimetype === "application/pdf") type = "pdf";
  else if (mimetype.startsWith("image/")) type = "image";
  else return res.status(400).json({ error: "Only DOCX, PDF, or image files supported" });
  const title = (req.body.title || path.parse(file.originalname).name).trim();
  const items = getItems.all(p.id);
  const position = items.length ? (items[items.length - 1].position + 1) : 1;
  const id = nanoid(10);
  let initOptions = {};
  if (typeof req.body.options === "string") initOptions = safeParseJSON(req.body.options, {});
  else if (req.body.options && typeof req.body.options === "object") initOptions = req.body.options;
  insertItem.run({ id, project_id: p.id, position, type, title, source_url: null, local_path: file.filename, options: JSON.stringify(initOptions), now: nowISO() });
  res.json({ id, type, title, position, filename: file.filename });
});

// Reorder items in a project
app.put("/api/projects/:id/items/reorder", (req, res) => {
  const order = req.body.order; // [{id, position}, ...]
  if (!Array.isArray(order)) return res.status(400).json({ error: "Bad payload" });
  const tx = db.transaction((rows) => {
    rows.forEach(r => updateItemPositions.run(r.position, r.id));
  });
  tx(order);
  res.json({ ok: true });
});

// Delete item in a project
app.delete("/api/projects/:id/items/:itemId", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const itemId = req.params.itemId;
  const item = getItemById.get(itemId, p.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  deleteItem.run(itemId);
  res.json({ ok: true });
});

// SSE stream of progress
app.get("/api/progress/:id", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const id = req.params.id;
  const send = () => {
    const st = PROGRESS.get(id) || { step: 0, total: 1, message: "Starting..." };
    res.write(`data: ${JSON.stringify(st)}\n\n`);
    if (st.done || st.error) clearInterval(t);
  };
  const t = setInterval(send, 300);
  send();
  req.on("close", () => clearInterval(t));
});

// Optional helper to download by path (tokenize in prod)
app.get("/api/download", (req, res) => {
  const file = req.query.path;
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.download(file, path.basename(file));
});

app.post("/api/projects/:id/export", async (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const rawItems = getItems.all(p.id);
  // Parse options JSON for each item
  const items = rawItems.map(i => ({ ...i, options: safeParseJSON(i.options_json, {}) }));
  const format = req.body.format; // 'pdf' | 'epub'
  const options = req.body || {};
  const jobId = nanoid(12);
  setProgress(jobId, { step: 0, total: 1, message: "Starting export...", done: false });
  res.json({ jobId });
  // Run export in background
  (async () => {
    try {
      const outPath = await exportProjectTo(format, p, items, options, (progress) => {
        setProgress(jobId, { ...progress, done: false });
      });
      setProgress(jobId, { step: 1, total: 1, message: "Done", done: true, output: outPath });
    } catch (err) {
      setProgress(jobId, { step: 1, total: 1, message: "Error", done: true, error: err.message });
    }
  })();
});

// ---- listen ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MYOTextbook listening on http://localhost:${PORT}\nDATA_DIR: ${DATA_DIR}\nUPLOADS_DIR: ${UPLOADS_DIR}\nEXPORTS_DIR: ${EXPORTS_DIR}\nTMP_DIR: ${TMP_DIR}`);
});