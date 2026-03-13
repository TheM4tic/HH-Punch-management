# P-H&H Punch Items App

Multi-user HVAC commissioning punch-item tracker with real-time sync, photo storage, and offline support.

**Stack:** React 18 + TypeScript + Vite · Firebase Auth + Firestore · Cloudinary (photos) · GitHub Pages

---

## Quick Start (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Create .env file with your credentials
cp .env.example .env
# → Edit .env and fill in your Firebase + Cloudinary values

# 3. Start dev server
npm run dev
# → Open http://localhost:5173
```

---

## Firebase Setup (one-time)

### 1. Create Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project**
3. Disable Google Analytics (optional)

### 2. Enable Authentication

1. **Build → Authentication → Get started**
2. Under **Sign-in method**, enable **Email/Password**

### 3. Create Firestore Database

1. **Build → Firestore Database → Create database**
2. Choose **Start in production mode**
3. Select region (e.g. `europe-west1`)
4. After creation, go to **Rules** tab, paste contents of `firestore.rules`, click **Publish**

### 4. Firebase Storage — NOT NEEDED ✓

Photo storage is handled by **Cloudinary** (free, no credit card).  
Firebase stays on the free **Spark plan** — no billing required.  
The `storage.rules` file is included for reference only.

### 5. Set Up Cloudinary (free photo storage)

1. Sign up at [cloudinary.com](https://cloudinary.com) — free, no credit card
2. On your Dashboard, note your **Cloud Name**
3. Go to **Settings → Upload → Add upload preset**
   - Set **Signing Mode** to **Unsigned**
   - Set **Folder** to `punch-items` (optional)
   - Save → note the **Preset Name**

### 6. Register Web App & Get Firebase Config

1. Project Settings (gear icon) → **Your apps** → click **</>** (Web)
2. Give it a nickname (e.g. `punch-items-web`)
3. Copy the `firebaseConfig` values into your `.env` file

---

## GitHub Pages Deployment

### 1. No vite.config.ts changes needed ✓

The base path is set to `"./"` which works automatically for any repository name.

### 2. Enable GitHub Pages

1. GitHub repo → **Settings → Pages**
2. Under **Source**, select **GitHub Actions**

### 3. Add secrets to GitHub

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**

Add all 8 secrets:

| Secret name | Where to find it |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase Project Settings → Your apps |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Project Settings → Your apps |
| `VITE_FIREBASE_PROJECT_ID` | Firebase Project Settings → Your apps |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase Project Settings → Your apps |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase Project Settings → Your apps |
| `VITE_FIREBASE_APP_ID` | Firebase Project Settings → Your apps |
| `VITE_CLOUDINARY_CLOUD_NAME` | Cloudinary Dashboard homepage |
| `VITE_CLOUDINARY_UPLOAD_PRESET` | Cloudinary Settings → Upload → Presets |

### 4. Add authorized domain for Firebase Auth

Firebase Console → **Authentication → Settings → Authorized domains → Add domain:**
```
YOUR-GITHUB-USERNAME.github.io
```
(Just the username part — no repo name needed)

### 5. Push to GitHub

Upload all files to your GitHub repository. The GitHub Action runs automatically.  
After ~2 minutes your app is live at:
```
https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/
```

---

## First-Time App Setup

1. Open the app URL
2. Since no accounts exist yet, the **Create Admin Account** screen appears automatically
3. Enter your email and a strong password → click **Create Admin Account**
4. You're now logged in as admin

### Adding more users

Admin panel → **Users** tab → **Add User** → two options:
- **Create Account**: Admin sets a temporary password and shares it with the user
- **Create Invite Link**: Generates a link the user clicks to self-register (valid 7 days)

---

## Features

| Feature | Details |
|---|---|
| **Real-time sync** | All users see updates instantly via Firestore `onSnapshot` |
| **Offline support** | Works without internet (IndexedDB persistence), syncs when back online |
| **Photo capture** | Separate "Take Photo" (rear camera) and "Gallery" buttons for cross-platform reliability |
| **Photo compression** | Images compressed to max 1920px / 82% JPEG before upload (canvas-based, no library) |
| **Photo storage** | Uploaded to Cloudinary (25 GB free), served via CDN |
| **CSV import** | Drag-and-drop CSV import with column auto-mapping and preview |
| **ZIP export** | Downloads all photos (or per-room) as a structured ZIP file |
| **ProCoSys tracking** | Admin can mark closed items as reported in ProCoSys |
| **Password reset** | Real Firebase email reset |
| **Logo upload** | Project logo stored in Cloudinary, URL saved in Firestore |
| **Responsibility view** | Filter and browse items by responsible party |
| **Room browse** | Group and navigate items by room/location |

---

## Bugs Fixed vs. Original

| Bug | Fix |
|---|---|
| sessionStorage wiped on tab close | Replaced with Firestore (persistent, real-time) |
| Data not shared between users/devices | Firestore real-time listeners |
| Base64 photos crashing (5 MB quota) | Cloudinary upload + URL references in Firestore |
| Fake auth (passwords in localStorage) | Firebase Email/Password Auth |
| `capture="environment"` broken on Android 14+ | Two separate inputs: camera + gallery |
| Same file can't be re-selected | `e.target.value = ''` after each selection |
| `URL.createObjectURL` memory leaks | `URL.revokeObjectURL` after use |
| AdminScreen missing `setLogo` prop | Properly typed and passed |
| onSnapshot listeners accumulating | Cleanup function in every `useEffect` |
| Logo missing on several screens | `logo` prop passed consistently to all screens |
| localStorage/sessionStorage inconsistency | Both removed — Firebase handles all persistence |

---

## Project Structure

```
punch-items-app/
├── .github/workflows/deploy.yml   ← GitHub Actions auto-deploy
├── src/
│   ├── lib/firebase.ts            ← Firebase init + offline persistence
│   ├── App.tsx                    ← All components + Firebase integration
│   └── main.tsx                   ← React entry point
├── firestore.rules                ← Firestore security rules
├── storage.rules                  ← Firebase Storage rules (not actively used)
├── firebase.json                  ← Firebase project config
├── firestore.indexes.json         ← Firestore query indexes
├── vite.config.ts                 ← Vite build config (base: "./" works for any repo)
├── tsconfig.json                  ← TypeScript config
├── tsconfig.node.json             ← TypeScript config for Vite
├── package.json                   ← Dependencies
├── index.html                     ← HTML entry point
├── .env.example                   ← Environment variables template
└── .gitignore                     ← .env excluded from Git
```
