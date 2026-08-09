/* ─────────────────────────────────────────────────────────────
   Sync layer.

   Talks to the app through window.__today (a tiny bridge the app
   exposes) and to Firestore for storage. If there's no config, or the
   page is on file://, it does nothing at all and the app stays purely
   local — so a half-finished setup can never break the to-do list.

   Merge strategy: per item, by timestamp. Whole-document last-write-wins
   would let a phone edit clobber an unrelated PC edit made moments
   earlier; merging per item means both survive. Deletions travel as
   tombstones, otherwise a task deleted on one device is simply resurrected
   by the other device's copy on the next sync.
   ───────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var CFG = window.TODAY_FIREBASE;
  var bridge = window.__today;

  /* Sync used to fail invisibly — the page looked fine while nothing was
     being shared. Every state now shows in the footer. */
  function status(text, cls) {
    var el = document.getElementById("syncstate");
    if (el) { el.textContent = text; el.className = "syncstate" + (cls ? " " + cls : ""); }
  }

  function off(why) {
    console.info("[sync] off — " + why + ". Tasks stay on this device.");
    status("this device only", "warn");
  }

  if (!bridge)                                    return off("app bridge missing");
  if (!location.protocol.indexOf)                 return off("bad location");
  if (location.protocol.indexOf("http") !== 0)    return off("needs https, this is " + location.protocol);
  if (!CFG || !CFG.apiKey || /PASTE|YOUR_/.test(CFG.apiKey)) return off("not configured yet");

  var SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

  /* id -> { json, at }  : what we last knew each task to look like */
  var shadow = Object.create(null);
  /* id -> at            : tasks deleted locally, kept so the delete propagates */
  var tombs  = Object.create(null);
  var TOMB_TTL = 30 * 24 * 3600 * 1000;   // forget deletions after a month

  var remoteWrite = null;     // set once Firestore is ready
  var pushTimer = null;
  var applying = false;       // guard: don't echo a remote change back out

  function stamp(items) {
    var now = Date.now(), seen = Object.create(null), changed = false;
    items.forEach(function (t) {
      seen[t.id] = true;
      var json = JSON.stringify(t);
      if (!shadow[t.id] || shadow[t.id].json !== json) {
        shadow[t.id] = { json: json, at: now };
        changed = true;
      }
    });
    Object.keys(shadow).forEach(function (id) {
      if (!seen[id]) { delete shadow[id]; tombs[id] = now; changed = true; }
    });
    return changed;
  }

  function localPayload() {
    var items = [];
    Object.keys(shadow).forEach(function (id) {
      var t = JSON.parse(shadow[id].json);
      t._u = shadow[id].at;
      items.push(t);
    });
    var cutoff = Date.now() - TOMB_TTL, keep = {};
    Object.keys(tombs).forEach(function (id) { if (tombs[id] > cutoff) keep[id] = tombs[id]; });
    tombs = keep;
    return { items: items, tombs: tombs, updatedAt: Date.now() };
  }

  /* Returns the winning task list, and folds the remote state into our
     shadow so the next comparison is against the merged truth. */
  function merge(remote) {
    var best = Object.create(null);   // id -> { task, at }

    Object.keys(shadow).forEach(function (id) {
      best[id] = { task: JSON.parse(shadow[id].json), at: shadow[id].at };
    });

    (remote.items || []).forEach(function (t) {
      var at = t._u || 0, id = t.id;
      if (!id) return;
      var copy = JSON.parse(JSON.stringify(t));
      delete copy._u;
      if (!best[id] || at > best[id].at) best[id] = { task: copy, at: at };
    });

    var rt = remote.tombs || {};
    Object.keys(rt).forEach(function (id) {
      if (rt[id] > tombs[id] || !tombs[id]) tombs[id] = rt[id];
    });

    // a deletion wins only if it happened after the newest edit of that task
    Object.keys(tombs).forEach(function (id) {
      if (best[id] && tombs[id] >= best[id].at) delete best[id];
    });

    var out = Object.keys(best).map(function (id) { return best[id]; });
    // newest first, matching how the app prepends new tasks
    out.sort(function (a, b) { return b.at - a.at; });

    shadow = Object.create(null);
    out.forEach(function (e) {
      shadow[e.task.id] = { json: JSON.stringify(e.task), at: e.at };
    });
    return out.map(function (e) { return e.task; });
  }

  function schedulePush() {
    if (!remoteWrite) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { remoteWrite(localPayload()); }, 600);
  }

  Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js")
  ]).then(function (m) {
    start(m[0], m[1], m[2]);
  }).catch(function (e) {
    off("couldn't load Firebase (" + e.message + ")");
  });

  function start(appMod, authMod, dbMod) {
    var app  = appMod.initializeApp(CFG);
    var auth = authMod.getAuth(app);
    var db   = dbMod.getFirestore(app);

    authMod.setPersistence(auth, authMod.browserLocalPersistence).catch(function () {});

    /* Sign-in is popup-based and click-triggered, deliberately.

       signInWithRedirect cannot work here: this app is served from
       github.io while Firebase's auth handler lives on firebaseapp.com,
       and browsers now partition storage across those two origins, so the
       credential never makes it back — Google reports success and the app
       stays signed out. A popup hands the credential back through
       postMessage instead, which partitioning doesn't touch.

       It must be click-triggered because popups opened without a user
       gesture are blocked outright. */

    function needSignIn(why) {
      if (why) console.info("[sync] " + why);
      status("tap here to sign in", "warn");
      var el = document.getElementById("syncstate");
      if (el && !el._wired) {
        el._wired = true;
        el.style.cursor = "pointer";
        el.title = "Sign in with Google to sync this list across your devices";
        el.addEventListener("click", signIn);
      }
    }

    function signIn() {
      status("signing in…", "busy");
      authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider())
        .catch(function (e) {
          var code = (e && e.code) || "unknown";
          console.warn("[sync] popup sign-in failed:", code);
          if (code === "auth/popup-blocked" ||
              code === "auth/operation-not-supported-in-this-environment") {
            // Some in-app browsers can't do popups at all; redirect is the
            // only remaining option there even if it's less reliable.
            authMod.signInWithRedirect(auth, new authMod.GoogleAuthProvider());
          } else {
            needSignIn("sign-in cancelled (" + code + ")");
          }
        });
    }

    // Catch a returning redirect, for the fallback path above.
    authMod.getRedirectResult(auth).catch(function (e) {
      console.warn("[sync] redirect result:", e && e.code);
    });

    authMod.onAuthStateChanged(auth, function (user) {
      if (!user) { needSignIn("signed out"); return; }
      wire(user.uid);
    });

    function wire(uid) {
      var ref = dbMod.doc(db, "lists", uid);

      remoteWrite = function (payload) {
        dbMod.setDoc(ref, payload).then(function () {
          status("synced", "ok");
        }).catch(function (e) {
          console.warn("[sync] write failed", e.message);
          status("sync error: " + e.code, "warn");
        });
      };

      dbMod.onSnapshot(ref, function (snap) {
        var remote = snap.exists() ? snap.data() : { items: [], tombs: {} };
        var merged = merge(remote);
        var current = bridge.read();
        if (JSON.stringify(current) !== JSON.stringify(merged)) {
          applying = true;
          bridge.write(merged);
          applying = false;
        }
        status("synced", "ok");
        // if our local state carried anything the server lacked, send it up
        schedulePush();
      }, function (e) {
        console.warn("[sync] listen failed", e.message);
        status("sync error: " + e.code, "warn");
      });

      // seed the shadow from whatever is already on this device
      stamp(bridge.read());
      schedulePush();
      console.info("[sync] on — signed in as " + uid);
    }

    bridge.onLocalChange = function (items) {
      if (applying) return;
      if (stamp(items)) schedulePush();
    };
  }
})();
