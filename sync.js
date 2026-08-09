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

  function off(why) { console.info("[sync] off — " + why + ". Tasks stay on this device."); }

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

    var TRIED = "todo.authtry";

    authMod.onAuthStateChanged(auth, function (user) {
      if (!user) {
        // Popups are blocked inside an installed iOS web app, so redirect.
        authMod.getRedirectResult(auth)
          .catch(function (e) { console.warn("[sync] sign-in failed:", e && e.message); })
          .then(function () {
            // Only ever attempt once per tab. Without this, a dismissed or
            // failed sign-in bounces straight back into another redirect and
            // the app reloads forever.
            var tried;
            try { tried = sessionStorage.getItem(TRIED); } catch (e) {}
            if (tried) { off("not signed in — reopen the app to try again"); return; }
            try { sessionStorage.setItem(TRIED, "1"); } catch (e) {}
            authMod.signInWithRedirect(auth, new authMod.GoogleAuthProvider());
          });
        return;
      }
      try { sessionStorage.removeItem(TRIED); } catch (e) {}
      wire(user.uid);
    });

    function wire(uid) {
      var ref = dbMod.doc(db, "lists", uid);

      remoteWrite = function (payload) {
        dbMod.setDoc(ref, payload).catch(function (e) {
          console.warn("[sync] write failed", e.message);
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
        // if our local state carried anything the server lacked, send it up
        schedulePush();
      }, function (e) {
        console.warn("[sync] listen failed", e.message);
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
