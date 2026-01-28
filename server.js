// ---- early diagnostics with monitoring ----
console.log("Booting server.js...");

// Handle uncaught exceptions with monitoring
process.on("uncaughtException", async (e) => { 
  console.error("UNCAUGHT EXCEPTION:", e);
  try {
    // Try to send alert before exiting
    const send = async () => {
      if (typeof sendMonitoringAlert === 'function') {
        await sendMonitoringAlert(
          'Uncaught Exception - Server Crashed',
          `The server crashed due to an uncaught exception:\n\n${e.stack || e.message}`,
          'critical'
        );
      }
    };
    await Promise.race([send(), new Promise(resolve => setTimeout(resolve, 3000))]);
  } catch (alertErr) {
    console.error("Failed to send crash alert:", alertErr);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (e) => { 
  console.error("UNHANDLED REJECTION:", e);
  try {
    const send = async () => {
      if (typeof sendMonitoringAlert === 'function') {
        await sendMonitoringAlert(
          'Unhandled Promise Rejection',
          `Unhandled promise rejection:\n\n${e?.stack || e}`,
          'error'
        );
      }
    };
    await Promise.race([send(), new Promise(resolve => setTimeout(resolve, 3000))]);
  } catch (alertErr) {
    console.error("Failed to send rejection alert:", alertErr);
  }
  process.exit(1);
});

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
import FormData from "form-data";
import Mailgun from "mailgun.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

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

// Trust proxy - required for nginx/Cloudflare SSL
app.set('trust proxy', 1);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// sessions
app.use(session({
  name: "myot.sid",
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    sameSite: "lax" 
  }
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

// Clean up old temp directories on startup (older than 24 hours)
try {
  const tempDirs = fs.readdirSync(TMP_DIR);
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  let cleanedCount = 0;
  
  for (const dir of tempDirs) {
    if (!dir.startsWith('build-') && !dir.startsWith('cache-')) continue;
    const dirPath = path.join(TMP_DIR, dir);
    try {
      const stats = fs.statSync(dirPath);
      if (stats.isDirectory() && stats.mtimeMs < oneDayAgo) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        cleanedCount++;
      }
    } catch (err) {
      // Skip if can't stat or remove
    }
  }
  if (cleanedCount > 0) {
    console.log(`✓ Cleaned up ${cleanedCount} old temp directories`);
  }
} catch (err) {
  console.warn('⚠ Failed to cleanup temp directories:', err.message);
}

// ---- sqlite ----
const db = new Database(DB_PATH);
// Using DELETE mode instead of WAL to reduce I/O pressure in VM environment
db.pragma("journal_mode = DELETE");
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
  cached_content TEXT,
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

// Add cached_content column if it doesn't exist (migration)
const hasColumn = db.prepare(`PRAGMA table_info(items)`).all().some(col => col.name === 'cached_content');
if (!hasColumn) {
  console.log('Adding cached_content column to items table...');
  db.exec(`ALTER TABLE items ADD COLUMN cached_content TEXT`);
}

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

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  affiliation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
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
  INSERT INTO items (id,project_id,position,type,title,source_url,local_path,options_json,cached_content,created_at,updated_at)
  VALUES (@id,@project_id,@position,@type,@title,@source_url,@local_path,@options,@cached_content,@now,@now)
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

// ---- Mailgun configuration ----
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || 'mg.myotext.org';
const FROM_EMAIL = 'MYOText Admin <admin@mg.myotext.org>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'avarsanyi2@nebraska.edu';

let mgClient = null;
if (MAILGUN_API_KEY && MAILGUN_DOMAIN) {
  const mailgun = new Mailgun(FormData);
  mgClient = mailgun.client({
    username: 'api',
    key: MAILGUN_API_KEY
  });
  console.log('✓ Mailgun configured for monitoring alerts');
} else {
  console.warn('⚠ Mailgun not configured - monitoring alerts will be logged only');
}

// Alert tracking to prevent spam
const alertCache = new Map(); // key -> timestamp of last alert
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour between same alerts

async function sendMonitoringAlert(subject, message, severity = 'warning') {
  const cacheKey = `${severity}:${subject}`;
  const lastAlert = alertCache.get(cacheKey);
  
  // Rate limit: don't send same alert within cooldown period
  if (lastAlert && (Date.now() - lastAlert) < ALERT_COOLDOWN) {
    console.log(`[ALERT SUPPRESSED] ${subject} (sent ${Math.round((Date.now() - lastAlert) / 60000)} min ago)`);
    return;
  }
  
  const timestamp = new Date().toISOString();
  const fullMessage = `[${severity.toUpperCase()}] ${timestamp}\n\n${message}\n\nServer: ${process.env.HOSTNAME || 'MYOText Instance'}\nPID: ${process.pid}`;
  
  console.error(`[MONITORING ALERT] ${subject}\n${fullMessage}`);
  
  alertCache.set(cacheKey, Date.now());
  
  if (mgClient) {
    try {
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `[MYOText ${severity.toUpperCase()}] ${subject}`,
        text: fullMessage
      });
      console.log(`✓ Alert email sent to ${ADMIN_EMAIL}`);
    } catch (err) {
      console.error('Failed to send alert email:', err.message);
    }
  }
}

async function sendEmail({ to, subject, text, html }) {
  if (!mgClient) {
    console.warn('Mailgun not configured. Email would be sent to:', to);
    console.log('Subject:', subject);
    console.log('Text:', text);
    return { success: false, error: 'Mailgun not configured' };
  }
  
  try {
    const messageData = {
      from: FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject: subject
    };
    
    if (text) messageData.text = text;
    if (html) messageData.html = html;
    
    const result = await mgClient.messages.create(MAILGUN_DOMAIN, messageData);
    console.log('Email sent successfully:', result.id);
    return { success: true, id: result.id };
  } catch (err) {
    console.error('Failed to send email:', err);
    return { success: false, error: err.message };
  }
}

function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

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

// Try to find a PDF engine in PATH or common locations
function findPdfEngine(engineName) {
  // First try standard PATH lookup
  if (whichExists(engineName)) {
    return engineName;
  }
  
  // Common installation paths for macOS, Linux, and Windows
  const commonPaths = {
    'tectonic': [
      '/usr/local/bin/tectonic',
      '/opt/homebrew/bin/tectonic',
      '/usr/bin/tectonic',
      '~/.cargo/bin/tectonic',
      process.env.HOME + '/.cargo/bin/tectonic'
    ],
    'xelatex': [
      '/usr/local/bin/xelatex',
      '/opt/homebrew/bin/xelatex',
      '/usr/bin/xelatex',
      '/Library/TeX/texbin/xelatex',
      '/usr/local/texlive/2023/bin/x86_64-linux/xelatex',
      '/usr/local/texlive/2024/bin/x86_64-linux/xelatex',
      '/usr/local/texlive/2023/bin/universal-darwin/xelatex',
      '/usr/local/texlive/2024/bin/universal-darwin/xelatex'
    ]
  };
  
  const paths = commonPaths[engineName] || [];
  for (const p of paths) {
    try {
      const expandedPath = p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p;
      if (fs.existsSync(expandedPath)) {
        // Verify it's executable
        try {
          fs.accessSync(expandedPath, fs.constants.X_OK);
          return expandedPath;
        } catch {
          // Not executable, continue searching
        }
      }
    } catch {
      // Path doesn't exist, continue
    }
  }
  
  return null;
}

// Try to find a PDF merger tool in PATH or common locations
function findPdfMerger() {
  // Common installation paths for PDF merger tools
  const tools = {
    'qpdf': [
      '/usr/bin/qpdf',
      '/usr/local/bin/qpdf',
      '/opt/homebrew/bin/qpdf'
    ],
    'pdfunite': [
      '/usr/bin/pdfunite',
      '/usr/local/bin/pdfunite',
      '/opt/homebrew/bin/pdfunite'
    ],
    'gs': [
      '/usr/bin/gs',
      '/usr/local/bin/gs',
      '/opt/homebrew/bin/gs'
    ]
  };
  
  for (const [tool, paths] of Object.entries(tools)) {
    // First try PATH
    if (whichExists(tool)) {
      return { tool, path: tool };
    }
    
    // Then try common locations
    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          // Verify it's executable
          try {
            fs.accessSync(p, fs.constants.X_OK);
            return { tool, path: p };
          } catch {
            // Not executable, continue
          }
        }
      } catch {
        // Path doesn't exist, continue
      }
    }
  }
  
  return null;
}

