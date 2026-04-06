/**
 * dashboard.js — Live Power Monitor Web Dashboard
 * Connects to Firebase Firestore, listens for real-time meter updates.
 * No build tools. Plain JS. Works on any browser, phone, tablet, PC.
 */

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBlkxXy72Bj9tpH62MQiBo8eqZaynZSfXA",
  authDomain:        "solarpv-field-tool.firebaseapp.com",
  projectId:         "solarpv-field-tool",
  storageBucket:     "solarpv-field-tool.firebasestorage.app",
  messagingSenderId: "956132048124",
  appId:             "1:956132048124:web:a075541517ec3ceb152b79"
};

// ─── Key display config: which registers to show on each meter card ───────────
const METER_ROWS = [
  { key: 'Average Voltage LN',  label: 'Vavg (L-N)',  unit: 'V',   decimals: 1 },
  { key: 'Average Voltage LL',  label: 'Vavg (L-L)',  unit: 'V',   decimals: 1 },
  { key: 'Average Current',     label: 'Iavg',        unit: 'A',   decimals: 2 },
  { key: 'Total Active Power',  label: 'kW',          unit: 'kW',  decimals: 2 },
  { key: 'Total Reactive Power',label: 'kVAR',        unit: 'kVAR',decimals: 2 },
  { key: 'Total Apparent Power',label: 'kVA',         unit: 'kVA', decimals: 2 },
  { key: 'Average PF',          label: 'PF avg',      unit: '',    decimals: 3, pf: true },
  { key: 'Frequency',           label: 'Frequency',   unit: 'Hz',  decimals: 2 },
  { key: 'Import Active Energy',label: 'Import kWh',  unit: 'kWh', decimals: 1 },
];

// ─── App state ─────────────────────────────────────────────────────────────────
let _auth = null;
let _db   = null;
let _user = null;
let _siteId = 'site_01';
let _unsubscribers = [];   // Firestore onSnapshot cleanup
let _meterData = {};       // meter_id -> latest doc
let _siteData  = {};       // site heartbeat doc
let _toastTimer = null;

