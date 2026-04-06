/**
 * dashboard.js — Live Power Monitor Web Dashboard
 * Connects to Firebase Firestore, listens for real-time meter updates.
 * Keys match the canonical short keys pushed by firebase_publisher.py
 */

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBlkxXy72Bj9tpH62MQiBo8eqZaynZSfXA",
  authDomain:        "solarpv-field-tool.firebaseapp.com",
  projectId:         "solarpv-field-tool",
  storageBucket:     "solarpv-field-tool.firebasestorage.app",
  messagingSenderId: "956132048124",
  appId:             "1:956132048124:web:a075541517ec3ceb152b79"
};

// ─── Meter card rows — keys must match canonical keys in firebase_publisher ────
// These are the exact field names written to Firestore by _snapshot_to_doc()
const METER_ROWS = [
  { key: 'Vavg',        label: 'Vavg (L-N)',   unit: 'V',    decimals: 1 },
  { key: 'Iavg',        label: 'Iavg',          unit: 'A',    decimals: 2 },
  { key: 'kW',          label: 'Active Power',  unit: 'kW',   decimals: 2 },
  { key: 'kVAr',        label: 'Reactive',      unit: 'kVAr', decimals: 2 },
  { key: 'kVA',         label: 'Apparent',      unit: 'kVA',  decimals: 2 },
  { key: 'PFavg',       label: 'Power Factor',  unit: '',     decimals: 3, pf: true },
  { key: 'Frequency',   label: 'Frequency',     unit: 'Hz',   decimals: 2 },
  { key: 'Import_kWh',  label: 'Import kWh',    unit: 'kWh',  decimals: 1 },
  { key: 'Export_kWh',  label: 'Export kWh',    unit: 'kWh',  decimals: 1 },
];

// ─── App state ─────────────────────────────────────────────────────────────────
let _auth = null;
let _db   = null;
let _user = null;
let _siteId = 'site_01';
let _unsubscribers = [];
let _meterData = {};    // meter_id -> latest Firestore doc
let _siteData  = {};    // site heartbeat doc (plant_name, location, last_seen)
let _toastTimer = null;

// kW trend: circular buffer, max 120 points (= 1 hour at 30s interval)
const KW_MAX_PTS = 120;
let _kwHistory  = [];   // [{ts, kw}]
let _kwChart    = null; // Chart.js instance

// ─── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  _auth = firebase.auth();
  _db   = firebase.firestore();

  _auth.onAuthStateChanged(user => {
    _user = user;
    _updateSignInBtn();
    if (user) _renderDashboard();
    else       _renderSignInPrompt();
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

  const btn  = document.getElementById('signin-btn');
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
      <p>Sign in with your Google account to view live meter data.</p>
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
      <input id="site-select"
             value="${_siteId}" placeholder="site_01" />
      <button onclick="_onSiteChange()">Connect</button>
      <span id="site-info"></span>
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

    <div id="kw-trend-section">
      <div class="section-title">&#128200; Total Active Power — Last Hour</div>
      <div id="kw-chart-wrap"><canvas id="kw-chart"></canvas></div>
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
  _siteId  = val;
  _stopListeners();
  _meterData = {};
  _siteData  = {};
  document.getElementById('meter-grid').innerHTML =
    `<div id="loading"><div class="spinner"></div>Connecting to <strong>${_siteId}</strong>...</div>`;
  _startListeners();
}

// ─── Firestore listeners ───────────────────────────────────────────────────────
function _startListeners() {
  _stopListeners();
  _kwHistory = [];
  if (_kwChart) { _kwChart.destroy(); _kwChart = null; }

  const siteRef   = _db.collection('sites').doc(_siteId);
  const metersCol = siteRef.collection('meters');

  // Site heartbeat — includes plant_name, location if pushed
  const u1 = siteRef.onSnapshot(snap => {
    _siteData = snap.exists ? snap.data() : {};
    _updateBadge();
    _updateSiteInfo();
  }, err => { console.warn('site listener:', err); });

  // All meters
  const u2 = metersCol.onSnapshot(snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'removed') delete _meterData[change.doc.id];
      else _meterData[change.doc.id] = change.doc.data();
    });
    _renderMeters();
    _updateKPIs();
    _updateLastSeen();
    _updateKwTrend();
  }, err => {
    console.warn('meters listener:', err.code, err.message);
    let msg, hint;
    if (err.code === 'permission-denied') {
      msg  = 'Permission denied.';
      hint = 'Update Firestore security rules in Firebase console and click Publish.';
    } else if (err.code === 'unauthenticated') {
      msg  = 'Not signed in.';
      hint = 'Sign in with Google first.';
    } else {
      msg  = `Error: ${err.code || err.message}`;
      hint = 'Check site ID and Firestore rules.';
    }
    document.getElementById('meter-grid').innerHTML =
      `<div style="padding:40px;color:var(--danger);text-align:center">
        &#9888; ${msg}<br>
        <span style="color:var(--muted);font-size:0.82rem">${hint}</span>
      </div>`;
  });

  _unsubscribers = [u1, u2];
}

function _stopListeners() {
  _unsubscribers.forEach(u => { try { u(); } catch {} });
  _unsubscribers = [];
}

