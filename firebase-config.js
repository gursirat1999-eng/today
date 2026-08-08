/* ─────────────────────────────────────────────────────────────
   Paste your Firebase web config between the braces below.

   Firebase Console → your project → Project settings (gear icon) →
   "Your apps" → the Web app → "SDK setup and configuration" → Config.
   Copy the object it shows you and replace the whole block here.

   These values are not secrets — Google publishes them in every web app.
   What actually protects your tasks is the Firestore security rule, which
   only lets a signed-in person read and write their own list.

   Until this is filled in, the app simply runs offline on this device.
   ───────────────────────────────────────────────────────────── */
window.TODAY_FIREBASE = {
  apiKey:            "PASTE_YOUR_API_KEY",
  authDomain:        "PASTE_YOUR_PROJECT.firebaseapp.com",
  projectId:         "PASTE_YOUR_PROJECT",
  storageBucket:     "PASTE_YOUR_PROJECT.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId:             "PASTE_APP_ID"
};
