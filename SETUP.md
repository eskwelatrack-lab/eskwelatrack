# SLNHS Automated Digital Attendance System: setup

Stack: **GitHub Pages** (frontend) + **Firebase Authentication** + **Cloud Firestore** (backend/database).
Everything below works on Firebase's free **Spark** plan. No Cloud Functions, no Cloud Storage, no billing card.

## 1. Create the Firebase project
1. https://console.firebase.google.com → **Add project**.
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** → *Production mode* → location `asia-southeast1` (Singapore).
4. **Firestore → Rules** → replace everything with the contents of `firestore.rules` → **Publish**.
   (If you use the Firebase CLI: `firebase deploy --only firestore:rules`.)
5. **Project settings (⚙) → Your apps → Web (`</>`)** → register the app → copy the config into `js/firebase-config.js`.

## 2. Create the first Administrator (one-time, by hand)
The app cannot create its own first admin, on purpose.
1. **Authentication → Users → Add user** (your email + a strong password). Copy the **User UID**.
2. **Firestore → Start collection** `users` → Document ID = **that UID** → fields:
   - `name` (string): your name
   - `email` (string): same email
   - `role` (string): `admin`
3. Sign in to the app. From **Admin / Teacher** you can create the other admin/teacher accounts.

## 3. Deploy on GitHub Pages
1. Put the contents of this folder in the **root** of a GitHub repo (`index.html` at the top level).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `(root)`.
3. Firebase → **Authentication → Settings → Authorized domains** → **Add domain** → `YOURUSERNAME.github.io`.
4. Recommended: Google Cloud Console → *APIs & Services → Credentials* → open the Browser key → **Application restrictions: HTTP referrers** → add `https://YOURUSERNAME.github.io/*` and `http://localhost:*`.
   (The web API key is not a secret, but this stops other sites from using your quota.)

## 4. Test locally first
The app uses ES modules, so opening `index.html` by double-click will **not** work. Run a tiny server:
```
python -m http.server 8000      # then open http://localhost:8000
```
(`localhost` is already an authorized domain. The camera works on `localhost` and on https.)

## 5. Smoke-test checklist (5 minutes)
- [ ] Sign in as admin → dashboard loads.
- [ ] Register a student with a **12-digit LRN** and a photo → ID and QR appear.
- [ ] In Edit System, set a scan window around the current time, then Scanner → Start Camera → scan the QR → the matching scan (e.g. **Morning IN**) is recorded with the time.
- [ ] Scan again in the same window → "already recorded today".
- [ ] Set "on time until" a few minutes in the past, scan another student → recorded as **Late** (orange). Move the windows away from now → scan is rejected as closed.
- [ ] Reports → today: green/orange boxes for scans done, grey for windows not finished, red once a window closes with no scan.
- [ ] Type a fake value (e.g. just the LRN) in USB/manual box → **Scan rejected**.
- [ ] Next day: the same student can be scanned again (new record; Reports shows both days).
- [ ] Admin → create a Teacher → sign in as teacher: sees Dashboard, Scanner, Reports only; no student details.
- [ ] Students → Edit → change section → saved. Delete → confirm → gone.
- [ ] Reports → This week → numbers + Download CSV + Print.

## Four scans a day (Morning IN/OUT, Afternoon IN/OUT)
- Admin → **Edit System** → *Scanning Schedule*: for each of the 4 scans set when it **opens** and **closes**. The two IN scans also have **On time until**: an IN scan after that minute is saved as **Late** (orange). OUT scans are never late.
- Defaults (Philippine time): Morning IN 5:00–10:00 (on time until 8:00) · Morning OUT 12:00–12:59 · Afternoon IN 1:00–3:00 PM (on time until 1:15) · Afternoon OUT 4:00–5:59 PM. Change them to the school's real times.
- A scan is accepted only while its window is open. Each scan can be recorded once per day. Scans are independent: a student who missed Morning OUT can still scan Afternoon IN (Morning OUT then shows **red**).
- Reports show 4 coloured boxes per student: **green** = recorded, **orange** = late IN, **red** = window closed with no scan, **grey** = window not finished yet today.
- The windows, dates and Late flag are enforced by the **Firestore rules** using Firebase's server clock, so you must re-publish `firestore.rules` after updating.
- **Upgrading from the earlier Time In/Time Out version?** Delete the old test documents in Firestore → `attendance` (they use the old format) before testing.

## Design notes
- **Roles** live in `users/{uid}.role` and are enforced by `firestore.rules` on the server, not just hidden in the UI.
- **QR** = `SLNHS:` + a random 192-bit token. The token → student lookup lives in Firestore (`qrTokens`), so QR codes can't be forged from an LRN. *Regenerate QR* invalidates a lost ID.
- **Attendance** = one document per student per day (`YYYY-MM-DD_LRN`), create-only. The rules also check that the date equals today's date in **Asia/Manila according to Firebase's server clock**, so a wrong device clock can't mis-date a record.
- **Privacy**: address, contact, guardian, adviser and photo are in `studentDetails`, readable by **admins only**. Teachers only see name, LRN, section and status.
- **Photos** are resized in the browser to 300×300 JPEG (~20–40 KB) and stored in `studentDetails` (avoids Cloud Storage, which needs the paid plan).
- **Deleting a student** removes their record, details and QR but **keeps past attendance rows** (so old reports stay correct). Use *Inactive* for transferees.
- **Free-tier reads**: each signed-in session reads all student docs once plus today's attendance. Fine for a pilot of a few hundred students; monitor *Usage* in the Firebase console if many users are online all day.
- To let only admins scan (instead of teachers too), change `ROLE_PERMISSIONS.teacher` in `js/app.js` and `allow get` / `allow create` in the `qrTokens` / `attendance` rules to `isAdmin()`.