// ─── Site info strip ───────────────────────────────────────────────────────────
function _updateSiteInfo() {
  const el = document.getElementById('site-info');
  if (!el) return;
  const name = _siteData.plant_name || '';
  const loc  = _siteData.location   || '';
  if (name || loc) {
    el.textContent = [name, loc].filter(Boolean).join(' — ');
    el.style.color = 'var(--text)';
    el.style.fontWeight = '600';
  } else {
    el.textContent = '';
  }
}

// ─── Render meter cards ────────────────────────────────────────────────────────
function _renderMeters() {
  const grid = document.getElementById('meter-grid');
  if (!grid) return;

  const meters = Object.values(_meterData).sort((a, b) => (a.meter_id || 0) - (b.meter_id || 0));

  if (!meters.length) {
    grid.innerHTML = `<div style="padding:40px;color:var(--muted);text-align:center">
      No meter data yet for <strong>${_siteId}</strong>.<br>
      <span style="font-size:0.8rem">Waiting for SCADA app to push first reading (up to 30 s)...</span>
    </div>`;
    return;
  }

  grid.innerHTML = meters.map(m => _meterCardHtml(m)).join('');
}

function _meterCardHtml(m) {
  const q      = m.quality || 'COMM_LOST';
  const qLabel = { GOOD: 'GOOD', STALE: 'STALE', COMM_LOST: 'COMM LOST', DISABLED: 'DISABLED' }[q] || q;
  const name   = m.meter_name || `Meter ${m.meter_id}`;

  const rows = METER_ROWS.map(r => {
    const raw = m[r.key];
    if (raw === undefined || raw === null) return '';
    const val = typeof raw === 'number' ? raw.toFixed(r.decimals) : raw;
    const cls = r.pf ? _pfClass(parseFloat(val)) : '';
    return `<div class="meter-row">
      <span class="row-label">${r.label}</span>
      <span class="row-value ${cls}">${val}<span class="row-unit"> ${r.unit}</span></span>
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
        ${rows || `<div style="color:var(--muted);font-size:0.82rem;padding:8px 0">No readings</div>`}
        ${ageStr ? `<div class="meter-age">Updated ${ageStr}</div>` : ''}
      </div>
    </div>`;
}

// ─── KPI strip ─────────────────────────────────────────────────────────────────
function _updateKPIs() {
  // Sum/avg across GOOD quality meters only
  const meters = Object.values(_meterData).filter(m => m.quality === 'GOOD');

  const sum = key => meters.reduce((s, m) => s + (parseFloat(m[key]) || 0), 0);
  const avg = key => meters.length ? sum(key) / meters.length : null;

  _setKpi('kpi-kw',  sum('kW'),    2);
  _setKpi('kpi-kva', sum('kVA'),   2);
  _setKpi('kpi-pf',  avg('PFavg'), 3);
  _setKpi('kpi-v',   avg('Vavg'),  1);
  _setKpi('kpi-i',   avg('Iavg'),  2);
  _setKpi('kpi-hz',  avg('Frequency'), 2);
}

function _setKpi(id, val, dec) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (val !== null && !isNaN(val)) ? val.toFixed(dec) : '—';
}

// ─── kW trend chart ────────────────────────────────────────────────────────────
function _updateKwTrend() {
  // Sum kW across all GOOD meters at this timestamp
  const meters = Object.values(_meterData).filter(m => m.quality === 'GOOD');
  if (!meters.length) return;

  const totalKw = meters.reduce((s, m) => s + (parseFloat(m['kW']) || 0), 0);
  const ts      = Math.floor(Date.now() / 1000);

  // Push to circular buffer
  _kwHistory.push({ ts, kw: totalKw });
  if (_kwHistory.length > KW_MAX_PTS) _kwHistory.shift();

  _drawKwChart();
}

function _drawKwChart() {
  const canvas = document.getElementById('kw-chart');
  if (!canvas || _kwHistory.length < 2) return;

  const labels = _kwHistory.map(p => {
    const d = new Date(p.ts * 1000);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0') + ':' + d.getSeconds().toString().padStart(2,'0');
  });
  const data = _kwHistory.map(p => p.kw);

  if (_kwChart) {
    _kwChart.data.labels = labels;
    _kwChart.data.datasets[0].data = data;
    _kwChart.update('none');  // no animation on update for performance
    return;
  }

  // First render — create chart
  // Chart.js loaded from CDN in index.html
  _kwChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Total kW',
        data,
        borderColor:     '#4da6ff',
        backgroundColor: 'rgba(77,166,255,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y.toFixed(2)} kW`
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#8b949e', maxTicksLimit: 8, maxRotation: 0,
            font: { size: 10 }
          },
          grid: { color: 'rgba(48,54,61,0.6)' }
        },
        y: {
          ticks: { color: '#8b949e', font: { size: 10 } },
          grid:  { color: 'rgba(48,54,61,0.6)' },
          title: { display: true, text: 'kW', color: '#8b949e', font: { size: 10 } }
        }
      }
    }
  });
}

// ─── Online badge ──────────────────────────────────────────────────────────────
function _updateBadge() {
  if (!_siteData || !_siteData.last_seen) { _setBadge('', '—'); return; }
  const age = Date.now() / 1000 - _siteData.last_seen;
  if (age < 90)       _setBadge('online',  '&#9679; Online');
  else if (age < 300) _setBadge('stale',   '&#9679; Stale');
  else                _setBadge('offline', '&#9679; Offline');
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
