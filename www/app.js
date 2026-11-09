/* AAF eVote Station — offline voting for the Windows and Android apps.
 *
 * A teacher signs the device in while online and downloads the election for one school.
 * After that, pupils can sign in and vote with no internet. Votes are kept on the device
 * (IndexedDB) and sent to the server whenever it can be reached. The server keeps the
 * first vote it receives for each pupil; later ones come back as "duplicate".
 */
(function () {
  'use strict';

  var VERSION = '1.0.3';
  var DEFAULT_SERVER = 'https://aaf-evote.org';
  var SYNC_EVERY_MS = 20000;
  var BALLOT_IDLE_MS = 3 * 60 * 1000;
  var TEACHER_IDLE_MS = 5 * 60 * 1000;
  var KEY_ROUNDS = 150000;

  /* ------------------------------------------------------------------ state */

  var S = {
    cfg: null,          // { server, token, deviceId, user, schoolId, keySalt }
    pkg: null,          // election package without plaintext passcodes
    codesEnc: null,     // { iv, ct } passcodes encrypted with the teacher key
    serverVoted: new Set(),
    votes: [],          // local vote records
    offset: 0,          // server clock − device clock (ms)
    online: false,
    lastSync: null,
    stale: false,
    signedOut: false,
    key: null,          // AES key while the teacher area is unlocked
    codes: null,        // { pupilId: code } while unlocked
    tries: {},          // wrong passcode attempts per username
    syncing: false,
    idleTimer: null
  };

  var app = document.getElementById('app');
  var dlg = document.getElementById('dlg');

  /* ------------------------------------------------------------- storage */

  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('aaf-evote-station', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('votes')) d.createObjectStore('votes', { keyPath: 'uuid' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out;
        var r = fn(s);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  var kv = {
    get: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); },
    del: function (k) { return tx('kv', 'readwrite', function (s) { return s.delete(k); }); },
    clear: function () { return tx('kv', 'readwrite', function (s) { return s.clear(); }); }
  };
  var votesDb = {
    all: function () { return tx('votes', 'readonly', function (s) { return s.getAll(); }); },
    put: function (v) { return tx('votes', 'readwrite', function (s) { return s.put(v); }); },
    clear: function () { return tx('votes', 'readwrite', function (s) { return s.clear(); }); }
  };

  /* -------------------------------------------------------------- crypto */

  var enc = new TextEncoder(), dec = new TextDecoder();
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function b64(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s); }
  function unb64(str) { var s = atob(str), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = rand(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; var x = hex(b);
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }

  /** Same as the server's Stations::codeHash: PBKDF2-SHA256(CODE, salt|username) → 64 hex chars. */
  function codeHash(salt, username, code, rounds) {
    return crypto.subtle.importKey('raw', enc.encode(code.trim().toUpperCase()), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt + '|' + username.trim().toLowerCase()), iterations: rounds }, k, 256);
      }).then(hex);
  }
  function teacherKey(password, salt) {
    return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (k) {
        return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: KEY_ROUNDS }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function seal(key, obj) {
    var iv = rand(12);
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(obj)))
      .then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  function open(key, box) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct))
      .then(function (pt) { return JSON.parse(dec.decode(pt)); });
  }

  /* ----------------------------------------------------------------- net */

  function api(path, opts) {
    opts = opts || {};
    var server = (opts.server || S.cfg.server).replace(/\/+$/, '');
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || 20000);
    var headers = { 'Accept': 'application/json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    var token = opts.token || (S.cfg && S.cfg.token);
    if (token) { headers['Authorization'] = 'Bearer ' + token; headers['X-Station-Token'] = token; }
    return fetch(server + '/api/station/' + path, {
      method: opts.method || 'GET', headers: headers, signal: ctl ? ctl.signal : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store'
    }).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
        if (!r.ok || !j || j.ok === false) {
          var err = new Error((j && (j.message || firstError(j))) || ('The server answered ' + r.status + '.'));
          err.status = r.status; err.server = true; throw err;
        }
        return j;
      });
    }, function (e) {
      clearTimeout(timer);
      var err = new Error('Cannot reach the server. Check the internet connection and the server address.');
      err.network = true; err.cause = e; throw err;
    });
  }
  function firstError(j) { if (j && j.errors) { for (var k in j.errors) return j.errors[k][0]; } return null; }

  /* ------------------------------------------------------------- helpers */

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function now() { return Date.now() + S.offset; }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  function fmtTime(ms) { if (!ms) return '—'; var d = new Date(ms); return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  function fmtAgo(ms) { if (!ms) return 'never'; var s = Math.round((Date.now() - ms) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; return fmtTime(ms); }
  function fmtLeft(ms) {
    if (ms < 0) ms = 0; var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    if (d > 0) return d + 'd ' + hh + 'h ' + m + 'm';
    return (hh ? hh + 'h ' : '') + ('0' + m).slice(-2) + 'm ' + ('0' + ss).slice(-2) + 's';
  }
  function platform() { return (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || (window.station && window.station.platform) || 'web'; }
  function className(id) { if (!S.pkg || !id) return ''; var c = S.pkg.classes.find(function (x) { return x.id === id; }); return c ? c.name : ''; }

  function electionState() {
    var e = S.pkg && S.pkg.election; if (!e || !e.starts_at || !e.ends_at) return 'not_scheduled';
    var t = now(); if (t < e.starts_at) return 'not_started'; if (t > e.ends_at) return 'ended'; return 'open';
  }
  function localVoted(pupilId) {
    return S.votes.some(function (v) { return v.pupil_id === pupilId && v.election_id === S.pkg.election.id && v.status !== 'rejected'; });
  }
  function hasVoted(pupilId) { return S.serverVoted.has(pupilId) || localVoted(pupilId); }
  function pending() { return S.votes.filter(function (v) { return v.status === 'pending'; }); }

  function toast(msg, kind) {
    var t = document.createElement('div'); t.className = 'toast' + (kind ? ' toast--' + kind : ''); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.classList.add('is-in'); }, 10);
    setTimeout(function () { t.classList.remove('is-in'); setTimeout(function () { t.remove(); }, 400); }, 3800);
  }
  function busy(btn, on, label) {
    if (!btn) return; if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + h(label || 'Please wait…'); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function modal(html, onReady) {
    dlg.innerHTML = html; if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
    $$('[data-close]', dlg).forEach(function (b) { b.addEventListener('click', closeModal); });
    if (onReady) onReady(dlg);
  }
  function closeModal() { if (dlg.open) { try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } } dlg.innerHTML = ''; }
  function confirmBox(title, text, okLabel, danger) {
    return new Promise(function (res) {
      modal('<form method="dialog" class="dlg__body"><h3>' + h(title) + '</h3><p>' + h(text) + '</p><div class="row row--end">' +
        '<button type="button" class="btn btn--ghost" data-no>Cancel</button><button type="button" class="btn ' + (danger ? 'btn--red' : 'btn--blue') + '" data-yes>' + h(okLabel || 'OK') + '</button></div></form>', function (d) {
        $('[data-no]', d).onclick = function () { closeModal(); res(false); };
        $('[data-yes]', d).onclick = function () { closeModal(); res(true); };
      });
    });
  }

  /* ------------------------------------------------------------ top bar */

  function paintBar() {
    var net = $('#netPill');
    net.hidden = !S.cfg;
    net.className = 'pill ' + (S.signedOut ? 'pill--warn' : S.online ? 'pill--on' : 'pill--off');
    net.querySelector('span').textContent = S.signedOut ? 'Signed out' : S.online ? 'Online' : 'Offline';
    net.title = S.lastSync ? 'Last contact with the server: ' + fmtAgo(S.lastSync) : 'Not in contact with the server yet';
    var q = $('#queuePill'), n = pending().length;
    q.hidden = n === 0; q.textContent = n + ' to send'; q.className = 'pill pill--queue';
    $('#barSchool').textContent = S.pkg ? S.pkg.school.name : 'Voting station';
    $('#teacherBtn').hidden = !S.cfg || !S.pkg;
  }

  /* ---------------------------------------------------------------- sync */

  function applyServerClock(serverNow) {
    if (!serverNow) return;
    S.offset = serverNow - Date.now(); S.lastSync = Date.now();
    kv.set('clock', { offset: S.offset, at: S.lastSync });
  }

  function syncNow(manual) {
    if (!S.cfg || !S.cfg.token || S.syncing) return Promise.resolve();
    S.syncing = true;
    return api('status').then(function (st) {
      S.online = true; S.signedOut = false; applyServerClock(st.server_now);
      if (st.voted) { S.serverVoted = new Set(st.voted); kv.set('voted', st.voted); }
      if (S.pkg) {
        if (st.election && st.election.id === S.pkg.election.id) { S.pkg.election = st.election; }
        S.stale = !!(st.version && st.version !== S.pkg.version) || !!(st.election && st.election.id !== S.pkg.election.id);
        if (typeof st.school_open === 'boolean') S.pkg.school.open = st.school_open;
        kv.set('pkg', S.pkg);
      }
      return pushVotes();
    }).then(function (sent) {
      if (manual) toast(sent ? sent + ' vote' + (sent === 1 ? '' : 's') + ' sent to the server.' : 'Everything is up to date.', 'ok');
    }).catch(function (e) {
      if (e.status === 401) { S.signedOut = true; S.online = true; }
      else if (e.network) { S.online = false; }
      if (manual) toast(e.message, 'bad');
    }).then(function () { S.syncing = false; paintBar(); if (currentView === 'teacher') renderTeacher(); });
  }

  function pushVotes() {
    var list = pending().slice(0, 200);
    if (!list.length) return Promise.resolve(0);
    return api('sync', {
      method: 'POST', timeout: 45000,
      body: { votes: list.map(function (v) { return { uuid: v.uuid, pupil_id: v.pupil_id, election_id: v.election_id, cast_at: v.cast_at, choices: v.choices }; }) }
    }).then(function (r) {
      applyServerClock(r.server_now);
      if (r.voted) { S.serverVoted = new Set(r.voted); kv.set('voted', r.voted); }
      var byId = {}; S.votes.forEach(function (v) { byId[v.uuid] = v; });
      var jobs = [], sent = 0;
      (r.results || []).forEach(function (res) {
        var v = byId[res.uuid]; if (!v || res.result === 'retry') return;
        v.status = res.result; v.reason = res.reason || null; v.synced_at = Date.now();
        if (v.status === 'accepted') { v.choices = null; sent++; } // nothing secret stays on the device
        jobs.push(votesDb.put(v));
      });
      return Promise.all(jobs).then(function () { return pending().length && list.length === 200 ? pushVotes().then(function (n) { return sent + n; }) : sent; });
    });
  }

  /* ================================================================ SETUP */

  var currentView = '';

  function renderSetup(err) {
    currentView = 'setup';
    var server = (S.cfg && S.cfg.server) || DEFAULT_SERVER;
    var own = server.replace(/\/+$/, '') !== DEFAULT_SERVER;
    app.innerHTML =
      '<section class="card card--narrow">' +
      '<div class="card__head"><img src="logo.svg" alt="" class="hero-logo"><h1>Set up this voting station</h1>' +
      '<p class="muted">A teacher signs in once while there is internet. The election is then saved on this device so pupils can vote with no internet. Votes are sent to the school server when the internet comes back.</p></div>' +
      (err ? '<div class="alert alert--bad">' + h(err) + '</div>' : '') +
      '<form id="setupForm" class="form" autocomplete="off">' +
      '<fieldset class="where"><legend>Where does your school run AAF eVote?</legend>' +
      '<label class="where__opt"><input type="radio" name="where" value="cloud"' + (own ? '' : ' checked') + '><span><b>AAF eVote online</b><small>aaf-evote.org — most schools</small></span></label>' +
      '<label class="where__opt"><input type="radio" name="where" value="own"' + (own ? ' checked' : '') + '><span><b>Our school\'s own server</b><small>On-premises licence: on the school network or the school\'s website</small></span></label>' +
      '</fieldset>' +
      '<label id="ownWrap"' + (own ? '' : ' hidden') + '>Your server\'s address<input name="server" type="text" autocapitalize="none" spellcheck="false" value="' + h(own ? server : '') + '" inputmode="url" placeholder="http://192.168.1.10 or https://evote.myschool.ac.ug">' +
      '<small class="hint">The same address the school opens in a browser. Ask whoever installed it, or see INSTALL-GUIDE in the installation package.' + (/android/i.test(platform()) ? ' On Android the address must start with https://.' : '') + '</small></label>' +
      '<label>Teacher email or username<input name="login" required autocomplete="username"></label>' +
      '<label>Password<input name="password" type="password" required autocomplete="current-password"></label>' +
      '<p class="hint">Use the same email and password as on the website. Your password also locks the teacher area of this app.</p>' +
      '<button class="btn btn--blue btn--lg" type="submit">Sign in and download</button>' +
      '</form><p class="tiny muted center">AAF eVote Station ' + VERSION + ' · ' + h(platform()) + '</p></section>';
    $$('input[name=where]').forEach(function (r) {
      r.onchange = function () { var o = $('input[name=where]:checked').value === 'own'; $('#ownWrap').hidden = !o; if (o) $('#setupForm').server.focus(); };
    });
    $('#setupForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = ev.target, btn = $('button[type=submit]', f);
      var ownServer = $('input[name=where]:checked').value === 'own';
      var srv = ownServer ? f.server.value.trim().replace(/\/+$/, '') : DEFAULT_SERVER, login = f.login.value.trim(), pw = f.password.value;
      if (ownServer && !/^https?:\/\/[^\s\/]+/i.test(srv)) {
        if (/^[^\s\/]+(\/|$)/.test(srv)) { srv = 'http://' + srv; } else { renderSetup('Type your server\'s address, for example http://192.168.1.10'); return; }
      }
      busy(btn, true, 'Signing in…');
      kv.get('device').then(function (dev) {
        dev = dev || uuid(); kv.set('device', dev);
        return api('login', { server: srv, method: 'POST', body: { login: login, password: pw, device_id: dev, device_name: deviceName(), platform: platform() } })
          .then(function (r) {
            applyServerClock(r.server_now);
            var cfg = { server: srv, token: r.token, deviceId: dev, user: r.user, schoolId: null, keySalt: b64(rand(16)) };
            if (r.schools.length === 1) { cfg.schoolId = r.schools[0].id; return download(cfg, pw, btn); }
            chooseSchool(cfg, pw, r.schools);
          });
      }).catch(function (e) { busy(btn, false); renderSetup(e.message); });
    });
  }

  function deviceName() {
    var ua = navigator.userAgent, m = ua.match(/Android [\d.]+; ([^;)]+)/);
    return (m ? m[1] : (/Windows/.test(ua) ? 'Windows PC' : 'Device')).slice(0, 100);
  }

  function chooseSchool(cfg, pw, schools) {
    app.innerHTML = '<section class="card card--narrow"><h1>Which school is this station for?</h1>' +
      '<div class="list">' + schools.map(function (s) {
        return '<button class="list__item" data-id="' + s.id + '"' + (s.active ? '' : ' disabled') + '><b>' + h(s.name) + '</b>' + (s.active ? '' : '<span class="tag tag--red">switched off</span>') + '</button>';
      }).join('') + '</div></section>';
    $$('[data-id]').forEach(function (b) {
      b.onclick = function () { cfg.schoolId = +b.dataset.id; busy(b, true, 'Downloading…'); download(cfg, pw, b).catch(function (e) { renderSetup(e.message); }); };
    });
  }

  function download(cfg, pw, btn) {
    busy(btn, true, 'Downloading the election…');
    return api('package?school_id=' + encodeURIComponent(cfg.schoolId), { server: cfg.server, token: cfg.token, timeout: 120000 })
      .then(function (pkg) {
        return teacherKey(pw, unb64(cfg.keySalt)).then(function (key) { return savePackage(cfg, pkg, key); });
      }).then(function () { toast('This device is ready for voting.', 'ok'); route(); });
  }

  /** Keep passcodes only in encrypted form; everything else is saved as it came. */
  function savePackage(cfg, pkg, key) {
    var codes = {};
    pkg.pupils.forEach(function (p) { if (p.code) codes[p.id] = p.code; delete p.code; });
    applyServerClock(pkg.server_now);
    return seal(key, codes).then(function (box) {
      S.cfg = cfg; S.pkg = pkg; S.codesEnc = box; S.stale = false; S.signedOut = false; S.online = true;
      S.serverVoted = new Set(pkg.voted || []);
      if (S.key) { S.codes = codes; }
      return Promise.all([kv.set('cfg', cfg), kv.set('pkg', pkg), kv.set('codes', box), kv.set('voted', pkg.voted || [])]);
    });
  }

  /* ========================================================= PUPIL: SIGN IN */

  var clockTimer = null;

  function renderHome(msg) {
    currentView = 'home'; lockTeacher();
    var e = S.pkg.election, st = electionState();
    var closed = S.pkg.school.open === false;
    var banner = '';
    if (closed) banner = '<div class="alert alert--bad">Voting for this school is switched off right now. Please ask your teacher.</div>';
    else if (st === 'not_started') banner = '<div class="alert alert--info">Voting opens on <b>' + h(fmtTime(e.starts_at)) + '</b>.</div>';
    else if (st === 'ended') banner = '<div class="alert alert--info">Voting has ended. Thank you, everyone!</div>';
    else if (st === 'not_scheduled') banner = '<div class="alert alert--info">The voting time has not been set yet.</div>';
    var canVote = st === 'open' && !closed;

    app.innerHTML =
      '<section class="home">' +
      '<div class="card card--hero">' +
      '<span class="eyebrow">' + h(e.name) + '</span>' +
      '<h1>Welcome! Ready to vote?</h1>' +
      '<p class="muted">Type the <b>username</b> and <b>passcode</b> from your slip.</p>' +
      '<div id="countdown" class="countdown"></div>' +
      '</div>' +
      '<div class="card card--narrow">' + banner + (msg ? '<div class="alert alert--' + (msg.kind || 'bad') + '">' + h(msg.text) + '</div>' : '') +
      '<form id="pupilForm" class="form" autocomplete="off">' +
      '<label>Username<input name="username" required autocapitalize="off" autocomplete="off" spellcheck="false" inputmode="text"' + (canVote ? ' autofocus' : ' disabled') + '></label>' +
      '<label>Passcode<input name="passcode" required autocapitalize="characters" autocomplete="off" spellcheck="false" class="code-input"' + (canVote ? '' : ' disabled') + '></label>' +
      '<button class="btn btn--green btn--lg" type="submit"' + (canVote ? '' : ' disabled') + '>Start voting →</button>' +
      '</form></div></section>';
    tickCountdown();
    $('#pupilForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var f = ev.target, btn = $('button', f);
      busy(btn, true, 'Checking…');
      pupilSignIn(f.username.value, f.passcode.value).then(function (res) {
        if (res.pupil) return startBallot(res.pupil);
        renderHome({ text: res.error, kind: res.kind });
      }).catch(function (e) { busy(btn, false); renderHome({ text: 'Something went wrong: ' + e.message }); });
    });
  }

  function tickCountdown() {
    var el = $('#countdown'); if (!el || !S.pkg) return;
    var e = S.pkg.election, st = electionState(), t = now();
    if (st === 'not_started') el.innerHTML = '<span>Voting opens in</span><b>' + fmtLeft(e.starts_at - t) + '</b>';
    else if (st === 'open') el.innerHTML = '<span>Voting closes in</span><b' + (e.ends_at - t < 600000 ? ' class="urgent"' : '') + '>' + fmtLeft(e.ends_at - t) + '</b>';
    else el.innerHTML = '';
  }

  function pupilSignIn(username, passcode) {
    username = username.trim(); passcode = passcode.trim();
    var key = username.toLowerCase(), t = S.tries[key];
    if (t && t.until > Date.now()) return Promise.resolve({ error: 'Too many tries. Please wait ' + Math.ceil((t.until - Date.now()) / 1000) + ' seconds and ask your teacher for help.' });
    if (S.pkg.school.open === false) return Promise.resolve({ error: 'Voting for this school is switched off right now. Please ask your teacher.' });
    if (electionState() !== 'open') return Promise.resolve({ error: 'Voting is not open right now.' });
    var pupil = S.pkg.pupils.find(function (p) { return String(p.username).toLowerCase() === key; });
    var fail = function () {
      t = S.tries[key] = S.tries[key] || { n: 0, until: 0 }; t.n++;
      if (t.n >= 5) { t.n = 0; t.until = Date.now() + 60000; }
      return { error: 'That username or passcode is not right. Please check your slip and try again.' };
    };
    if (!pupil || !pupil.hash) {
      return codeHash(S.pkg.code_salt, username, passcode || 'x', S.pkg.code_rounds).then(fail); // same delay either way
    }
    return codeHash(S.pkg.code_salt, pupil.username, passcode, S.pkg.code_rounds).then(function (hsh) {
      if (hsh !== pupil.hash) return fail();
      delete S.tries[key];
      if (hasVoted(pupil.id)) return { error: 'You have already voted, ' + pupil.name.split(' ')[0] + '. Thank you!', kind: 'ok' };
      return { pupil: pupil };
    });
  }

  /* ============================================================= BALLOT */

  var B = null; // { pupil, i, choices }
  var ballotIdle = null;

  function startBallot(pupil) {
    B = { pupil: pupil, i: 0, choices: {} };
    renderPost();
  }
  function touchBallot() {
    clearTimeout(ballotIdle);
    ballotIdle = setTimeout(function () { if (B) { B = null; renderHome({ text: 'You were away for a while, so the ballot was closed. Nothing was saved. Please start again.', kind: 'info' }); } }, BALLOT_IDLE_MS);
  }

  function renderPost() {
    currentView = 'ballot'; touchBallot();
    var posts = S.pkg.posts, post = posts[B.i], total = posts.length, chosen = B.choices[post.id];
    app.innerHTML =
      '<section class="ballot">' +
      '<div class="ballot__top"><div><span class="eyebrow">Hello, ' + h(B.pupil.name.split(' ')[0]) + '!</span>' +
      '<h2>' + h(post.name) + '</h2><p class="muted">Tap the person you want for <b>' + h(post.name.toLowerCase()) + '</b>.</p></div>' +
      '<button class="btn btn--ghost btn--sm" id="quit">Cancel</button></div>' +
      '<div class="progress" aria-label="Post ' + (B.i + 1) + ' of ' + total + '"><i style="width:' + Math.round((B.i + 1) / total * 100) + '%"></i><span>' + (B.i + 1) + ' of ' + total + '</span></div>' +
      '<div class="cands" role="radiogroup" aria-label="' + h(post.name) + '">' + post.candidates.map(function (c) {
        return '<button class="cand' + (chosen === c.id ? ' is-on' : '') + '" role="radio" aria-checked="' + (chosen === c.id) + '" data-id="' + c.id + '">' +
          '<span class="cand__photo">' + (c.photo ? '<img src="' + h(c.photo) + '" alt="">' : '<span class="cand__init">' + h(initials(c.name)) + '</span>') + '<span class="cand__tick">✓</span></span>' +
          '<b>' + h(c.name) + '</b>' + (c.class ? '<span class="muted">' + h(c.class) + '</span>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div class="ballot__nav">' +
      (B.fromReview ? '<button class="btn btn--ghost" id="back">‹ Back to my choices</button>' : (B.i > 0 ? '<button class="btn btn--ghost" id="back">‹ Back</button>' : '<span></span>')) +
      (chosen ? '<button class="btn btn--ghost" id="clear">Clear</button>' : '') +
      '<button class="btn ' + (chosen ? 'btn--green' : 'btn--ghost') + ' btn--lg" id="next">' + (chosen ? (B.fromReview || B.i + 1 >= total ? 'Check my choices ›' : 'Next ›') : 'Skip this post ›') + '</button>' +
      '</div></section>';
    var busyTap = false;
    // One tap chooses the person, shows the tick, then moves on by itself.
    $$('.cand').forEach(function (el) {
      el.onclick = function () {
        if (busyTap) return; busyTap = true;
        B.choices[post.id] = +el.dataset.id;
        $$('.cand').forEach(function (x) { var on = x === el; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', on); });
        setTimeout(goOn, 420);
      };
    });
    function goOn() {
      if (B.fromReview) return renderReview(post.id);
      if (B.i + 1 < total) { B.i++; renderPost(); } else renderReview();
    }
    $('#next').onclick = goOn;
    if ($('#clear')) $('#clear').onclick = function () { delete B.choices[post.id]; renderPost(); };
    if ($('#back')) $('#back').onclick = function () { if (B.fromReview) return renderReview(post.id); B.i--; renderPost(); };
    $('#quit').onclick = quitBallot;
    window.scrollTo(0, 0);
  }

  function quitBallot() {
    confirmBox('Stop voting?', 'Your choices will not be saved. You can start again with your slip.', 'Stop', true).then(function (ok) { if (ok) { B = null; clearTimeout(ballotIdle); renderHome(); } });
  }

  function renderReview(focusPostId) {
    currentView = 'ballot'; touchBallot(); B.fromReview = false;
    var n = Object.keys(B.choices).length;
    app.innerHTML =
      '<section class="ballot"><div class="ballot__top"><div><span class="eyebrow">Almost done</span><h2>Check your choices</h2>' +
      '<p class="muted">If something is wrong, tap <b>Change</b>. When you are happy, tap <b>Cast my vote</b>.</p></div>' +
      '<button class="btn btn--ghost btn--sm" id="quit">Cancel</button></div>' +
      '<div class="review">' + S.pkg.posts.map(function (p, i) {
        var c = p.candidates.find(function (x) { return x.id === B.choices[p.id]; });
        return '<div class="review__row' + (p.id === focusPostId ? ' is-flash' : '') + '" data-post="' + p.id + '"><span class="review__post">' + h(p.name) + '</span>' +
          (c ? '<span class="review__who">' + (c.photo ? '<img src="' + h(c.photo) + '" alt="">' : '<span class="cand__init cand__init--sm">' + h(initials(c.name)) + '</span>') + '<b>' + h(c.name) + '</b></span>' : '<span class="tag">Skipped</span>') +
          '<button class="btn btn--ghost btn--sm" data-go="' + i + '">Change</button></div>';
      }).join('') + '</div>' +
      (n ? '' : '<div class="alert alert--bad">Please choose at least one person before casting your vote.</div>') +
      '<div class="ballot__nav"><button class="btn btn--ghost" id="back">‹ Back</button>' +
      '<button class="btn btn--green btn--lg" id="cast"' + (n ? '' : ' disabled') + '>Cast my vote ✓</button></div></section>';
    $$('[data-go]').forEach(function (b) { b.onclick = function () { B.i = +b.dataset.go; B.fromReview = true; renderPost(); }; });
    $('#back').onclick = function () { B.i = S.pkg.posts.length - 1; renderPost(); };
    $('#quit').onclick = quitBallot;
    $('#cast').onclick = function () { castVote(this); };
    var focus = focusPostId && $('.review__row[data-post="' + focusPostId + '"]');
    if (focus) focus.scrollIntoView({ block: 'center' }); else window.scrollTo(0, 0);
  }

  function castVote(btn) {
    if (!B) return;
    if (hasVoted(B.pupil.id)) { B = null; return renderHome({ text: 'You have already voted. Thank you!', kind: 'ok' }); }
    if (electionState() !== 'open') { B = null; return renderHome({ text: 'Voting has closed, so this vote could not be saved.' }); }
    busy(btn, true, 'Saving…');
    var v = {
      uuid: uuid(), pupil_id: B.pupil.id, pupil_name: B.pupil.name, class_id: B.pupil.class_id,
      election_id: S.pkg.election.id, choices: B.choices, cast_at: Math.round(now()), device_time: Date.now(),
      status: 'pending', reason: null, synced_at: null
    };
    votesDb.put(v).then(function () {
      S.votes.push(v); B = null; clearTimeout(ballotIdle); paintBar(); renderThanks();
      syncNow(false);
    }).catch(function (e) { busy(btn, false); toast('Could not save the vote on this device: ' + e.message, 'bad'); });
  }

  function renderThanks() {
    currentView = 'thanks';
    app.innerHTML = '<section class="card card--narrow thanks"><div class="thanks__tick">✓</div><h1>Thank you for voting!</h1>' +
      '<p>Your vote has been saved.</p><p class="muted">Your choices are secret. Nobody can see who you voted for.</p>' +
      '<button class="btn btn--blue btn--lg" id="done">Next pupil</button><p class="tiny muted" id="thanksLeft"></p></section>';
    var left = 8, el = $('#thanksLeft');
    var t = setInterval(function () { left--; if (el) el.textContent = 'Going back in ' + left + '…'; if (left <= 0) { clearInterval(t); if (currentView === 'thanks') renderHome(); } }, 1000);
    $('#done').onclick = function () { clearInterval(t); renderHome(); };
  }

  /* =========================================================== TEACHER */

  var tTab = 'overview', tSearch = '', tClass = '', revealed = {};

  function lockTeacher() { S.key = null; S.codes = null; revealed = {}; clearTimeout(S.idleTimer); }
  function touchTeacher() { clearTimeout(S.idleTimer); S.idleTimer = setTimeout(function () { if (currentView === 'teacher') { renderHome(); toast('The teacher area was locked.', 'info'); } }, TEACHER_IDLE_MS); }

  function askTeacher() {
    if (B) return toast('A pupil is voting. Wait until they finish.', 'info');
    modal('<form class="dlg__body" id="unlock"><h3>Teacher area</h3><p class="muted">Type the password of <b>' + h(S.cfg.user.name) + '</b>, the teacher who set up this device.</p>' +
      '<label class="form">Password<input type="password" name="pw" required autocomplete="current-password"></label><p class="err" hidden></p>' +
      '<div class="row row--end"><button type="button" class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--blue">Open</button></div></form>', function (d) {
      var f = $('#unlock', d); f.pw.focus();
      f.onsubmit = function (ev) {
        ev.preventDefault(); var btn = $('.btn--blue', f); busy(btn, true, 'Checking…');
        teacherKey(f.pw.value, unb64(S.cfg.keySalt)).then(function (key) {
          return open(key, S.codesEnc).then(function (codes) { S.key = key; S.codes = codes; closeModal(); tTab = 'overview'; renderTeacher(); });
        }).catch(function () { busy(btn, false); var e = $('.err', f); e.hidden = false; e.textContent = 'That password is not right.'; f.pw.select(); });
      };
    });
  }

  function stats() {
    var pupils = S.pkg.pupils, byClass = {};
    pupils.forEach(function (p) {
      var k = p.class_id || 0; byClass[k] = byClass[k] || { name: className(p.class_id) || 'No class set', total: 0, voted: 0 };
      byClass[k].total++; if (hasVoted(p.id)) byClass[k].voted++;
    });
    var mine = S.votes.filter(function (v) { return v.election_id === S.pkg.election.id; });
    return {
      total: pupils.length,
      voted: pupils.filter(function (p) { return hasVoted(p.id); }).length,
      pending: pending().length,
      here: mine.filter(function (v) { return v.status !== 'rejected'; }).length,
      problems: mine.filter(function (v) { return v.status === 'duplicate' || v.status === 'rejected'; }),
      classes: Object.keys(byClass).map(function (k) { return byClass[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name); })
    };
  }

  function renderTeacher() {
    if (!S.key) return renderHome();
    currentView = 'teacher'; touchTeacher();
    var tabs = [['overview', 'Overview'], ['pupils', 'Pupils'], ['slips', 'Print slips'], ['device', 'This device']];
    app.innerHTML = '<section class="teacher">' +
      '<div class="teacher__head"><div><span class="eyebrow">Teacher area · ' + h(S.cfg.user.name) + '</span><h2>' + h(S.pkg.election.name) + '</h2></div>' +
      '<button class="btn btn--green" id="toVoting">Back to voting</button></div>' +
      (S.signedOut ? '<div class="alert alert--bad">The server signed this device out (password changed or device removed). Votes are kept. Use <b>This device → Sign in again</b>.</div>' : '') +
      (S.stale ? '<div class="alert alert--info">The election changed on the server (pupils, candidates, passcodes or times). <button class="btn btn--blue btn--sm" id="refreshTop">Download the latest</button></div>' : '') +
      '<nav class="tabs">' + tabs.map(function (t) { return '<button data-tab="' + t[0] + '" class="' + (tTab === t[0] ? 'is-on' : '') + '">' + t[1] + '</button>'; }).join('') + '</nav>' +
      '<div id="tBody"></div></section>';
    $('#toVoting').onclick = function () { renderHome(); };
    $$('[data-tab]').forEach(function (b) { b.onclick = function () { tTab = b.dataset.tab; renderTeacher(); }; });
    if ($('#refreshTop')) $('#refreshTop').onclick = function () { refreshPackage(this); };
    ({ overview: tOverview, pupils: tPupils, slips: tSlips, device: tDevice })[tTab]($('#tBody'));
  }

  function tOverview(el) {
    var s = stats(), pct = s.total ? Math.round(s.voted / s.total * 100) : 0, e = S.pkg.election;
    el.innerHTML =
      '<div class="tiles">' +
      tile('Pupils on the list', s.total) + tile('Have voted', s.voted + ' <small>(' + pct + '%)</small>') +
      tile('Voted on this device', s.here) + tile('Waiting to send', s.pending, s.pending ? 'warn' : '') + '</div>' +
      '<div class="card"><div class="row row--between"><h3>Turnout by class</h3><span class="muted small">Opens ' + h(fmtTime(e.starts_at)) + ' · closes ' + h(fmtTime(e.ends_at)) + '</span></div>' +
      '<table class="tbl"><thead><tr><th>Class</th><th>Pupils</th><th>Voted</th><th style="width:40%"></th></tr></thead><tbody>' +
      s.classes.map(function (c) { var p = c.total ? Math.round(c.voted / c.total * 100) : 0; return '<tr><td>' + h(c.name) + '</td><td>' + c.total + '</td><td>' + c.voted + '</td><td><div class="meter"><i style="width:' + p + '%"></i></div></td></tr>'; }).join('') +
      '</tbody></table></div>' +
      '<div class="card"><div class="row row--between"><h3>Sending votes</h3><button class="btn btn--blue btn--sm" id="syncBtn">Send now</button></div>' +
      '<p class="muted">Last contact with the server: <b>' + h(fmtAgo(S.lastSync)) + '</b>. ' + (S.online ? 'The server can be reached.' : 'No internet right now; votes stay safe on this device and are sent automatically later.') + '</p>' +
      (s.problems.length ? '<h4>Votes the server did not count (' + s.problems.length + ')</h4><p class="muted small">The server keeps the first vote it receives for each pupil. These came later, or were not valid.</p>' +
        '<table class="tbl"><thead><tr><th>Pupil</th><th>Class</th><th>Voted here at</th><th>Why</th></tr></thead><tbody>' +
        s.problems.map(function (v) { return '<tr><td>' + h(v.pupil_name) + '</td><td>' + h(className(v.class_id)) + '</td><td>' + h(fmtTime(v.cast_at)) + '</td><td><span class="tag ' + (v.status === 'duplicate' ? 'tag--warn' : 'tag--red') + '">' + h(v.status === 'duplicate' ? 'Already voted' : 'Not valid') + '</span> ' + h(v.reason || '') + '</td></tr>'; }).join('') + '</tbody></table>' : '') +
      '</div>';
    $('#syncBtn').onclick = function () { var b = this; busy(b, true, 'Sending…'); syncNow(true); };
  }
  function tile(label, val, kind) { return '<div class="tile' + (kind ? ' tile--' + kind : '') + '"><span>' + h(label) + '</span><b>' + val + '</b></div>'; }

  function pupilStatus(p) {
    var v = S.votes.filter(function (x) { return x.pupil_id === p.id && x.election_id === S.pkg.election.id; });
    if (v.some(function (x) { return x.status === 'pending'; })) return '<span class="tag tag--warn">Voted · waiting to send</span>';
    if (S.serverVoted.has(p.id)) return '<span class="tag tag--green">Voted</span>';
    if (v.some(function (x) { return x.status === 'accepted'; })) return '<span class="tag tag--green">Voted</span>';
    return '<span class="tag">Not yet</span>';
  }

  function tPupils(el) {
    var q = tSearch.toLowerCase();
    var list = S.pkg.pupils.filter(function (p) {
      return (!tClass || String(p.class_id || 0) === tClass) && (!q || p.name.toLowerCase().indexOf(q) >= 0 || String(p.username).toLowerCase().indexOf(q) >= 0);
    });
    el.innerHTML = '<div class="card"><div class="row filters">' +
      '<input id="pq" type="search" placeholder="Search name or username" value="' + h(tSearch) + '">' + classSelect('pc', tClass) +
      '<span class="muted small">' + list.length + ' pupils</span></div>' +
      '<table class="tbl tbl--pupils"><thead><tr><th>Pupil</th><th>Class</th><th>Username</th><th>Passcode</th><th>Status</th></tr></thead><tbody>' +
      list.slice(0, 400).map(function (p) {
        var code = S.codes[p.id];
        return '<tr><td><b>' + h(p.name) + '</b></td><td>' + h(className(p.class_id)) + '</td><td class="mono">' + h(p.username) + '</td>' +
          '<td>' + (code ? (revealed[p.id] ? '<span class="mono code">' + h(code) + '</span> ' : '') + '<button class="btn btn--ghost btn--xs" data-show="' + p.id + '">' + (revealed[p.id] ? 'Hide' : 'Show') + '</button> <button class="btn btn--ghost btn--xs" data-slip="' + p.id + '">Slip</button>' : '<span class="muted small">No passcode. Make one on the website.</span>') + '</td>' +
          '<td>' + pupilStatus(p) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var pq = $('#pq');
    pq.oninput = function () { tSearch = pq.value; var pos = pq.selectionStart; tPupils(el); var n = $('#pq'); n.focus(); n.setSelectionRange(pos, pos); touchTeacher(); };
    $('#pc').onchange = function () { tClass = this.value; tPupils(el); };
    $$('[data-show]', el).forEach(function (b) { b.onclick = function () { var id = +b.dataset.show; revealed[id] = !revealed[id]; tPupils(el); }; });
    $$('[data-slip]', el).forEach(function (b) { b.onclick = function () { printSlips([S.pkg.pupils.find(function (p) { return p.id === +b.dataset.slip; })]); }; });
  }

  function classSelect(id, val) {
    var seen = {}, opts = S.pkg.pupils.map(function (p) { return p.class_id || 0; }).filter(function (c) { if (seen[c]) return false; seen[c] = 1; return true; })
      .map(function (c) { return [String(c), className(c) || 'No class set']; }).sort(function (a, b) { return a[1].localeCompare(b[1]); });
    return '<select id="' + id + '"><option value="">All classes</option>' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (val === o[0] ? ' selected' : '') + '>' + h(o[1]) + '</option>'; }).join('') + '</select>';
  }

  function tSlips(el) {
    el.innerHTML = '<div class="card"><h3>Print login slips</h3><p class="muted">Each slip has the pupil\'s username and passcode. Cut them out and give each pupil their own slip. Keep spare slips locked away.</p>' +
      '<div class="row filters">' + classSelect('sc', tClass) + '<label class="check"><input type="checkbox" id="sOnly" checked> Only pupils who have not voted</label></div>' +
      '<div class="row"><button class="btn btn--blue" id="sPrint">Print slips</button><span class="muted small" id="sCount"></span></div>' +
      (platform() === 'web' ? '' : '<p class="tiny muted">Choose a printer, or "Save as PDF", in the print window.</p>') + '</div>';
    var pick = function () {
      var c = $('#sc').value, only = $('#sOnly').checked;
      return S.pkg.pupils.filter(function (p) { return S.codes[p.id] && (!c || String(p.class_id || 0) === c) && (!only || !hasVoted(p.id)); });
    };
    var count = function () { $('#sCount').textContent = pick().length + ' slips'; };
    $('#sc').onchange = function () { tClass = this.value; count(); }; $('#sOnly').onchange = count; count();
    $('#sPrint').onclick = function () { var l = pick(); if (!l.length) return toast('No slips to print.', 'info'); printSlips(l); };
  }

  function printSlips(list) {
    var area = document.getElementById('printArea'), e = S.pkg.election;
    area.innerHTML = '<div class="slips">' + list.map(function (p) {
      return '<div class="slip"><div class="slip__head"><img src="logo.svg" alt=""><div><b>' + h(S.pkg.school.name) + '</b><span>' + h(e.name) + '</span></div></div>' +
        '<div class="slip__name">' + h(p.name) + (p.class_id ? ' <small>' + h(className(p.class_id)) + '</small>' : '') + '</div>' +
        '<div class="slip__grid"><span>Username</span><b>' + h(p.username) + '</b><span>Passcode</span><b>' + h(S.codes[p.id]) + '</b></div>' +
        '<div class="slip__foot">Type your username and passcode, choose one person for each post, then tap Cast my vote. Keep your passcode secret.</div></div>';
    }).join('') + '</div>';
    var go = function () {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StationPrint) {
        window.Capacitor.Plugins.StationPrint.print({ name: 'AAF eVote slips' }).catch(function (e) { toast('Printing is not available: ' + e.message, 'bad'); });
      } else { window.print(); }
    };
    var imgs = $$('img', area), n = imgs.length;
    if (!n) return go();
    imgs.forEach(function (i) { if (i.complete) { if (--n === 0) go(); } else i.onload = i.onerror = function () { if (--n === 0) go(); }; });
  }

  function tDevice(el) {
    var p = pending().length;
    el.innerHTML = '<div class="card"><h3>This device</h3><table class="tbl tbl--kv">' +
      '<tr><th>School</th><td>' + h(S.pkg.school.name) + '</td></tr>' +
      '<tr><th>Server</th><td class="mono">' + h(S.cfg.server) + '</td></tr>' +
      (S.pkg.plan && S.pkg.plan.label ? '<tr><th>Plan</th><td><span class="tag ' + ({ active: 'tag--green', onprem: 'tag--green', trial: 'tag--blue', grace: 'tag--warn', expired: 'tag--red' }[S.pkg.plan.state] || '') + '">' + h(S.pkg.plan.label) + '</span> <span class="muted small">' + h(S.pkg.plan.detail || '') + '</span></td></tr>' : '') +
      '<tr><th>Set up by</th><td>' + h(S.cfg.user.name) + '</td></tr>' +
      '<tr><th>Election downloaded</th><td>' + h(S.pkg.election.name) + ' · ' + S.pkg.pupils.length + ' pupils · ' + S.pkg.posts.length + ' posts</td></tr>' +
      '<tr><th>Clock</th><td>' + h(new Date(now()).toLocaleString()) + ' <span class="muted small">(server time; this device is ' + Math.round(Math.abs(S.offset) / 1000) + 's ' + (S.offset >= 0 ? 'behind' : 'ahead') + ')</span></td></tr>' +
      '<tr><th>App</th><td>AAF eVote Station ' + VERSION + ' · ' + h(platform()) + '</td></tr></table>' +
      '<div class="row">' +
      '<button class="btn btn--blue" id="dRefresh">Download the latest election</button>' +
      (S.signedOut ? '<button class="btn btn--blue" id="dRelogin">Sign in again</button>' : '') +
      '<button class="btn btn--ghost" id="dBackup">Save a backup of votes</button>' +
      '<button class="btn btn--red" id="dReset"' + (p ? ' disabled title="Send all votes first"' : '') + '>Sign out this device</button></div>' +
      (p ? '<p class="muted small">This device still has ' + p + ' vote' + (p === 1 ? '' : 's') + ' to send. Connect to the internet and send them before signing out.</p>' : '') + '</div>';
    $('#dRefresh').onclick = function () { refreshPackage(this); };
    $('#dBackup').onclick = backupVotes;
    if ($('#dRelogin')) $('#dRelogin').onclick = relogin;
    $('#dReset').onclick = function () {
      confirmBox('Sign out this device?', 'The election, passcodes and vote history will be removed from this device. Pupils will not be able to vote here until a teacher sets it up again.', 'Sign out', true).then(function (ok) {
        if (!ok) return;
        api('logout', { method: 'POST' }).catch(function () {}).then(function () { return Promise.all([kv.del('cfg'), kv.del('pkg'), kv.del('codes'), kv.del('voted'), votesDb.clear()]); })
          .then(function () { S.cfg = null; S.pkg = null; S.codesEnc = null; S.votes = []; lockTeacher(); paintBar(); renderSetup(); });
      });
    };
  }

  function refreshPackage(btn) {
    busy(btn, true, 'Downloading…');
    api('package?school_id=' + encodeURIComponent(S.cfg.schoolId), { timeout: 120000 })
      .then(function (pkg) { return savePackage(S.cfg, pkg, S.key); })
      .then(function () { toast('The latest election is now on this device.', 'ok'); return syncNow(false); })
      .catch(function (e) { if (e.status === 401) S.signedOut = true; toast(e.message, 'bad'); })
      .then(function () { paintBar(); if (currentView === 'teacher') renderTeacher(); });
  }

  /** Signed out by the server but votes are waiting: sign in again without losing anything. */
  function relogin() {
    modal('<form class="dlg__body" id="re"><h3>Sign in again</h3><p class="muted">Use a teacher account for <b>' + h(S.pkg.school.name) + '</b>. Votes on this device are kept.</p>' +
      '<label class="form">Email or username<input name="login" required></label><label class="form">Password<input type="password" name="pw" required></label><p class="err" hidden></p>' +
      '<div class="row row--end"><button type="button" class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--blue">Sign in</button></div></form>', function (d) {
      var f = $('#re', d);
      f.onsubmit = function (ev) {
        ev.preventDefault(); var btn = $('.btn--blue', f); busy(btn, true, 'Signing in…');
        api('login', { method: 'POST', token: '-', body: { login: f.login.value.trim(), password: f.pw.value, device_id: S.cfg.deviceId, device_name: deviceName(), platform: platform() } })
          .then(function (r) {
            if (!r.schools.some(function (s) { return s.id === S.cfg.schoolId; })) throw new Error('That account is not for this school.');
            var cfg = Object.assign({}, S.cfg, { token: r.token, user: r.user, keySalt: b64(rand(16)) });
            return teacherKey(f.pw.value, unb64(cfg.keySalt)).then(function (key) {
              S.key = key; S.cfg = cfg; S.signedOut = false;
              return api('package?school_id=' + cfg.schoolId, { timeout: 120000 }).then(function (pkg) { return savePackage(cfg, pkg, key); });
            });
          }).then(function () { closeModal(); toast('Signed in again.', 'ok'); syncNow(false); renderTeacher(); })
          .catch(function (e) { busy(btn, false); var er = $('.err', f); er.hidden = false; er.textContent = e.message; });
      };
    });
  }

  function backupVotes() {
    var data = { app: 'AAF eVote Station', version: VERSION, school: S.pkg.school, election: S.pkg.election, device: S.cfg.deviceId, saved_at: new Date().toISOString(),
      votes: S.votes.filter(function (v) { return v.status === 'pending'; }) };
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    var name = 'evote-unsent-votes-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    if (window.station && window.station.saveFile) { window.station.saveFile(name, JSON.stringify(data, null, 1)).then(function (p) { if (p) toast('Saved: ' + p, 'ok'); }); return; }
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StationPrint && window.Capacitor.Plugins.StationPrint.saveText) {
      window.Capacitor.Plugins.StationPrint.saveText({ name: name, text: JSON.stringify(data, null, 1) }).then(function (r) { toast('Saved to ' + (r && r.path || 'Downloads'), 'ok'); }).catch(function (e) { toast(e.message, 'bad'); });
      return;
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  /* ============================================================== start */

  function route() {
    paintBar();
    if (!S.cfg || !S.pkg) return renderSetup();
    renderHome();
  }

  function boot() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    Promise.all([kv.get('cfg'), kv.get('pkg'), kv.get('codes'), kv.get('voted'), kv.get('clock'), votesDb.all()]).then(function (r) {
      S.cfg = r[0] || null; S.pkg = r[1] || null; S.codesEnc = r[2] || null;
      S.serverVoted = new Set(r[3] || []); if (r[4]) { S.offset = r[4].offset; S.lastSync = r[4].at; }
      S.votes = r[5] || [];
      if (S.cfg && !S.codesEnc) S.pkg = null;
      route();
      syncNow(false);
    }).catch(function (e) {
      app.innerHTML = '<section class="card card--narrow"><h1>This device cannot store data</h1><p>' + h(e && e.message) + '</p></section>';
    });
    setInterval(function () { syncNow(false); }, SYNC_EVERY_MS);
    setInterval(function () {
      if (currentView === 'home') {
        var before = $('#pupilForm input') && $('#pupilForm input').disabled, st = electionState();
        tickCountdown();
        if (before !== !(st === 'open' && S.pkg.school.open !== false) && !($('#pupilForm input') === document.activeElement)) renderHome();
      }
    }, 1000);
    window.addEventListener('online', function () { syncNow(false); });
    window.addEventListener('offline', function () { S.online = false; paintBar(); });
    document.getElementById('teacherBtn').addEventListener('click', function () { if (currentView === 'teacher') renderHome(); else askTeacher(); });
    ['pointerdown', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { if (currentView === 'ballot') touchBallot(); if (currentView === 'teacher') touchTeacher(); }, true); });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeModal(); });
  }

  // For tests.
  window.__station = { S: S, codeHash: codeHash, syncNow: syncNow };
  boot();
})();