// Count pages in PDF file
async function countPdfPages(pdfPath) {
  try {
    // Try using pdfinfo first (part of poppler-utils)
    if (whichExists("pdfinfo")) {
      const result = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8", timeout: 10000 });
      if (result.status === 0 && result.stdout) {
        const match = result.stdout.match(/Pages:\s*(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
    }
    
    // Fallback to qpdf if available
    if (whichExists("qpdf")) {
      const result = spawnSync("qpdf", ["--show-npages", pdfPath], { encoding: "utf8", timeout: 10000 });
      if (result.status === 0 && result.stdout) {
        const pages = parseInt(result.stdout.trim(), 10);
        if (!isNaN(pages)) return pages;
      }
    }
    
    // If no tools available, return null
    return null;
  } catch (err) {
    console.warn(`Failed to count PDF pages for ${pdfPath}:`, err.message);
    return null;
  }
}

// Count pages in DOCX file by converting to PDF temporarily
async function countDocxPages(docxPath) {
  try {
    // We'll use pandoc to convert to PDF and then count pages
    if (!whichExists("pandoc")) return null;
    
    const tempDir = path.join(__dirname, 'data', 'tmp');
    const tempPdf = path.join(tempDir, `temp-${nanoid()}.pdf`);
    
    try {
      // Convert DOCX to PDF using pandoc with timeout
      const result = spawnSync("pandoc", [docxPath, "-o", tempPdf], { 
        encoding: "utf8", 
        timeout: 30000 // 30 second timeout for conversion
      });
      if (result.status === 0 && fs.existsSync(tempPdf)) {
        const pageCount = await countPdfPages(tempPdf);
        fs.unlinkSync(tempPdf); // Clean up
        return pageCount;
      }
    } catch (err) {
      // Clean up temp file if it exists
      if (fs.existsSync(tempPdf)) {
        fs.unlinkSync(tempPdf);
      }
      throw err;
    }
    
    return null;
  } catch (err) {
    console.warn(`Failed to count DOCX pages for ${docxPath}:`, err.message);
    return null;
  }
}

// Extract text from PDF file
async function extractPdfText(pdfPath) {
  try {
    // Try using pdftotext with different approaches
    if (whichExists("pdftotext")) {
      // First try: Simple text extraction (often more complete)
      let result = spawnSync("pdftotext", ["-raw", pdfPath, "-"], { 
        encoding: "utf8", 
        timeout: 45000,
        maxBuffer: 20 * 1024 * 1024 // 20MB buffer for large documents
      });
      
      if (result.status === 0 && result.stdout) {
        let text = result.stdout.trim();
        if (text.length > 50) {
          return cleanExtractedText(text);
        }
      }
      
      // Second try: Layout-preserved extraction if raw didn't work well
      result = spawnSync("pdftotext", ["-layout", "-nopgbrk", pdfPath, "-"], { 
        encoding: "utf8", 
        timeout: 45000,
        maxBuffer: 20 * 1024 * 1024
      });
      
      if (result.status === 0 && result.stdout) {
        let text = result.stdout.trim();
        if (text.length > 50) {
          return cleanExtractedText(text);
        }
      }
      
      // Third try: Specify encoding explicitly (sometimes helps)
      result = spawnSync("pdftotext", ["-enc", "UTF-8", "-raw", pdfPath, "-"], { 
        encoding: "utf8", 
        timeout: 45000,
        maxBuffer: 20 * 1024 * 1024
      });
      
      if (result.status === 0 && result.stdout) {
        let text = result.stdout.trim();
        if (text.length > 50) {
          return cleanExtractedText(text);
        }
      }
    }
    
    // Fallback to Pandoc (often works well with PDFs)
    if (whichExists("pandoc")) {
      const result = spawnSync("pandoc", [pdfPath, "-t", "plain"], { 
        encoding: "utf8", 
        timeout: 45000,
        maxBuffer: 20 * 1024 * 1024
      });
      if (result.status === 0 && result.stdout) {
        return cleanExtractedText(result.stdout.trim());
      }
    }
    
    // If no tools can extract text, return null
    return null;
  } catch (err) {
    console.warn(`Failed to extract PDF text from ${pdfPath}:`, err.message);
    return null;
  }
}

// Clean up extracted PDF text
function cleanExtractedText(text) {
  if (!text) return null;
  
  // First remove invalid XML characters that can break EPUB/XML formats
  // Remove control characters except tab (9), newline (10), and carriage return (13)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  
  // Remove or replace other problematic characters
  text = text
    .replace(/[\uFFF0-\uFFFF]/g, '') // Remove specials block
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // Remove additional control chars
    .replace(/\uFEFF/g, '') // Remove BOM (Byte Order Mark)
    .replace(/[\u200B-\u200D\uFEFF]/g, ''); // Remove zero-width spaces and similar
  
  // Now normalize line endings and basic cleanup
  let cleaned = text
    .replace(/\f/g, '\n\n--- Page Break ---\n\n') // Mark page breaks clearly
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\r/g, '\n') // Handle old Mac line endings
    .replace(/\s+\n/g, '\n') // Remove trailing spaces before newlines
    .replace(/^\s+/gm, '') // Remove leading whitespace from each line
    .trim();
  
  // Now handle paragraph flow - join lines that are part of the same paragraph
  // Split into potential paragraphs (double newlines or more)
  const paragraphs = cleaned.split(/\n\s*\n+/);
  
  const processedParagraphs = paragraphs.map(paragraph => {
    // Skip page break markers
    if (paragraph.includes('--- Page Break ---')) {
      return paragraph;
    }
    
    // For each paragraph, join lines that don't end with sentence-ending punctuation
    const lines = paragraph.split('\n').filter(line => line.trim());
    
    if (lines.length <= 1) return paragraph;
    
    let result = [];
    let currentSentence = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Add space if we're continuing a sentence
      if (currentSentence && !currentSentence.endsWith(' ')) {
        currentSentence += ' ';
      }
      currentSentence += line;
      
      // Check if this line likely ends a sentence or paragraph
      const endsWithPunctuation = /[.!?:]\s*$/.test(line);
      const nextLineStartsNewSentence = i === lines.length - 1 || 
        (lines[i + 1] && /^[A-Z]/.test(lines[i + 1].trim()));
      
      if (endsWithPunctuation || nextLineStartsNewSentence || i === lines.length - 1) {
        result.push(currentSentence);
        currentSentence = '';
      }
    }
    
    // Add any remaining content
    if (currentSentence.trim()) {
      result.push(currentSentence);
    }
    
    return result.join(' ');
  });
  
  // Join paragraphs with double newlines and limit excessive spacing
  let result = processedParagraphs
    .join('\n\n')
    .replace(/\n{4,}/g, '\n\n\n') // Limit consecutive newlines to max 3
    .trim();
  
  // Final safety check - ensure only valid UTF-8 characters remain
  // Replace any remaining invalid characters with spaces
  result = result.replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, ' ');
  
  // Clean up any double spaces created by the replacement
  result = result.replace(/ +/g, ' ');
    
  return result;
}

