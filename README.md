# LiveSourceData – AFL Scoreboard

Live AFL scoring system for OBS, LED screens, and web viewing.

## What It Does

- **`/`** – Login page for clubs and admin
- **`/admin`** – Admin panel: create clubs, upload logos, manage everything
- **`/:slug/control`** – Club scoring panel (password protected)
- **`/:slug/live`** – 1920×1080 OBS-ready scoreboard (publicly viewable)

---

## Setup Guide

### Step 1 – Firebase (free)

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add Project** → name it (e.g. `lsd-afl`) → disable Google Analytics → Create
3. In the left sidebar go to **Firestore Database** → Create database → Start in **production mode** → choose a region close to Australia (e.g. `australia-southeast1`)
4. Click **Project Settings** (gear icon top left)
5. Scroll to **Your apps** → click `</>` (web) → register with any name → copy the `firebaseConfig` object values — you'll need them for your `.env`

#### Enable Firebase Storage:
5. In the Firebase Console left sidebar → **Storage** → Get started → Start in production mode → choose the same region as Firestore
6. Go to the **Rules** tab in Storage and replace the rules with:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /logos/{allPaths=**} {
      allow read: if true;   // logos are public
      allow write: if false; // server-side only
    }
  }
}
```

#### Get the Admin SDK service account:
6. In Project Settings → **Service accounts** tab
7. Click **Generate new private key** → download the JSON file
8. Open that JSON file and copy ALL of it (it's one long JSON object)

#### Set Firestore security rules:
In the Firebase Console → Firestore → Rules, paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Anyone can read game data (for the live scoreboard)
    match /games/{slug} {
      allow read: true;
      allow write: if false; // server-side only
    }
    // Club and admin data - server-side only
    match /clubs/{slug} {
      allow read, write: if false;
    }
  }
}
```

---

### Step 2 – Deploy to Render

1. Push this code to a new GitHub repo
2. Go to [https://render.com](https://render.com) → New → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node

#### Add Environment Variables in Render dashboard:

| Variable | Value |
|----------|-------|
| `SESSION_SECRET` | Any long random string (e.g. `afl-lsd-secret-abc123xyz`) |
| `FIREBASE_API_KEY` | From your firebaseConfig |
| `FIREBASE_AUTH_DOMAIN` | From your firebaseConfig |
| `FIREBASE_PROJECT_ID` | From your firebaseConfig |
| `FIREBASE_STORAGE_BUCKET` | From your firebaseConfig |
| `FIREBASE_MESSAGING_SENDER_ID` | From your firebaseConfig |
| `FIREBASE_APP_ID` | From your firebaseConfig |
| `FIREBASE_SERVICE_ACCOUNT` | Paste the entire service account JSON as one line |

---

### Step 3 – Set Your Admin Password

1. Visit your site URL (e.g. `https://footy.livesourcedata.com`)
2. Click **Admin** tab and type any password you want to use
3. You'll see a popup with a **bcrypt hash** – copy it
4. In Render → Environment Variables → add: `ADMIN_PASSWORD_HASH` = (the hash)
5. Redeploy (Render will pick up the new env var)

---

### Step 4 – Add Your First Club

1. Login to `/admin`
2. Fill in Club Name (e.g. `Sturt Football Club`), Slug (`sturt`), and an access code
3. Upload logos (PNG or SVG with transparent background works best on the black scoreboard)
4. Click **Add Club**

Now give the club their login:
- URL: `https://footy.livesourcedata.com`
- Club: `sturt`  
- Code: whatever you set

---

### Step 5 – OBS Setup

1. In OBS → Sources → Add **Browser Source**
2. URL: `https://footy.livesourcedata.com/sturt/live`
3. Width: `1920`, Height: `1080`
4. ✅ Shutdown source when not visible
5. ✅ Refresh browser when scene becomes active

The scoreboard page updates in real-time via Firebase — no refresh needed!

---

## Local Development

```bash
cp .env.example .env
# Fill in your Firebase values in .env
npm install
npm run dev
```

---

## Tips

- **Multiple clubs:** Create as many clubs as you like in admin. Each gets their own `/slug/` URL.
- **Logo format:** PNG with transparent background at 400×400px looks best
- **Score bump animation:** Goals and behinds flash yellow when they change on the scoreboard
- **Clock:** The clock counts up in real-time. Stopping it saves the exact time. Resetting brings it back to 0:00.
- **Quarter Extra Time:** The quarter selector includes "ET" for extra time
