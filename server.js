require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Firebase init ──────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});
const db = admin.firestore();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'lsd-afl-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// Logo uploads – stored in public/logos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public', 'logos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Auth helpers ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Admin login required' });
}

function requireClub(req, res, next) {
  const slug = req.params.slug;
  if (req.session && req.session.clubSlug === slug) return next();
  return res.status(401).json({ error: 'Club login required' });
}

// ── Serve HTML pages ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

app.get('/:slug/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.get('/:slug/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));

// ── Admin Auth ─────────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminHash) {
    // First run: any password sets the admin password
    const hash = await bcrypt.hash(password, 10);
    console.log('FIRST RUN - Set this as ADMIN_PASSWORD_HASH in your .env:\n' + hash);
    req.session.isAdmin = true;
    return res.json({ ok: true, firstRun: true, hash });
  }
  const ok = await bcrypt.compare(password, adminHash);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ── Club Auth ──────────────────────────────────────────────────────────────────
app.post('/api/club/login', async (req, res) => {
  const { slug, password } = req.body;
  const doc = await db.collection('clubs').doc(slug).get();
  if (!doc.exists) return res.status(404).json({ error: 'Club not found' });
  const club = doc.data();
  const ok = await bcrypt.compare(password, club.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  req.session.clubSlug = slug;
  res.json({ ok: true, slug });
});

app.post('/api/club/logout', (req, res) => {
  req.session.clubSlug = null;
  res.json({ ok: true });
});

app.get('/api/club/check/:slug', (req, res) => {
  res.json({ authed: req.session && req.session.clubSlug === req.params.slug });
});

// ── Admin: Club management ─────────────────────────────────────────────────────
app.get('/api/admin/clubs', requireAdmin, async (req, res) => {
  const snap = await db.collection('clubs').get();
  const clubs = snap.docs.map(d => ({ slug: d.id, ...d.data(), passwordHash: undefined }));
  res.json(clubs);
});

app.post('/api/admin/clubs', requireAdmin, upload.fields([
  { name: 'logos', maxCount: 20 }
]), async (req, res) => {
  try {
    const { slug, name, password } = req.body;
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const existing = await db.collection('clubs').doc(cleanSlug).get();
    if (existing.exists) return res.status(400).json({ error: 'Club slug already exists' });
    const passwordHash = await bcrypt.hash(password, 10);

    // Handle uploaded logos
    const logos = [];
    if (req.files && req.files.logos) {
      for (const file of req.files.logos) {
        logos.push(`/logos/${file.filename}`);
      }
    }

    await db.collection('clubs').doc(cleanSlug).set({
      name,
      slug: cleanSlug,
      passwordHash,
      logos,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create initial game state
    await db.collection('games').doc(cleanSlug).set({
      homeTeam: { name: '', logo: '', goals: 0, behinds: 0 },
      awayTeam: { name: '', logo: '', goals: 0, behinds: 0 },
      quarter: 1,
      clock: 0,
      clockRunning: false,
      lastClockUpdate: null
    });

    res.json({ ok: true, slug: cleanSlug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/clubs/:slug', requireAdmin, async (req, res) => {
  const { slug } = req.params;
  await db.collection('clubs').doc(slug).delete();
  await db.collection('games').doc(slug).delete();
  res.json({ ok: true });
});

app.post('/api/admin/clubs/:slug/upload-logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const logoPath = `/logos/${req.file.filename}`;
  await db.collection('clubs').doc(req.params.slug).update({
    logos: admin.firestore.FieldValue.arrayUnion(logoPath)
  });
  res.json({ ok: true, path: logoPath });
});

app.delete('/api/admin/clubs/:slug/logo', requireAdmin, async (req, res) => {
  const { logoPath } = req.body;
  await db.collection('clubs').doc(req.params.slug).update({
    logos: admin.firestore.FieldValue.arrayRemove(logoPath)
  });
  // Delete file from disk
  const fullPath = path.join(__dirname, 'public', logoPath);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  res.json({ ok: true });
});

// ── Club data ──────────────────────────────────────────────────────────────────
app.get('/api/club/:slug', async (req, res) => {
  const doc = await db.collection('clubs').doc(req.params.slug).get();
  if (!doc.exists) return res.status(404).json({ error: 'Club not found' });
  const data = doc.data();
  res.json({ slug: doc.id, name: data.name, logos: data.logos || [] });
});

// ── Game state ─────────────────────────────────────────────────────────────────
app.get('/api/game/:slug', async (req, res) => {
  const doc = await db.collection('games').doc(req.params.slug).get();
  if (!doc.exists) return res.status(404).json({ error: 'Game not found' });
  res.json(doc.data());
});

app.patch('/api/game/:slug', requireClub, async (req, res) => {
  try {
    await db.collection('games').doc(req.params.slug).update(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset game scores
app.post('/api/game/:slug/reset', requireClub, async (req, res) => {
  await db.collection('games').doc(req.params.slug).update({
    'homeTeam.goals': 0,
    'homeTeam.behinds': 0,
    'awayTeam.goals': 0,
    'awayTeam.behinds': 0,
    quarter: 1,
    clock: 0,
    clockRunning: false,
    lastClockUpdate: null
  });
  res.json({ ok: true });
});

// Firebase config for client
app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
  });
});

app.listen(PORT, () => console.log(`LSD AFL Scoreboard running on port ${PORT}`));