// Check if PDF contains extractable text (not just scanned images)
async function pdfHasExtractableText(pdfPath) {
  try {
    const text = await extractPdfText(pdfPath);
    if (!text) return false;
    
    // More lenient check - just need some meaningful content
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const meaningfulContent = cleanText.replace(/[^\w\.,;:!?\-'"()]/g, '');
    
    // Lower threshold and check for variety of characters
    if (meaningfulContent.length < 15) return false;
    
    const uniqueChars = new Set(cleanText.toLowerCase().replace(/\s/g, ''));
    return uniqueChars.size > 4; // At least 5 different characters
  } catch (err) {
    return false;
  }
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
  // Try multiple User-Agents if first attempt fails
  const userAgents = [
    USER_AGENT, // Chrome on Mac
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", // Chrome on Windows
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", // Chrome on Linux
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" // Safari
  ];
  
  let lastError = null;
  
  for (let i = 0; i < userAgents.length; i++) {
    const ua = userAgents[i];
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "DNT": "1",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Cache-Control": "max-age=0"
        }
      });
      
      const html = await res.text();
      
      // Check if we got a Cloudflare challenge page
      if (html.includes("Just a moment") || html.includes("cf-browser-verification") || html.includes("challenge-platform")) {
        console.warn(`⚠ Cloudflare/bot protection detected on ${url} (attempt ${i+1}/${userAgents.length})`);
        if (i < userAgents.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
          continue;
        }
        throw new Error(`Site requires browser verification (Cloudflare protection). Cannot fetch: ${url}`);
      }
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      
      return { html, headers: res.headers };
    } catch (err) {
      lastError = err;
      if (i < userAgents.length - 1) {
        console.warn(`⚠ Attempt ${i+1} failed: ${err.message}, trying different User-Agent...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  
  throw new Error(`Fetch failed for ${url} after ${userAgents.length} attempts: ${lastError.message}`);
}

// Post-process Readability output to remove common artifacts
function postProcessReadabilityContent(html) {
  try {
    if (!html || typeof html !== 'string') return html;
    
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    // Remove elements with common artifact patterns
    const artifactSelectors = [
      // Navigation and menus
      "[class*='nav']", "[class*='menu']", "[class*='breadcrumb']",
      "[id*='nav']", "[id*='menu']",
      // Social and sharing
      "[class*='share']", "[class*='social']", "[id*='share']",
      // Related content
      "[class*='related']", "[class*='recommend']", "[class*='more-from']",
      "[class*='editor-pick']", "[class*='trending']", "[class*='popular']",
      "[class*='latest']", "[class*='read-next']",
      // Ads and promos
      "[class*='ad-']", "[class*='advertisement']", "[class*='promo']",
      // Tags and metadata
      "[class*='tag']", "[class*='category']", "[class*='topics']",
      // Footers and attribution blocks
      "[class*='footer']", "[class*='site-footer']",
      // Comments
      "[class*='comment']", "[id*='comment']",
      // Newsletter and subscription
      "[class*='newsletter']", "[class*='subscribe']", "[class*='signup']"
    ];
    
    artifactSelectors.forEach(selector => {
      try {
        doc.querySelectorAll(selector).forEach(el => el.remove());
      } catch (e) {
        // Skip invalid selectors
      }
    });
    
    // Remove elements containing common artifact phrases
    const artifactPhrases = [
      /more from/i, /latest from/i, /editor'?s picks?/i, /trending/i,
      /related articles?/i, /read more/i, /continue reading/i,
      /sign up/i, /newsletter/i, /subscribe/i,
      /share this/i, /follow us/i,
      /topics:?/i, /tags:?/i, /categories:?/i,
      /filed under/i, /posted in/i,
      /copyright/i, /all rights reserved/i,
      /attributions?\.?$/i, /sources?\.?$/i
    ];
    
    // Check all text nodes and their parent elements
    const allElements = doc.querySelectorAll('p, div, section, aside, footer, header, h2, h3, h4, h5, h6');
    allElements.forEach(el => {
      const text = el.textContent.trim();
      // Only remove if it's a short element (likely a heading or label)
      if (text.length < 100) {
        for (const phrase of artifactPhrases) {
          if (phrase.test(text)) {
            el.remove();
            break;
          }
        }
      }
    });
    
    // Remove lists that look like navigation or metadata
    doc.querySelectorAll('ul, ol').forEach(list => {
      const items = list.querySelectorAll('li');
      if (items.length > 0 && items.length < 10) {
        // Check if all items are very short (likely navigation)
        const allShort = Array.from(items).every(li => li.textContent.trim().length < 50);
        if (allShort) {
          list.remove();
        }
      }
    });
    
    return doc.body.innerHTML;
  } catch (error) {
    console.error('Error in postProcessReadabilityContent:', error.message);
    // Return original HTML if processing fails
    return html;
  }
}

// Extract the main article content using Readability; fall back to cleaned <main/article/body>
function extractMainFromHtml(rawHtml, baseUrl = "") {
  const rough = rawHtml.replace(/<\/?(nav|aside|footer|header|iframe|noscript|template)[\s\S]*?>/gi, "");
  const dom = new JSDOM(rough, { url: baseUrl });
  const doc = dom.window.document;
  
  // Expanded junk selector list for better cleanup
  const junkSel = [
    "[role='navigation']","[role='complementary']","[role='banner']","[role='contentinfo']",
    ".sidebar",".side-bar",".widget",".ad",".ads",".advert",".advertisement",
    ".share",".social",".social-share",".share-buttons",".social-media",
    ".menu",".nav",".navigation",".breadcrumbs",".breadcrumb",
    ".cookie",".gdpr",".newsletter",".subscribe",".subscription",
    ".pagination",".comments",".comment",".related",".recirc",".recommendations",
    ".footer",".header",".hero",".masthead",
    ".promo",".sponsored",".outbrain",".taboola",
    ".attribution",".byline-block",".author-info",
    ".tags",".tag-list",".categories",
    ".more-from",".read-more",".continue-reading",
    ".editor-picks",".editor-choice",".trending",
    ".latest",".popular",".most-read",
    "script","style","link[rel='stylesheet']","meta"
  ].join(",");
  doc.querySelectorAll(junkSel).forEach(n => n.remove());
  
  // Try Readability first (clone to preserve original doc)
  const readerDoc = doc.cloneNode(true);
  const reader = new Readability(readerDoc, {
    charThreshold: 100, // Lower threshold to capture shorter articles
    keepClasses: false
  });
  const art = reader.parse();
  
  if (art && art.content && art.content.trim().length > 100) {
    console.log(`✓ Readability extracted ${art.content.length} chars from ${baseUrl}`);
    // Post-process the Readability output to remove additional artifacts
    const cleanedContent = postProcessReadabilityContent(art.content);
    return { html: cleanedContent, title: art.title || "", byline: art.byline || "" };
  }
  
  console.warn(`⚠ Readability failed for ${baseUrl}, trying fallbacks...`);
  
  // Fallback 1: Try common article selectors
  const articleSelectors = [
    "article",
    "main article",
    "[role='main']",
    "main",
    ".article-content",
    ".post-content",
    ".entry-content",
    ".content-body",
    ".article-body",
    ".story-body",
    "#article-body",
    ".post-body"
  ];
  
  for (const sel of articleSelectors) {
    const elem = doc.querySelector(sel);
    if (elem) {
      // Remove nested junk
      elem.querySelectorAll(junkSel).forEach(n => n.remove());
      const html = elem.innerHTML.trim();
      if (html.length > 100) {
        console.log(`✓ Fallback selector '${sel}' extracted ${html.length} chars`);
        return { html, title: doc.title || "", byline: "" };
      }
    }
  }
  
  // Fallback 2: Get all paragraphs and filter by parent
  const paragraphs = Array.from(doc.querySelectorAll("p"));
  if (paragraphs.length > 2) {
    const contentHtml = paragraphs
      .filter(p => {
        const text = p.textContent.trim();
        return text.length > 50; // Only substantial paragraphs
      })
      .map(p => p.outerHTML)
      .join("\n");
    
    if (contentHtml.length > 100) {
      console.log(`✓ Paragraph extraction found ${contentHtml.length} chars`);
      return { html: contentHtml, title: doc.title || "", byline: "" };
    }
  }
  
  // Last resort: body content
  console.warn(`⚠ All extraction methods failed for ${baseUrl}, using body`);
  const bodyHtml = doc.body?.innerHTML || "";
  return { html: bodyHtml, title: doc.title || "", byline: "" };
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
    "--strip-comments",  // Remove HTML comments
    "-o", outPath, "--wrap=none"
  ]);
  fs.unlinkSync(tempHtml);
  
  // Post-process markdown to remove common artifact patterns
  if (fs.existsSync(outPath)) {
    let md = fs.readFileSync(outPath, "utf8");
    
    // Remove common artifact headings and their following content until next heading
    const artifactHeadingPatterns = [
      /^#{1,6}\s*(?:More from|Latest from|Editor'?s? Picks?|Trending|Related Articles?|Read More|Topics?|Tags?|Categories|Filed Under|Posted In|Attributions?|Sources?)\s*$/gmi,
      /^#{1,6}\s*(?:Share This|Follow Us|Sign Up|Newsletter|Subscribe)\s*$/gmi
    ];
    
    artifactHeadingPatterns.forEach(pattern => {
      md = md.replace(new RegExp(pattern.source + '[\\s\\S]*?(?=^#{1,6}\\s|$)', 'gmi'), '');
    });
    
    // Remove standalone lines with artifact phrases
    const artifactLinePatterns = [
      /^.*?(?:More from|Latest from|Editor'?s? Picks?).*$/gmi,
      /^.*?(?:Attributions?|Sources?)\s*\.?\s*$/gmi,
      /^\d+\s*$/gm, // Standalone numbers (often page numbers from navigation)
    ];
    
    artifactLinePatterns.forEach(pattern => {
      md = md.replace(pattern, '');
    });
    
    // Clean up multiple consecutive blank lines
    md = md.replace(/\n{3,}/g, '\n\n');
    
    fs.writeFileSync(outPath, md.trim(), "utf8");
  }
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
  console.log(`Fetching URL: ${url}`);
  
  try {
    const { html: raw } = await fetchHtml(url);
    console.log(`✓ Fetched ${raw.length} bytes from ${url}`);
    
    const { html: mainHtml, title } = extractMainFromHtml(raw, url);
    console.log(`✓ Extracted content: ${mainHtml.length} bytes, title: "${title}"`);
    
    if (!mainHtml || mainHtml.trim().length < 50) {
      console.warn(`⚠ Very little content extracted from ${url} (${mainHtml.length} bytes)`);
    }
    
    const docHtml = `\n    <article>\n      ${title ? `<h1>${title}</h1>` : ""}\n      ${mainHtml}\n    </article>\n  `;
    
    await convertHtmlToMd(docHtml, outPath, workdir);
    
    // Verify markdown was created and has content
    if (fs.existsSync(outPath)) {
      const mdContent = fs.readFileSync(outPath, "utf8");
      console.log(`✓ Generated markdown: ${mdContent.length} chars`);
      if (mdContent.trim().length < 50) {
        console.warn(`⚠ Warning: Very little markdown content generated (${mdContent.length} chars)`);
      }
    } else {
      console.error(`✗ Markdown file was not created: ${outPath}`);
    }
  } catch (err) {
    console.error(`✗ Failed to convert URL ${url}:`, err.message);
    
    // For bot-protected sites, create a marker file so we can detect and skip it
    if (err.message.includes("browser verification") || err.message.includes("Cloudflare")) {
      console.log(`Creating marker for bot-protected site: ${url}`);
      const markerMd = `Bot protection detected: This website uses bot protection (Cloudflare) and cannot be automatically fetched.`;
      fs.writeFileSync(outPath, markerMd, "utf8");
      console.log(`✓ Created marker for skipping during export`);
      return; // Don't throw error, just use marker
    }
    
    throw err;
  }
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
  const sanitizedName = (project.name || "Untitled")
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 100); // Limit length
  const outBase = `${sanitizedName}-${Date.now()}`;
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
  const pdfSequence = []; // Ordered sequence of PDF components to merge at the end
  let hasMarkdownContent = false; // Track if we have any markdown to render

  // Detect available PDF engines early if we're generating PDF
  let engines = [];
  let enginePaths = {}; // Store full paths for engines
  if (format === "pdf") {
    const tectonicPath = findPdfEngine("tectonic");
    const xelatexPath = findPdfEngine("xelatex");
    
    if (tectonicPath) {
      engines.push("tectonic");
      enginePaths["tectonic"] = tectonicPath;
    }
    if (xelatexPath) {
      engines.push("xelatex");
      enginePaths["xelatex"] = xelatexPath;
    }
    
    if (!engines.length) {
      throw new Error("No PDF engine detected. Install tectonic or xelatex.");
    }
  }

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
    
    // Generate title page PDF using the first available engine
    const titlePdfPath = path.join(workdir, 'titlepage.pdf');
    const firstEngine = engines[0];
    const firstEnginePath = enginePaths[firstEngine];
    const titleArgs = ['--pdf-engine', firstEnginePath, '-V', 'geometry:margin=1in', '-o', titlePdfPath, titleMdPath];
    try {
      await run("pandoc", titleArgs);
      pdfSequence.push({ type: 'pdf', path: titlePdfPath, description: 'Title page' });
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
  let currentPageCount = titlePageItem ? 1 : 1; // Track cumulative page count for TOC
  // Note: pdfsToAppend already declared above
  
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
      // Add heading without a page break - it will appear at the top of the next content
      // Only add page break if there was previous content and it wasn't a heading
      if (!isFirstItem && !lastWasHeading) {
        inputs.push(mdFile(workdir, `pagebreak-${nanoid(4)}.md`, `\\clearpage\n\n<div class="pagebreak"></div>\n`));
        currentPageCount += 1; // Page break adds a page
      }
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
      currentPageCount += 1; // Page break adds a page
    }
    lastWasHeading = false;  // Reset flag

    let itemMd = "";

    if (it.type === "pdf") {
      const abs = resolveLocalPath(it.local_path);
      if (!abs) { console.warn(`Skipping missing PDF: ${it.local_path}`); report(`Skipped missing PDF`); isFirstItem = false; continue; }
      
      // Count pages for TOC
      const pageCount = await countPdfPages(abs);
      const pageInfo = pageCount ? ` (${pageCount} page${pageCount === 1 ? '' : 's'})` : '';
      const tocPageInfo = showPageNumbers && pageCount ? ` (p. ${currentPageCount})` : '';
      
      // For Markdown and EPUB exports, extract text and include in document flow
      if (format === "markdown" || format === "epub") {
        // Add TOC entry with page count
        itemMd += `# ${it.title}${pageInfo}\n\n`;
        
        report(`Extracting text from PDF: ${path.basename(abs)}...`);
        const extractedText = await extractPdfText(abs);
        if (extractedText && await pdfHasExtractableText(abs)) {
          itemMd += `*Text extracted from PDF: ${path.basename(abs)}*\n\n`;
          itemMd += `${extractedText}\n\n`;
          itemMd += `---\n\n`; // Add separator
          report(`✓ Added PDF with extracted text (${extractedText.length} chars): ${it.title}${pageInfo}`);
        } else {
          itemMd += `*PDF Document: ${path.basename(abs)} - Text extraction not available (may be scanned/image-based)*\n\n`;
          report(`⚠️ Added PDF (no extractable text): ${it.title}${pageInfo}`);
        }
        
        const titled = mdFile(workdir, `pdf-${it.id}-titled.md`, itemMd);
        inputs.push(titled);
        
        // For markdown/epub, we estimate 1 page per PDF since we're including text
        currentPageCount += 1;
      } else {
        // For PDF exports, we need to handle this specially
        // If we have accumulated markdown content, we need to mark where to render it
        if (inputs.length > 0) {
          pdfSequence.push({ type: 'markdown', inputs: [...inputs], description: 'Markdown content batch' });
          inputs.length = 0; // Clear inputs array for next batch
          hasMarkdownContent = true;
        }
        
        // Add the actual PDF to the sequence
        pdfSequence.push({ type: 'pdf', path: abs, description: it.title });
        
        // Update page count for TOC
        if (pageCount) {
          currentPageCount += pageCount;
        } else {
          currentPageCount += 1; // Estimate if we can't count pages
        }
        
        report(`Added PDF in sequence: ${it.title}`);
      }
      
      isFirstItem = false;
      continue;
    }

    if (it.type === "docx") {
      const abs = resolveLocalPath(it.local_path);
      if (!abs) { console.warn(`Skipping missing DOCX: ${it.local_path}`); report(`Skipped missing DOCX`); isFirstItem = false; continue; }
      
      // Count pages for TOC
      const pageCount = await countDocxPages(abs);
      
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
      
      // Update page count for TOC
      if (pageCount) {
        currentPageCount += pageCount;
      } else {
        currentPageCount += 1; // Estimate if we can't count pages
      }
      
      report(`Added DOCX: ${it.title}`);
      isFirstItem = false;
      continue;
    }

    if (it.type === "url" || it.type === "wikipedia") {
      const out = path.join(workdir, `url-${it.id}.md`);
      try {
        // Use cached content if available, otherwise fetch fresh
        if (it.type === "url" && it.cached_content) {
          fs.writeFileSync(out, it.cached_content, "utf8");
          report(`Using cached content: ${it.title}`);
        } else {
          await convertUrlToMdSmart(it.source_url, out, wikipediaAttribution, workdir);
        }
        
        // Check if content is a bot-protection placeholder
        const content = fs.readFileSync(out, "utf8");
        if (content.includes("This website uses bot protection") || content.includes("cannot be automatically fetched")) {
          console.warn(`⚠ Skipping bot-protected page: ${it.title}`);
          failedPages.push({ 
            title: it.title, 
            url: it.source_url, 
            error: "Site uses bot protection (Cloudflare). Cannot be automatically fetched." 
          });
          report(`Skipped (bot protection): ${it.title}`);
          isFirstItem = false;
          continue; // Skip this item entirely
        }
        
        itemMd += `# ${it.title}\n\n` + content;
        const titled = mdFile(workdir, `url-${it.id}-titled.md`, itemMd);
        const res = await scrubMarkdownForPdf(titled, workdir);
        if (res.hadSvg) sawAnySvg = true;
        inputs.push(titled);
        
        // Estimate 1-2 pages for URL content
        currentPageCount += 2;
        
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
      // Add title heading if present
      if (it.title) {
        itemMd += `# ${it.title}\n\n`;
      }
      itemMd += `![${caption || it.title || "Image"}](${filename}){width=${widthPct}%}\n\n`;
      const imgMd = mdFile(workdir, `image-${it.id}.md`, itemMd);
      inputs.push(imgMd);
      
      // Images typically don't take a full page, but we increment slightly for TOC tracking
      currentPageCount += 0.5;
      
      report(`Added image: ${it.title}`);
      isFirstItem = false;
      continue;
    }
  }
  
  // Attribution and Sources - will be added at the end after all content
  let attributionContent = [];
  let creditsText = authorBanner("", project);
  
  if (wikipediaAttribution.length || nonWikiAttribution.length) {
    // Add page break before attributions
    attributionContent.push("\\clearpage\n\n<div class=\"pagebreak\"></div>\n\n");
    attributionContent.push(creditsText + "\n\n");
    
    if (wikipediaAttribution.length) {
      attributionContent.push("## Attributions\n\n");
      attributionContent.push("This document includes content from Wikipedia, available under the Creative Commons Attribution-ShareAlike License (CC BY-SA).\n\n");
      wikipediaAttribution.forEach(e => {
        attributionContent.push(`• ${e.title} — ${e.url}${e.revision ? ` (rev ${e.revision})` : ""} (accessed ${new Date().toISOString().split("T")[0]})\n\n`);
      });
    }
    
    if (nonWikiAttribution.length) {
      attributionContent.push("## Sources\n\n");
      nonWikiAttribution.forEach(e => {
        const label = e.kind === "image" ? "(image)" : "(web)";
        const title = (e.title || "").trim() || "(Untitled)";
        attributionContent.push(`• ${title} — ${e.url} ${label} (accessed ${e.accessed})\n\n`);
      });
    }
    
    // Add attribution as the last item
    const attrFile = mdFile(workdir, "zzz-attribution.md", attributionContent.join(""));
    const res = await scrubMarkdownForPdf(attrFile, workdir);
    if (res.hadSvg) sawAnySvg = true;
    inputs.push(attrFile);
    report("Added attribution page");
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
    const engineName = engineOrNull ? (path.basename(engineOrNull) === engineOrNull ? engineOrNull : path.basename(engineOrNull)) : "default";
    report(`Rendering ${format.toUpperCase()} with ${engineName} engine`);
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
    // PDF format with ordered sequence handling
    
    // If there are remaining markdown inputs, add them to the sequence
    if (inputs.length > 0) {
      pdfSequence.push({ type: 'markdown', inputs: [...inputs], description: 'Final markdown content' });
      hasMarkdownContent = true;
    }
    
    // Now render all markdown batches and build final PDF sequence
    const finalPdfSequence = [];
    let batchCounter = 0;
    
    for (const item of pdfSequence) {
      if (item.type === 'pdf') {
        // Just add the PDF path to final sequence
        finalPdfSequence.push(item.path);
      } else if (item.type === 'markdown') {
        // Render this batch of markdown to a temporary PDF
        const batchPdfPath = path.join(workdir, `batch-${batchCounter}.pdf`);
        report(`Rendering markdown batch: ${item.description}`);
        
        // Only include ToC in the first batch
        const includeToC = batchCounter === 0 && includeToc;
        batchCounter++;
        
        // Try each engine until one works
        let lastErr = null;
        for (const eng of engines) {
          const enginePath = enginePaths[eng];
          try {
            const batchArgs = buildPandocArgs({ 
              meta, 
              workdir, 
              cssPath, 
              includeToc: includeToC, 
              format, 
              engine: enginePath, 
              outPath: batchPdfPath, 
              inputs: item.inputs 
            });
            await run("pandoc", batchArgs);
            lastErr = null;
            break;
          } catch (e) { 
            lastErr = e; 
          }
        }
        if (lastErr) throw lastErr;
        
        finalPdfSequence.push(batchPdfPath);
      }
    }
    
    report("Pandoc rendering complete");

    // Merge all PDFs in the correct order if we have multiple components
    if (finalPdfSequence.length > 1) {
      report(`Merging ${finalPdfSequence.length} PDF components in order`);
      
      const merged = path.join(EXPORTS_DIR, `${outBase}-merged.pdf`);
      const merger = findPdfMerger();
      
      if (!merger) {
        throw new Error("PDF merge required but no PDF merger tool found. Please install qpdf, pdfunite (poppler-utils), or ghostscript (gs).");
      }
      
      if (merger.tool === "qpdf") {
        await runOk(merger.path, ["--warning-exit-0", "--empty", "--pages", ...finalPdfSequence, "--", merged], [0,2,3]);
        fs.renameSync(merged, outPath);
      } else if (merger.tool === "pdfunite") {
        await run(merger.path, finalPdfSequence.concat(merged));
        fs.renameSync(merged, outPath);
      } else if (merger.tool === "gs") {
        await run(merger.path, ["-dBATCH","-dNOPAUSE","-sDEVICE=pdfwrite", `-sOutputFile=${merged}`, ...finalPdfSequence]);
        fs.renameSync(merged, outPath);
      }
    } else if (finalPdfSequence.length === 1) {
      // Only one component, just copy it to output
      fs.copyFileSync(finalPdfSequence[0], outPath);
    }
    
    report("PDF export complete");
  }

  report("Done");
  
  // Clean up temp workspace to prevent I/O buildup
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
  } catch (err) {
    console.warn('Failed to cleanup temp directory:', workdir, err.message);
  }
  
  // Return export info including any failed pages
  return { 
    path: outPath, 
    failedPages: failedPages.length > 0 ? failedPages : null 
  };
}

