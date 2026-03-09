require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
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
const bucket = admin.storage().bucket();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'lsd-afl-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

// Multer uses memory storage — files go to Firebase Storage, never touch disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ── Upload logo buffer to Firebase Storage, return public URL ─────────────────
async function uploadLogoToFirebase(fileBuffer, originalName, mimeType) {
  const ext = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : 'png';
  const safeName = originalName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .toLowerCase();

  let filename = `logos/${safeName}.${ext}`;
  const [exists] = await bucket.file(filename).exists();
  if (exists) {
    filename = `logos/${safeName}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  }

  await bucket.file(filename).save(fileBuffer, {
    metadata: { contentType: mimeType || 'image/png' },
    public: true,
  });

  return `https://storage.googleapis.com/${bucket.name}/${filename}`;
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Admin login required' });
}

const clubTokens = new Map();

function requireClub(req, res, next) {
  const slug = req.params.slug;
  if (req.session && req.session.clubSlug === slug) return next();
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token && clubTokens.get(slug) === token) {
    req.session.clubSlug = slug;
    return next();
  }
  return res.status(401).json({ error: 'Club login required' });
}

// ── Serve HTML pages ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/public/admin/index.html'));
app.get('/:slug/live', (req, res) => res.sendFile(__dirname + '/public/live.html'));
app.get('/:slug/control', (req, res) => res.sendFile(__dirname + '/public/control.html'));

// ── Admin Auth ─────────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminHash) {
    const hash = await bcrypt.hash(password, 10);
    return res.status(403).json({
      error: 'ADMIN_PASSWORD_HASH not set in environment variables.',
      hash,
      instructions: 'Copy the hash and add it as ADMIN_PASSWORD_HASH in Render env vars, then redeploy.'
    });
  }
  const ok = await bcrypt.compare(password, adminHash);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ── Club Auth ──────────────────────────────────────────────────────────────────
app.post('/api/club/login', async (req, res) => {
  const { slug, password } = req.body;
  const doc = await db.collection('clubs').doc(slug).get();
  if (!doc.exists) return res.status(404).json({ error: 'Club not found' });
  const ok = await bcrypt.compare(password, doc.data().passwordHash);
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  req.session.clubSlug = slug;
  const token = crypto.randomBytes(32).toString('hex');
  clubTokens.set(slug, token);
  res.json({ ok: true, slug, token });
});

app.post('/api/club/logout', (req, res) => { req.session.clubSlug = null; res.json({ ok: true }); });
app.get('/api/club/check/:slug', (req, res) => {
  res.json({ authed: !!(req.session && req.session.clubSlug === req.params.slug) });
});

// ── Admin: Club management ─────────────────────────────────────────────────────
app.get('/api/admin/clubs', requireAdmin, async (req, res) => {
  const snap = await db.collection('clubs').get();
  res.json(snap.docs.map(d => ({ slug: d.id, ...d.data(), passwordHash: undefined })));
});

app.post('/api/admin/clubs', requireAdmin, upload.array('logos', 20), async (req, res) => {
  try {
    const { slug, name, password } = req.body;
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const existing = await db.collection('clubs').doc(cleanSlug).get();
    if (existing.exists) return res.status(400).json({ error: 'Club slug already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const logos = [];
    for (const file of (req.files || [])) {
      logos.push(await uploadLogoToFirebase(file.buffer, file.originalname, file.mimetype));
    }

    await db.collection('clubs').doc(cleanSlug).set({
      name, slug: cleanSlug, passwordHash, logos,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('games').doc(cleanSlug).set({
      homeTeam: { logo: '', goals: 0, behinds: 0 },
      awayTeam: { logo: '', goals: 0, behinds: 0 },
      quarter: 1,
      clockBaseSeconds: 0,
      clockStartedAt: null,
      clockRunning: false
    });

    res.json({ ok: true, slug: cleanSlug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/clubs/:slug', requireAdmin, async (req, res) => {
  await db.collection('clubs').doc(req.params.slug).delete();
  await db.collection('games').doc(req.params.slug).delete();
  res.json({ ok: true });
});

app.post('/api/admin/clubs/:slug/upload-logo', requireAdmin, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const url = await uploadLogoToFirebase(req.file.buffer, req.file.originalname, req.file.mimetype);
    await db.collection('clubs').doc(req.params.slug).update({
      logos: admin.firestore.FieldValue.arrayUnion(url)
    });
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/clubs/:slug/logo', requireAdmin, async (req, res) => {
  const { logoUrl } = req.body;
  await db.collection('clubs').doc(req.params.slug).update({
    logos: admin.firestore.FieldValue.arrayRemove(logoUrl)
  });
  try {
    const urlPath = decodeURIComponent(new URL(logoUrl).pathname);
    const storagePath = urlPath.replace(`/${bucket.name}/`, '');
    await bucket.file(storagePath).delete();
  } catch (e) {
    console.warn('Storage delete skipped:', e.message);
  }
  res.json({ ok: true });
});

// ── Club data ──────────────────────────────────────────────────────────────────
app.get('/api/club/:slug', async (req, res) => {
  const doc = await db.collection('clubs').doc(req.params.slug).get();
  if (!doc.exists) return res.status(404).json({ error: 'Club not found' });
  const d = doc.data();
  res.json({ slug: doc.id, name: d.name, logos: d.logos || [] });
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

app.post('/api/game/:slug/reset', requireClub, async (req, res) => {
  try {
    await db.collection('games').doc(req.params.slug).update({
      'homeTeam.goals': 0, 'homeTeam.behinds': 0,
      'awayTeam.goals': 0, 'awayTeam.behinds': 0,
      quarter: 1,
      clockBaseSeconds: 0,
      clockStartedAt: null,
      clockRunning: false
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Firebase client config ─────────────────────────────────────────────────────
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
