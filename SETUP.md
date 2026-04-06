# Power Monitor Web Dashboard — Setup Guide

## Architecture

```
MFM384 meter → RS485 → PC running app.py
                              ↓ firebase-admin (Python)
                        Firebase Firestore (cloud)
                              ↓ real-time listener
                        Any browser anywhere
```

---

## Step 1 — Generate Firebase service account key

1. Go to console.firebase.google.com → select solarpv-field-tool project
2. Click gear icon → **Project Settings**
3. Click **Service accounts** tab
4. Click **Generate new private key** → **Generate key**
5. Save the downloaded file as **firebase_key.json**
6. Place it in the same folder as app.py (D:\claude\mfm384-scada\)

> Keep this file SECRET. Anyone with it has full write access to your Firestore.
> Never commit it to GitHub.

---

## Step 2 — Install firebase-admin Python package

```
pip install firebase-admin
```

---

## Step 3 — Enable Firebase in config.json

Open your config.json (in %APPDATA%\PowerMonitoringReporting\) and add/edit:

```json
"firebase": {
    "enabled": true,
    "site_id": "site_01",
    "key_path": "firebase_key.json",
    "push_interval_sec": 30,
    "enable_history": false
}
```

Change `site_id` to something meaningful like `"kumburutheniwela"` or `"factory_main"`.

---

## Step 4 — Update Firestore security rules

Go to Firebase console → Firestore → **Rules** tab and replace with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // User private data (HydroInspect, SolarPV)
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // SCADA site data — read by any signed-in user, write only from server
    match /sites/{siteId}/{document=**} {
      allow read: if request.auth != null;
      allow write: if false;  // only firebase-admin (server) can write
    }
  }
}
```

Click **Publish**.

---

## Step 5 — Run app.py

Start the SCADA app normally. If firebase_key.json is present and enabled=true,
you will see in the log:

```
Firebase Firestore connected (site=site_01)
FirebasePublisher started — site_id=site_01, interval=30s
```

---

## Step 6 — Host the web dashboard

### Option A: GitHub Pages (recommended — free, permanent)
- Push the web-dashboard/ folder to a GitHub repo
- Enable Pages from main branch
- Share the URL — anyone can sign in and view live data

### Option B: Local server (LAN only)
```
cd D:\claude\mfm384-scada\web-dashboard
py -m http.server 8095
```
Open: http://localhost:8095

---

## Step 7 — Open the dashboard

- Open the dashboard URL in any browser
- Sign in with Google
- Enter the site_id you set in config.json (default: site_01)
- Click **Connect**
- Live meter data appears and updates every 30 seconds

---

## Quota check (Spark free plan)

| Setting | Writes/day | Spark limit |
|---|---|---|
| 1 meter, 30s interval | 2,880 | 20,000 ✓ |
| 6 meters, 30s interval | 17,280 | 20,000 ✓ |
| 6 meters, 10s interval | 51,840 | 20,000 ✗ |

Stay at 30s interval for 6 meters to remain within free quota.
Enable history only if needed — each history write doubles the count.