// ─── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  _auth = firebase.auth();
  _db   = firebase.firestore();

  _auth.onAuthStateChanged(user => {
    _user = user;
    _updateSignInBtn();
    if (user) {
      _renderDashboard();
    } else {
      _renderSignInPrompt();
    }
  });

  document.getElementById('signin-btn').addEventListener('click', () => {
    if (_user) _showAccountMenu();
    else _signIn();
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────────
function _signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  _auth.signInWithPopup(provider).catch(e => _toast('Sign-in failed: ' + e.message));
}

function _signOut() {
  _stopListeners();
  _auth.signOut();
}

function _updateSignInBtn() {
  const btn = document.getElementById('signin-btn');
  if (!btn) return;
  if (_user) {
    const name  = (_user.displayName || 'User').split(' ')[0];
    const photo = _user.photoURL;
    btn.className = 'signed-in';
    btn.innerHTML = photo
      ? `<img src="${photo}" alt="">${name}`
      : `&#128100; ${name}`;
  } else {
    btn.className = '';
    btn.textContent = 'Sign In';
  }
}

function _showAccountMenu() {
  const old = document.getElementById('_acct_menu');
  if (old) { old.remove(); return; }

  const menu = document.createElement('div');
  menu.id = '_acct_menu';
  menu.className = 'account-menu';
  menu.innerHTML = `
    <div class="account-email">${_user.email}</div>
    <button class="account-item" id="_refresh_btn">&#8635; Refresh now</button>
    <button class="account-item account-danger" id="_signout_btn">&#128274; Sign Out</button>
  `;
  document.body.appendChild(menu);

  const btn = document.getElementById('signin-btn');
  const rect = btn.getBoundingClientRect();
  menu.style.top   = (rect.bottom + 6) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';

  menu.querySelector('#_refresh_btn').addEventListener('click', () => { menu.remove(); _startListeners(); });
  menu.querySelector('#_signout_btn').addEventListener('click', () => { menu.remove(); _signOut(); });

  setTimeout(() => {
    document.addEventListener('click', function _c(e) {
      if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', _c); }
    });
  }, 50);
}

// ─── Sign-in prompt ────────────────────────────────────────────────────────────
function _renderSignInPrompt() {
  _stopListeners();
  document.getElementById('app').innerHTML = `
    <div id="signin-prompt">
      <h2>&#9889; Power Monitor Live Dashboard</h2>
      <p>Sign in with your Google account to view live meter data.<br>
         Your access is controlled by the site administrator.</p>
      <button onclick="_signIn()">Sign in with Google</button>
    </div>
  `;
  _setBadge('', '—');
}

// ─── Dashboard shell ───────────────────────────────────────────────────────────
function _renderDashboard() {
  document.getElementById('app').innerHTML = `
    <div id="site-bar">
      <label for="site-select">Site:</label>
      <input id="site-select" style="background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font-size:0.85rem"
             value="${_siteId}" placeholder="site_01" />
      <button onclick="_onSiteChange()" style="padding:5px 12px;background:var(--accent);color:#0d1117;border:none;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.82rem">
        Connect
      </button>
      <span id="last-update"></span>
    </div>

    <div id="kpi-strip">
      <div class="kpi-card"><div class="kpi-label">Total Power</div><div class="kpi-value" id="kpi-kw">—</div><div class="kpi-unit">kW</div></div>
      <div class="kpi-card"><div class="kpi-label">Total kVA</div><div class="kpi-value" id="kpi-kva">—</div><div class="kpi-unit">kVA</div></div>
      <div class="kpi-card"><div class="kpi-label">Avg PF</div><div class="kpi-value" id="kpi-pf">—</div><div class="kpi-unit">cos φ</div></div>
      <div class="kpi-card"><div class="kpi-label">Avg Voltage</div><div class="kpi-value" id="kpi-v">—</div><div class="kpi-unit">V (L-N)</div></div>
      <div class="kpi-card"><div class="kpi-label">Avg Current</div><div class="kpi-value" id="kpi-i">—</div><div class="kpi-unit">A</div></div>
      <div class="kpi-card"><div class="kpi-label">Frequency</div><div class="kpi-value" id="kpi-hz">—</div><div class="kpi-unit">Hz</div></div>
    </div>

    <div id="meter-grid">
      <div id="loading"><div class="spinner"></div>Connecting to site <strong>${_siteId}</strong>...</div>
    </div>
  `;

  _startListeners();
}

function _onSiteChange() {
  const val = (document.getElementById('site-select').value || '').trim();
  if (!val) return;
  _siteId = val;
  _stopListeners();
  _meterData = {};
  _siteData  = {};
  document.getElementById('meter-grid').innerHTML = `<div id="loading"><div class="spinner"></div>Connecting to <strong>${_siteId}</strong>...</div>`;
  _startListeners();
}

// ─── Firestore listeners ───────────────────────────────────────────────────────
function _startListeners() {
  _stopListeners();

  const siteRef   = _db.collection('sites').doc(_siteId);
  const metersCol = siteRef.collection('meters');

  // Site heartbeat
  const u1 = siteRef.onSnapshot(snap => {
    _siteData = snap.exists ? snap.data() : {};
    _updateBadge();
  }, err => { console.warn('site listener:', err); });

  // All meters — one listener on the collection
  const u2 = metersCol.onSnapshot(snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'removed') {
        delete _meterData[change.doc.id];
      } else {
        _meterData[change.doc.id] = change.doc.data();
      }
    });
    _renderMeters();
    _updateKPIs();
    _updateLastSeen();
  }, err => {
    console.warn('meters listener:', err);
    document.getElementById('meter-grid').innerHTML =
      `<div style="padding:40px;color:var(--danger);text-align:center">
        &#9888; Could not load data for site <strong>${_siteId}</strong>.<br>
        <span style="color:var(--muted);font-size:0.82rem">Check site ID or Firestore rules.</span>
      </div>`;
  });

  _unsubscribers = [u1, u2];
}

function _stopListeners() {
  _unsubscribers.forEach(u => { try { u(); } catch {} });
  _unsubscribers = [];
}