// ---- routes ----
app.get("/api/projects", (_req, res) => {
  const rows = listProjects.all();
  res.json(rows.map(r => ({ ...r, options: safeParseJSON(r.options_json, {}) })));
});

app.post("/api/projects", requireAuth, (req, res) => {
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

app.put("/api/projects/:id", requireAuth, (req, res) => {
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

// Comments endpoints
app.get("/api/projects/:id/comments", (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  
  const comments = db.prepare(`
    SELECT c.id, c.project_id, c.user_id, c.comment_text, c.created_at, c.updated_at,
           u.first_name, u.last_name, u.affiliation
    FROM comments c
    JOIN users u ON c.user_id = u.username
    WHERE c.project_id = ?
    ORDER BY c.created_at DESC
  `).all(req.params.id);
  
  res.json(comments);
});

app.post("/api/projects/:id/comments", requireAuth, express.json(), (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  
  const { comment_text } = req.body;
  if (!comment_text || !comment_text.trim()) {
    return res.status(400).json({ error: "Comment text is required" });
  }
  
  const commentId = nanoid(12);
  const now = nowISO();
  
  try {
    db.prepare(`
      INSERT INTO comments (id, project_id, user_id, comment_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(commentId, req.params.id, req.session.user.username, comment_text.trim(), now, now);
    
    // Return the new comment with user info
    const newComment = db.prepare(`
      SELECT c.id, c.project_id, c.user_id, c.comment_text, c.created_at, c.updated_at,
             u.first_name, u.last_name, u.affiliation
      FROM comments c
      JOIN users u ON c.user_id = u.username
      WHERE c.id = ?
    `).get(commentId);
    
    res.json(newComment);
  } catch (err) {
    console.error("Error creating comment:", err);
    res.status(500).json({ error: "Failed to create comment" });
  }
});

app.delete("/api/comments/:commentId", requireAuth, (req, res) => {
  const comment = db.prepare(`SELECT user_id FROM comments WHERE id = ?`).get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  
  // Only allow deletion by comment author or admin
  if (comment.user_id !== req.session.user.username && !req.session.user.is_admin) {
    return res.status(403).json({ error: "Not authorized to delete this comment" });
  }
  
  try {
    db.prepare(`DELETE FROM comments WHERE id = ?`).run(req.params.commentId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ error: "Failed to delete comment" });
  }
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
        cached_content: item.cached_content,
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

app.delete("/api/projects/:id", requireAuth, (req, res) => {
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

// Submit access request (no auth required)
app.post("/api/access-request", express.json(), async (req, res) => {
  const { first_name, last_name, email, affiliation } = req.body || {};
  
  if (!first_name || !last_name || !email) {
    return res.status(400).json({ error: "First name, last name, and email are required" });
  }
  
  // Check if there's already a pending request for this email
  const existing = db.prepare(`SELECT * FROM access_requests WHERE email=? AND status='pending'`).get(email);
  if (existing) {
    return res.status(400).json({ error: "You already have a pending access request" });
  }
  
  // Check if user already exists - if so, send them their credentials
  const existingUser = db.prepare(`SELECT * FROM users WHERE username=?`).get(email);
  if (existingUser) {
    // Send existing credentials to user
    await sendEmail({
      to: email,
      subject: 'MYOText Account Information',
      text: `Hello ${existingUser.first_name || first_name},\n\nYou requested access to MYOText, but you already have an account!\n\nHere are your existing credentials:\n\nUsername: ${existingUser.username}\nPassword: ${existingUser.password}\n\nYou can log in at any time with these credentials.\n\nBest regards,\nMYOText Team`,
      html: `<h2>Account Information</h2>\n<p>Hello ${existingUser.first_name || first_name},</p>\n<p>You requested access to MYOText, but you already have an account!</p>\n<p>Here are your existing credentials:</p>\n<p><strong>Username:</strong> ${existingUser.username}<br>\n<strong>Password:</strong> ${existingUser.password}</p>\n<p>You can log in at any time with these credentials.</p>\n<p>Best regards,<br>MYOText Team</p>`
    });
    
    return res.json({ 
      success: true, 
      message: "Account already exists. Your credentials have been sent to your email." 
    });
  }
  
  const id = nanoid(10);
  const now = nowISO();
  
  db.prepare(`
    INSERT INTO access_requests (id, first_name, last_name, email, affiliation, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, first_name, last_name, email, affiliation || '', now, now);
  
  // Send email notification to admin
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: 'New MYOText Access Request',
    text: `New access request received:\n\nName: ${first_name} ${last_name}\nEmail: ${email}\nAffiliation: ${affiliation || 'Not provided'}\n\nPlease log in to the system to approve or decline this request.`,
    html: `<h2>New Access Request</h2>\n<p><strong>Name:</strong> ${first_name} ${last_name}</p>\n<p><strong>Email:</strong> ${email}</p>\n<p><strong>Affiliation:</strong> ${affiliation || 'Not provided'}</p>\n<p>Please log in to the system to approve or decline this request.</p>`
  });
  
  res.json({ success: true, id });
});

// Get pending access requests (admin only)
app.get("/api/access-requests", requireAuth, (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  
  const requests = db.prepare(`
    SELECT id, first_name, last_name, email, affiliation, status, created_at
    FROM access_requests
    WHERE status='pending'
    ORDER BY created_at DESC
  `).all();
  res.json(requests);
});

// Approve access request (admin only)
app.post("/api/access-requests/:id/approve", requireAuth, express.json(), async (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  
  const request = db.prepare(`SELECT * FROM access_requests WHERE id=?`).get(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  
  if (request.status !== 'pending') {
    return res.status(400).json({ error: "Request already processed" });
  }
  
  // Generate password
  const password = generatePassword();
  const username = request.email;
  const now = nowISO();
  
  // Create user account
  try {
    db.prepare(`
      INSERT INTO users (username, password, first_name, last_name, affiliation, email, is_admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(username, password, request.first_name, request.last_name, request.affiliation, request.email, now, now);
    
    // Update request status
    db.prepare(`
      UPDATE access_requests
      SET status='approved', reviewed_by=?, reviewed_at=?, updated_at=?
      WHERE id=?
    `).run(req.session.user.username, now, now, request.id);
    
    // Send approval email with credentials
    await sendEmail({
      to: request.email,
      subject: 'MYOText Access Approved',
      text: `Hello ${request.first_name},\n\nYour access request to MYOText has been approved!\n\nYou can now log in with the following credentials:\n\nUsername: ${username}\nPassword: ${password}\n\nPlease change your password after your first login.\n\nBest regards,\nMYOText Team`,
      html: `<h2>Access Approved!</h2>\n<p>Hello ${request.first_name},</p>\n<p>Your access request to MYOText has been approved!</p>\n<p>You can now log in with the following credentials:</p>\n<p><strong>Username:</strong> ${username}<br>\n<strong>Password:</strong> ${password}</p>\n<p>Please change your password after your first login.</p>\n<p>Best regards,<br>MYOText Team</p>`
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to approve request:', err);
    res.status(500).json({ error: 'Failed to create user account' });
  }
});

// Decline access request (admin only)
app.post("/api/access-requests/:id/decline", requireAuth, express.json(), async (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  
  const request = db.prepare(`SELECT * FROM access_requests WHERE id=?`).get(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  
  if (request.status !== 'pending') {
    return res.status(400).json({ error: "Request already processed" });
  }
  
  const now = nowISO();
  
  // Update request status
  db.prepare(`
    UPDATE access_requests
    SET status='declined', reviewed_by=?, reviewed_at=?, updated_at=?
    WHERE id=?
  `).run(req.session.user.username, now, now, request.id);
  
  // Send decline email
  await sendEmail({
    to: request.email,
    subject: 'MYOText Access Request Update',
    text: `Hello ${request.first_name},\n\nThank you for your interest in MYOText.\n\nWe are unable to approve your access request at this time. If you would like to provide additional information about your planned usage of the tool, please reply to this email.\n\nBest regards,\nMYOText Team`,
    html: `<h2>Access Request Update</h2>\n<p>Hello ${request.first_name},</p>\n<p>Thank you for your interest in MYOText.</p>\n<p>We are unable to approve your access request at this time. If you would like to provide additional information about your planned usage of the tool, please reply to this email.</p>\n<p>Best regards,<br>MYOText Team</p>`
  });
  
  res.json({ success: true });
});

// Create user endpoint (admin only)
app.post("/api/admin/users", requireAuth, express.json(), (req, res) => {
  // Check if current user is admin
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  
  const { username, password, first_name, last_name, affiliation, email, is_admin } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  
  try {
    // Check if user already exists
    const existing = db.prepare(`SELECT username FROM users WHERE username=?`).get(username);
    if (existing) {
      return res.status(400).json({ error: "Username already exists" });
    }
    
    // Create the user
    const now = new Date().toISOString();
    const stmt = db.prepare(`INSERT INTO users (username, password, first_name, last_name, affiliation, email, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(username, password, first_name || '', last_name || '', affiliation || '', email || '', is_admin ? 1 : 0, now, now);
    
    res.json({ ok: true, message: "User created successfully" });
  } catch (err) {
    console.error("Error creating user:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Bulk upload users from CSV (admin only)
app.post("/api/admin/users/bulk", requireAuth, upload.single('csvFile'), (req, res) => {
  // Check if current user is admin
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: "No CSV file uploaded" });
  }
  
  try {
    const csvContent = fs.readFileSync(req.file.path, 'utf-8');
    const lines = csvContent.split('\n').map(l => l.trim()).filter(Boolean);
    
    if (lines.length < 2) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "CSV file must contain a header row and at least one data row" });
    }
    
    // Parse header
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const requiredFields = ['username', 'password'];
    const missingFields = requiredFields.filter(f => !header.includes(f));
    
    if (missingFields.length > 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Missing required columns: ${missingFields.join(', ')}` });
    }
    
    const results = { created: 0, skipped: 0, errors: [] };
    const now = new Date().toISOString();
    
    // Process each data row
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      
      header.forEach((field, idx) => {
        row[field] = values[idx] || '';
      });
      
      // Validate required fields
      if (!row.username || !row.password) {
        results.errors.push(`Row ${i + 1}: Missing username or password`);
        results.skipped++;
        continue;
      }
      
      try {
        // Check if user already exists
        const existing = db.prepare(`SELECT username FROM users WHERE username=?`).get(row.username);
        if (existing) {
          results.errors.push(`Row ${i + 1}: Username '${row.username}' already exists`);
          results.skipped++;
          continue;
        }
        
        // Create the user
        const stmt = db.prepare(`INSERT INTO users (username, password, first_name, last_name, affiliation, email, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run(
          row.username,
          row.password,
          row.first_name || '',
          row.last_name || '',
          row.affiliation || '',
          row.email || '',
          (row.is_admin === '1' || row.is_admin?.toLowerCase() === 'true') ? 1 : 0,
          now,
          now
        );
        
        results.created++;
      } catch (err) {
        console.error(`Error creating user from row ${i + 1}:`, err);
        results.errors.push(`Row ${i + 1}: ${err.message}`);
        results.skipped++;
      }
    }
    
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    
    res.json({
      ok: true,
      message: `Bulk upload complete: ${results.created} created, ${results.skipped} skipped`,
      results
    });
  } catch (err) {
    console.error("Error processing CSV:", err);
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Failed to process CSV file: " + err.message });
  }
});

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
app.post("/api/projects/:id/items", requireAuth, async (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const items = getItems.all(p.id);
  const position = items.length ? (items[items.length - 1].position + 1) : 1;
  const id = nanoid(10);
  const type = (req.body.type || "").toLowerCase();
  let title = (req.body.title || "").trim() || (type === "heading" ? "Chapter" : "Untitled");
  let source_url = null;
  let cached_content = null;
  let initOptions = (req.body.options && typeof req.body.options === "object") ? req.body.options : {};
  
  if (type === "titlepage") {
    title = req.body.title?.trim() || "";
    // Subtitle is already in initOptions from req.body.options
    if (!initOptions.subtitle) {
      initOptions.subtitle = "";
    }
    // source_url stays null
  } else if (["url", "wikipedia", "image"].includes(type)) {
    const rawUrl = req.body.url || null;
    source_url = rawUrl ? normalizeUrlMaybe(rawUrl.trim()) : null;
    
    // Cache website content if requested (but not for Wikipedia)
    if (type === "url" && req.body.cacheContent && source_url) {
      try {
        const tempDir = fs.mkdtempSync(path.join(TMP_DIR, `cache-${id}-`));
        const tempMd = path.join(tempDir, "content.md");
        await convertUrlToMdSmart(source_url, tempMd, [], tempDir);
        cached_content = fs.readFileSync(tempMd, "utf8");
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Failed to cache content for ${source_url}:`, err.message);
        // Continue without cached content
      }
    }
  }
  
  if (!["url","wikipedia","heading","image","titlepage"].includes(type)) return res.status(400).json({ error: "Invalid type" });
  insertItem.run({ id, project_id: p.id, position, type, title, source_url, local_path: null, options: JSON.stringify(initOptions), cached_content, now: nowISO() });
  res.json({ id, type, title, source_url, position, cached_content: cached_content ? true : false });
});

// Upload item (docx, pdf, image) — store only filename in DB
app.post("/api/projects/:id/items/upload", requireAuth, upload.single("file"), (req, res) => {
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
  insertItem.run({ id, project_id: p.id, position, type, title, source_url: null, local_path: file.filename, options: JSON.stringify(initOptions), cached_content: null, now: nowISO() });
  res.json({ id, type, title, position, filename: file.filename });
});

// Reorder items in a project
app.put("/api/projects/:id/items/reorder", requireAuth, (req, res) => {
  const order = req.body.order; // [{id, position}, ...]
  if (!Array.isArray(order)) return res.status(400).json({ error: "Bad payload" });
  const tx = db.transaction((rows) => {
    rows.forEach(r => updateItemPositions.run(r.position, r.id));
  });
  tx(order);
  res.json({ ok: true });
});

// Update item in a project (PATCH)
app.patch("/api/projects/:id/items/:itemId", requireAuth, express.json(), (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const itemId = req.params.itemId;
  const item = getItemById.get(itemId, p.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  
  const { title, source_url, options } = req.body;
  const updates = {};
  
  if (title !== undefined) updates.title = title;
  if (source_url !== undefined) updates.source_url = source_url;
  if (options !== undefined) {
    // Merge options with existing options
    let currentOptions = {};
    if (item.options_json) {
      try {
        currentOptions = JSON.parse(item.options_json);
      } catch (e) {
        currentOptions = {};
      }
    }
    updates.options_json = JSON.stringify({ ...currentOptions, ...options });
  }
  
  // Build dynamic UPDATE query
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }
  
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);
  values.push(itemId); // for WHERE clause
  
  const stmt = db.prepare(`UPDATE items SET ${setClause} WHERE id = ?`);
  stmt.run(...values);
  
  res.json({ ok: true });
});

// Delete item in a project
app.delete("/api/projects/:id/items/:itemId", requireAuth, (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const itemId = req.params.itemId;
  const item = getItemById.get(itemId, p.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  deleteItem.run(itemId);
  res.json({ ok: true });
});

// Toggle caching for a URL item
app.post("/api/projects/:id/items/:itemId/cache", requireAuth, async (req, res) => {
  const p = getProject.get(req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const item = getItemById.get(req.params.itemId, p.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (item.type !== "url") return res.status(400).json({ error: "Only URL items can be cached" });
  
  const { cache } = req.body;
  let cached_content = item.cached_content;
  
  if (cache && !cached_content && item.source_url) {
    // Cache the content
    try {
      const tempDir = fs.mkdtempSync(path.join(TMP_DIR, `cache-${item.id}-`));
      const tempMd = path.join(tempDir, "content.md");
      await convertUrlToMdSmart(item.source_url, tempMd, [], tempDir);
      cached_content = fs.readFileSync(tempMd, "utf8");
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed to cache content for ${item.source_url}:`, err.message);
      return res.status(500).json({ error: "Failed to cache content" });
    }
  } else if (!cache) {
    // Remove cache
    cached_content = null;
  }
  
  db.prepare(`UPDATE items SET cached_content = ?, updated_at = ? WHERE id = ?`)
    .run(cached_content, nowISO(), item.id);
  
  res.json({ ok: true, cached: cached_content ? true : false });
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
      const result = await exportProjectTo(format, p, items, options, (progress) => {
        setProgress(jobId, { ...progress, done: false });
      });
      
      // Handle both old string format and new object format
      const outPath = typeof result === 'string' ? result : result.path;
      const failedPages = typeof result === 'object' ? result.failedPages : null;
      
      setProgress(jobId, { 
        step: 1, 
        total: 1, 
        message: "Done", 
        done: true, 
        output: outPath,
        failedPages: failedPages 
      });
    } catch (err) {
      setProgress(jobId, { step: 1, total: 1, message: "Error", done: true, error: err.message });
    }
  })();
});

// ---- error handler (keep API responses JSON) ----
// If a route throws and doesn't catch, Express defaults to an HTML error page.
// The client expects JSON/text, so normalize errors for /api/*.
app.use(async (err, req, res, _next) => {
  console.error("Unhandled route error:", err);
  
  // Send alert for 500 errors
  if (err && (!err.status || err.status >= 500)) {
    await sendMonitoringAlert(
      'Server Error in Route Handler',
      `Route: ${req.method} ${req.path}\nError: ${err.message}\n\nStack:\n${err.stack}`,
      'error'
    ).catch(e => console.error('Failed to send error alert:', e));
  }
  
  const wantsJson = req.path?.startsWith("/api/") || req.headers.accept?.includes("application/json");
  if (wantsJson) {
    const status = (typeof err?.status === "number" && err.status >= 400 && err.status < 600) ? err.status : 500;
    return res.status(status).json({ error: err?.message || "Internal Server Error" });
  }
  res.status(500).send("Internal Server Error");
});

// ---- System Health Monitoring ----
function getSystemHealth() {
  const used = process.memoryUsage();
  const totalMem = require('os').totalmem();
  const freeMem = require('os').freemem();
  const usedMemPct = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
  
  return {
    memory: {
      heapUsed: Math.round(used.heapUsed / 1024 / 1024),
      heapTotal: Math.round(used.heapTotal / 1024 / 1024),
      rss: Math.round(used.rss / 1024 / 1024),
      systemUsed: usedMemPct
    },
    uptime: Math.round(process.uptime()),
    pid: process.pid
  };
}

async function checkSystemHealth() {
  try {
    const health = getSystemHealth();
    
    // Check memory usage
    if (health.memory.systemUsed > 90) {
      await sendMonitoringAlert(
        'High Memory Usage',
        `System memory usage is ${health.memory.systemUsed}%\nHeap: ${health.memory.heapUsed}MB / ${health.memory.heapTotal}MB\nRSS: ${health.memory.rss}MB`,
        'warning'
      );
    }
    
    // Check temp directory buildup
    if (fs.existsSync(TMP_DIR)) {
      const tempDirs = fs.readdirSync(TMP_DIR).filter(d => d.startsWith('build-') || d.startsWith('cache-'));
      if (tempDirs.length > 50) {
        await sendMonitoringAlert(
          'Excessive Temp Directories',
          `${tempDirs.length} temporary directories found in ${TMP_DIR}.\nThis may indicate cleanup is not working properly.`,
          'warning'
        );
      }
    }
    
    // Check disk space
    const { spawn } = require('child_process');
    const df = spawn('df', ['-h', DATA_DIR]);
    let output = '';
    df.stdout.on('data', data => output += data);
    df.on('close', async () => {
      const lines = output.split('\n');
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        const usePercent = parseInt(parts[4]);
        if (usePercent > 90) {
          await sendMonitoringAlert(
            'Low Disk Space',
            `Disk usage is ${usePercent}% on ${DATA_DIR}\n\n${output}`,
            'warning'
          );
        }
      }
    });
    
  } catch (err) {
    console.error('Health check failed:', err.message);
  }
}

// Run health check every 15 minutes
setInterval(checkSystemHealth, 15 * 60 * 1000);

// ---- listen ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`MYOTextbook listening on http://localhost:${PORT}\nDATA_DIR: ${DATA_DIR}\nUPLOADS_DIR: ${UPLOADS_DIR}\nEXPORTS_DIR: ${EXPORTS_DIR}\nTMP_DIR: ${TMP_DIR}`);
  
  // Send startup notification
  const health = getSystemHealth();
  if (mgClient) {
    await sendMonitoringAlert(
      'Server Started',
      `MYOTextbook server started successfully.\n\nMemory: ${health.memory.heapUsed}MB heap, ${health.memory.rss}MB RSS\nSystem Memory: ${health.memory.systemUsed}% used\nPort: ${PORT}`,
      'info'
    ).catch(err => console.log('Startup notification failed:', err.message));
  }
  
  // Run initial health check after 30 seconds
  setTimeout(checkSystemHealth, 30000);
});