# Getting Today onto your phone, synced with the PC

Everything here is free and needs no credit card. Nothing needs a command line.

Upload **all** files in this folder. Do not rename `index.html`.

---

## Part A — Put the app online (GitHub Pages, ~5 min)

1. Go to **github.com** and create a free account.
2. Click **+** (top right) → **New repository**.
   - Name: `today`
   - Visibility: **Public** (Pages is free only for public repos)
   - Click **Create repository**
3. On the empty repo page click **uploading an existing file**.
4. Drag in every file from `D:\Claude\todo\mobile\`:
   `index.html`, `sync.js`, `firebase-config.js`, `sw.js`,
   `manifest.webmanifest`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`
5. Click **Commit changes**.
6. Go to **Settings → Pages**. Under *Source* pick **Deploy from a branch**,
   branch **main**, folder **/ (root)**. Click **Save**.
7. Wait about a minute, then reload. Your address appears at the top:

   `https://YOURNAME.github.io/today/`

Open it. The app works right now — offline, on this device only. Sync comes next.

---

## Part B — Turn on sync (Firebase, ~10 min)

Use the Google account you already have.

1. Go to **console.firebase.google.com** → **Create a project**.
   Name it `today`. Turn **Google Analytics off** (not needed). Create.

2. **Authentication** → *Get started* → **Sign-in method** tab →
   **Google** → toggle **Enable** → pick your email as support email → **Save**.

3. **Authentication** → **Settings** tab → **Authorized domains** → **Add domain**
   → enter `YOURNAME.github.io` → Add.
   *Skip this and sign-in fails with an "unauthorized domain" error.*

4. **Firestore Database** → *Create database* → **Production mode** →
   choose the region closest to you → Enable.

5. Firestore → **Rules** tab. Replace everything with this, then **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /lists/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

   This is what keeps your list private: only you, signed in, can read or
   write your own document. Nobody else can, even knowing the project name.

6. **Project settings** (gear icon, top left) → scroll to **Your apps** →
   click the **web icon `</>`** → nickname `today` → **Register app**.
   It shows a `firebaseConfig = { ... }` block. Leave it on screen.

7. Back in your GitHub repo, click **`firebase-config.js`** → the **pencil**
   icon → replace the six `PASTE_...` values with the ones Firebase just
   showed you → **Commit changes**.

Give it a minute to redeploy, then reload the page. It will ask you to sign in
with Google once per device. After that your tasks sync automatically.

---

## Part C — Install it on the iPhone

1. Open `https://YOURNAME.github.io/today/` in **Safari**.
   Safari specifically — Chrome on iOS cannot install web apps.
2. Sign in with Google when asked.
3. **Share** button → scroll down → **Add to Home Screen** → **Add**.

You get the checkmark icon, no browser bars, and it opens without a signal.

---

## Part D — Point the PC at it

Tell Claude the URL and it will repoint your desktop shortcut. The window,
size and icon stay exactly as they are — only the address changes.

This step is required for sync: a page opened from `file://` is blocked by the
browser from talking to any server, so the local copy can never sync. The old
`D:\Claude\todo\index.html` stays put as an offline fallback.

---

## Notes

- **Before sync is configured** the app runs perfectly, just local to each
  device. Nothing breaks if you stop halfway.
- **Costs nothing.** Firebase's free Spark plan allows 50,000 reads a day; a
  to-do list uses a handful. There is no card on file to charge.
- **Editing offline** on both devices at once is handled: changes merge per
  task, not per list, so an edit on one device can't wipe an unrelated edit on
  the other. Deletions are remembered for 30 days so they don't come back.
- **To update the app later**, edit the file in GitHub and commit — both
  devices pick it up on next launch.