// ─── Render meters ─────────────────────────────────────────────────────────────
function _renderMeters() {
  const grid = document.getElementById('meter-grid');
  if (!grid) return;

  const meters = Object.values(_meterData).sort((a, b) => (a.meter_id || 0) - (b.meter_id || 0));

  if (!meters.length) {
    grid.innerHTML = `<div style="padding:40px;color:var(--muted);text-align:center">
      No meter data for site <strong>${_siteId}</strong>.<br>
      <span style="font-size:0.8rem">Waiting for the SCADA app to push data...</span>
    </div>`;
    return;
  }

  grid.innerHTML = meters.map(m => _meterCardHtml(m)).join('');
}

function _meterCardHtml(m) {
  const q     = m.quality || 'COMM_LOST';
  const qLabel = { GOOD: 'GOOD', STALE: 'STALE', COMM_LOST: 'COMM LOST', DISABLED: 'DISABLED' }[q] || q;
  const name  = m.meter_name || `Meter ${m.meter_id}`;

  const rows = METER_ROWS.map(r => {
    const raw = m[r.key];
    if (raw === undefined || raw === null) return '';
    const val = typeof raw === 'number' ? raw.toFixed(r.decimals) : raw;
    const cls = r.pf ? _pfClass(parseFloat(val)) : '';
    return `<div class="meter-row">
      <span class="row-label">${r.label}</span>
      <span class="row-value ${cls}">${val}<span class="row-unit">${r.unit}</span></span>
    </div>`;
  }).join('');

  const ageStr = m.ts ? _ageStr(m.ts) : '';

  return `
    <div class="meter-card">
      <div class="meter-header">
        <span class="meter-name">&#9889; ${name}</span>
        <span class="meter-quality q-${q}">${qLabel}</span>
      </div>
      <div class="meter-body">
        ${rows || `<div style="color:var(--muted);font-size:0.82rem;padding:8px 0">No data</div>`}
        ${ageStr ? `<div style="color:var(--muted);font-size:0.72rem;margin-top:8px;text-align:right">Updated ${ageStr}</div>` : ''}
      </div>
    </div>`;
}

// ─── KPI strip ─────────────────────────────────────────────────────────────────
function _updateKPIs() {
  const meters = Object.values(_meterData).filter(m => m.quality === 'GOOD');

  const sum  = key => meters.reduce((s, m) => s + (parseFloat(m[key]) || 0), 0);
  const avg  = key => meters.length ? sum(key) / meters.length : null;

  const kw  = sum('Total Active Power');
  const kva = sum('Total Apparent Power');
  const pf  = avg('Average PF');
  const v   = avg('Average Voltage LN');
  const i   = avg('Average Current');
  const hz  = avg('Frequency');

  _setKpi('kpi-kw',  kw,  2);
  _setKpi('kpi-kva', kva, 2);
  _setKpi('kpi-pf',  pf,  3);
  _setKpi('kpi-v',   v,   1);
  _setKpi('kpi-i',   i,   2);
  _setKpi('kpi-hz',  hz,  2);
}

function _setKpi(id, val, dec) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (val !== null && !isNaN(val)) ? val.toFixed(dec) : '—';
}

// ─── Online badge ──────────────────────────────────────────────────────────────
function _updateBadge() {
  if (!_siteData || !_siteData.last_seen) { _setBadge('', '—'); return; }
  const age = Date.now() / 1000 - _siteData.last_seen;
  if (age < 90)        _setBadge('online',  '&#9679; Online');
  else if (age < 300)  _setBadge('stale',   '&#9679; Stale');
  else                 _setBadge('offline', '&#9679; Offline');
}

function _setBadge(cls, html) {
  const el = document.getElementById('online-badge');
  if (!el) return;
  el.className = cls;
  el.innerHTML = html;
}

function _updateLastSeen() {
  const el = document.getElementById('last-update');
  if (!el) return;
  el.textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function _updateBadgeLoop() {
  _updateBadge();
  setTimeout(_updateBadgeLoop, 15000);
}
_updateBadgeLoop();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function _pfClass(pf) {
  if (isNaN(pf)) return '';
  if (pf >= 0.95) return 'pf-good';
  if (pf >= 0.85) return 'pf-warn';
  return 'pf-danger';
}

function _ageStr(ts) {
  const sec = Math.floor(Date.now() / 1000 - ts);
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  return `${Math.floor(sec/3600)}h ago`;
}

function _toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
