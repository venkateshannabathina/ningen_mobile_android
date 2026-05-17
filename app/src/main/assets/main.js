'use strict';
// Android WebView bridge

// ─── PROTOCOL ─────────────────────────────────────────────────────────────────
// Mirror of the H / W objects in out/panel.js.
// H = messages host sends TO this webview.
// W = messages this webview sends TO the host.
const H = {
    SET_STATE:      'SET_STATE',
    SHOW_SCREEN:    'SHOW_SCREEN',
    SHOW_ERROR:     'SHOW_ERROR',
    PIXIE_SAID:     'PIXIE_SAID',
    USER_SAID:      'USER_SAID',
    LLM_WORD_CHUNK: 'LLM_WORD_CHUNK',
    LLM_DONE:       'LLM_DONE',
    PLAY_AUDIO:     'PLAY_AUDIO',
    LOAD_VRM:       'LOAD_VRM',
    UPLOAD_VRM_DONE:'UPLOAD_VRM_DONE',
    MEMORY_UPDATED: 'MEMORY_UPDATED',
    ERROR:          'ERROR',
    INIT_STATE:     'INIT_STATE',
};
const W = {
    WEBVIEW_READY:  'WEBVIEW_READY',
    START_CLICKED:  'START_CLICKED',
    SAVE_API_KEY:   'SAVE_API_KEY',
    REQUEST_VRM:    'REQUEST_VRM',
    UPLOAD_VRM:     'UPLOAD_VRM',
    CLEAR_API_KEY:  'CLEAR_API_KEY',
    SEND_TEXT:      'SEND_TEXT',
    START_LISTENING:'START_LISTENING',
    STOP_LISTENING: 'STOP_LISTENING',
    TTS_DONE:       'TTS_DONE',
    UPDATE_SETTINGS:'UPDATE_SETTINGS',
    CLEAR_MEMORY:   'CLEAR_MEMORY',
    RESET_ALL:      'RESET_ALL',
};

// Single send path to the host — use W.* constants for the type.
function send(type, payload) {
    try {
        if (window.PixieBridge) {
            PixieBridge.sendToAndroid(JSON.stringify(Object.assign({ type }, payload)));
        }
    } catch(e) { console.error('[Pixie] send error', e); }
}

// ─── PREFERENCES (localStorage) ──────────────────────────────────────────────
function pget(k, def) { const v = localStorage.getItem('pixie_' + k); return v === null ? def : v; }
function pset(k, v) { localStorage.setItem('pixie_' + k, String(v)); }

const prefs = {
    get firstTimeDone() { return pget('ftd', '0') === '1'; },
    set firstTimeDone(v) { pset('ftd', v ? '1' : '0'); },
    get companion() { return pget('companion', 'pixie'); },
    set companion(v) { pset('companion', v); },
    get companionName() { return pget('cname', 'Yuriko'); },
    set companionName(v) { pset('cname', v); },
    get customVrmName() { return pget('customVrmName', ''); },
    set customVrmName(v) { pset('customVrmName', v); },
    get personality() { return pget('personality', 'friendly'); },
    set personality(v) { pset('personality', v); },
    get enableMemory() { return pget('mem_on', '1') !== '0'; },
    set enableMemory(v) { pset('mem_on', v ? '1' : '0'); },
    get voiceEnabled() { return pget('voice_on', '1') !== '0'; },
    set voiceEnabled(v) { pset('voice_on', v ? '1' : '0'); },
    get voiceSpeed() { return parseFloat(pget('vspeed', '1.0')); },
    set voiceSpeed(v) { pset('vspeed', String(v)); },
    get voiceName() { return pget('vname', 'diana'); },
    set voiceName(v) { pset('vname', v); },
    get theme() { return pget('theme', 'vscode'); },
    set theme(v) { pset('theme', v); applyTheme(v); },
    get charSize() { return pget('csize', 'medium'); },
    set charSize(v) { pset('csize', v); applyCharSize(v); },
    get bgColor() { return pget('bg', ''); },
    set bgColor(v) { pset('bg', v); applyBgColor(v); },
    get wallpaper() { return pget('wallpaper', window.__backgroundUri || ''); },
    set wallpaper(v) { pset('wallpaper', v); applyWallpaper(v); },
    get model() { return pget('model', 'llama-3.3-70b-versatile'); },
    set model(v) { pset('model', v); },
};

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
let audioCtx = null;
let clientReady = false;        // groqClient initialised on host side
let shellReady = false;        // shell DOM built
let queuedScreen = null;         // SHOW_SCREEN received before shell was ready
let settingsOpen = false;
let isBusy = false;        // mirrors host isBusy
let currentUIState = 'idle';
let vrmAnimations = {};           // all animation URLs keyed by name (from LOAD_VRM)
let _vrmLoading = false;          // guard against concurrent LOAD_VRM messages
let _voiceEnabled = true;         // false when SoX is not installed on host
let _inputMode = 'chat';          // 'chat' | 'mic' — which bottom input is active

// ─── SETTINGS SYNC ───────────────────────────────────────────────────────────
function syncSettings() {
    send(W.UPDATE_SETTINGS, {
        voiceName: prefs.voiceName,
        model: prefs.model,
        companionName: prefs.companionName,
        personality: prefs.personality,
    });
}

// ─── MEMORY ───────────────────────────────────────────────────────────────────
// pixie_memory      — raw chat log (array) used to build compressed summary
// pixie_mem_summary — latest compressed/summarized string from LLM
function memGet() { try { return JSON.parse(localStorage.getItem('pixie_memory') || '[]'); } catch { return []; } }
function memAdd(role, text) { if (!prefs.enableMemory) return; const m = memGet(); m.push({ role, text, t: Date.now() }); if (m.length > 60) m.shift(); localStorage.setItem('pixie_memory', JSON.stringify(m)); }
function memClear() { localStorage.removeItem('pixie_memory'); localStorage.removeItem('pixie_mem_summary'); }
function memSetSummary(s) { localStorage.setItem('pixie_mem_summary', s); }
function memGetSummary() { return localStorage.getItem('pixie_mem_summary') || ''; }
function memSummary() {
    const s = memGetSummary();
    if (s) return s;
    const m = memGet();
    if (!m.length) return 'No conversations remembered yet.';
    return m.slice(-6).map(e => `${e.role === 'user' ? 'You' : prefs.companionName}: ${e.text}`).join('\n');
}
function memHasData() { return memGetSummary().length > 0 || memGet().length > 0; }

// ─── THEME / SIZE / BG ───────────────────────────────────────────────────────
function applyTheme(t) {
    const app = document.getElementById('app');
    if (!app) return;
    app.dataset.theme = t;
}
function applyCharSize(s) {
    const vp = document.getElementById('vrm-viewport');
    if (!vp) return;
    vp.dataset.csize = s;
}
function applyBgColor(c) {
    const vp = document.getElementById('vrm-viewport');
    if (vp && c) vp.style.setProperty('--vrm-bg', c);
}
function applyWallpaper(dataUrl) {
    const vp = document.getElementById('vrm-viewport');
    if (!vp) return;
    if (dataUrl) {
        vp.style.backgroundImage = `url(${dataUrl})`;
        vp.style.backgroundSize = 'cover';
        vp.style.backgroundPosition = 'center';
        vp.style.backgroundRepeat = 'no-repeat';
    } else {
        vp.style.backgroundImage = '';
    }
}

// ─── COMPANIONS ───────────────────────────────────────────────────────────────
const COMPANIONS = [
    {
        id: 'pixie', name: 'Yuriko', file: 'female.vrm',
        gradient: 'linear-gradient(145deg,#fce4e4 0%,#f5b8b8 55%,#e88080 100%)'
    },
];

const PERSONALITIES = [
    { id: 'friendly',     label: 'Friendly',      desc: 'Warm, caring, genuinely excited for you',     color: '#da7756' },
    { id: 'casual',       label: 'Casual',         desc: 'Chill bestie, talks like a text message',     color: '#22c55e' },
    { id: 'sarcastic',    label: 'Sarcastic',      desc: 'Perpetually unimpressed, devastatingly dry',  color: '#7b68ee' },
    { id: 'professional', label: 'Professional',   desc: 'Formal, precise, strictly business',          color: '#4a90d9' },
    { id: 'meanie',       label: 'Meanie',         desc: 'Genuinely mean, zero patience, will roast',   color: '#e8453c' },
    { id: 'innocent',     label: 'Innocent',       desc: 'Pure, sweet, wonderfully naive',              color: '#f59e0b' },
];

// ─── COMPANION PROFILES ───────────────────────────────────────────────────────
// Each profile: { name, personality, gradient }
// Stored in pixie_profiles as { [companionId]: profile }
function getProfiles() { try { return JSON.parse(localStorage.getItem('pixie_profiles') || '{}'); } catch { return {}; } }
function saveProfile(id, data) { const all = getProfiles(); all[id] = data; localStorage.setItem('pixie_profiles', JSON.stringify(all)); }
function getProfile(id) {
    const stored = getProfiles()[id];
    if (stored) return stored;
    const DEFAULTS = {
        pixie: { name: 'Yuriko', personality: 'friendly', gradient: 'linear-gradient(145deg,#fce4e4 0%,#f5b8b8 55%,#e88080 100%)' }
    };
    return DEFAULTS[id] || { name: id, personality: 'friendly', gradient: 'linear-gradient(145deg,#e4eefc 0%,#b8cef5 55%,#80a0e8 100%)' };
}
function loadCompanionProfile(id) {
    const p = getProfile(id);
    prefs.companionName = p.name;
    prefs.personality   = p.personality;
}
function saveCurrentProfile() {
    const existing = getProfile(prefs.companion);
    saveProfile(prefs.companion, { ...existing, name: prefs.companionName, personality: prefs.personality });
}
function persLabel(id) { return PERSONALITIES.find(p => p.id === id)?.label || 'Friendly'; }
function persColor(id) { return PERSONALITIES.find(p => p.id === id)?.color || '#da7756'; }
function gradientFromPersonality(id) {
    const c = persColor(id);
    return `linear-gradient(145deg, ${c}28 0%, ${c}60 55%, ${c}90 100%)`;
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function runOnboarding() {
    const app = document.getElementById('app');
    app.innerHTML = '<div id="ob" class="ob-layer"></div>';
    showSplash();
}

function showSplash() {
    const ob = document.getElementById('ob');
    ob.innerHTML = `
    <div class="ob-screen ob-splash" id="ob-splash">
      <div class="ob-logo">
        <span class="ob-logo-text">
          P<span class="ob-logo-a">a</span><span class="ob-logo-n">n</span>d<span class="ob-logo-a">a</span>
        </span>
        <div class="ob-logo-sub">3 D &nbsp;·&nbsp; A I &nbsp;·&nbsp; C O M P A N I O N</div>
      </div>
    </div>`;
    const el = document.getElementById('ob-splash');
    requestAnimationFrame(() => el.classList.add('ob-visible'));
    setTimeout(() => {
        el.classList.remove('ob-visible');
        el.classList.add('ob-out');
        setTimeout(showTagline, 400);
    }, 2200);
}

function showTagline() {
    const ob = document.getElementById('ob');
    ob.innerHTML = `
    <div class="ob-screen ob-tagline" id="ob-tag">
      <p class="ob-tagline-text">&ldquo;made for developers&rdquo;</p>
    </div>`;
    const el = document.getElementById('ob-tag');
    requestAnimationFrame(() => el.classList.add('ob-visible'));
    setTimeout(() => {
        el.classList.remove('ob-visible');
        el.classList.add('ob-out');
        setTimeout(showCompanionSelect, 400);
    }, 2200);
}

// Converts an ArrayBuffer to base64 without blowing the call stack on large files
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
}

function showCompanionSelect(fromSettings) {
    const container = fromSettings
        ? document.getElementById('companion-select-overlay')
        : document.getElementById('ob');

    const customProfile = prefs.customVrmName ? getProfile('custom') : null;
    const customCard = customProfile ? `
        <div class="companion-card companion-card--custom ${prefs.companion === 'custom' ? 'companion-card--selected' : ''}" data-id="custom"
             style="--card-bg:${customProfile.gradient}">
          <div class="companion-card-circle">
            <span class="companion-card-initial">${customProfile.name[0].toUpperCase()}</span>
          </div>
          <span class="companion-card-name">${escHtml(customProfile.name)}</span>
          <span class="companion-card-badge" style="--badge-color:${persColor(customProfile.personality)}">${persLabel(customProfile.personality)}</span>
        </div>` : '';

    const html = `
    <div class="ob-screen ob-companions ${fromSettings ? 'ob-companions--settings' : ''}" id="ob-comp">
      ${fromSettings ? `
        <button class="companion-overlay-back" id="companion-overlay-back">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/>
          </svg>
        </button>` : ''}
      ${!fromSettings ? '<p class="ob-comp-title">choose your companion</p>' : '<p class="ob-comp-title">switch character</p>'}
      <input type="file" id="vrm-file-input" accept=".vrm" style="display:none">
      <div class="ob-comp-grid">
        ${COMPANIONS.map(c => {
            const cp = getProfile(c.id);
            return `
          <div class="companion-card ${prefs.companion === c.id ? 'companion-card--selected' : ''}" data-id="${c.id}" style="--card-bg:${c.gradient}">
            <div class="companion-card-circle">
              <span class="companion-card-initial">${cp.name[0]}</span>
            </div>
            <span class="companion-card-name">${escHtml(cp.name)}</span>
            <span class="companion-card-badge" style="--badge-color:${persColor(cp.personality)}">${persLabel(cp.personality)}</span>
          </div>`;
        }).join('')}
        ${customCard}
        <div class="companion-card companion-card--add" id="companion-add-btn">
          <div class="companion-card-circle companion-card-circle--add" id="companion-add-circle">
            <svg id="companion-add-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </div>
          <span class="companion-card-name">add your own</span>
          <span class="companion-card-sub">.vrm file</span>
        </div>
      </div>
    </div>`;

    container.innerHTML = html;
    if (fromSettings) container.style.display = 'flex';
    const el = document.getElementById('ob-comp');
    requestAnimationFrame(() => el.classList.add('ob-visible'));

    // Close button (settings mode only)
    const backBtn = document.getElementById('companion-overlay-back');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            document.getElementById('companion-select-overlay').style.display = 'none';
        });
    }

    // Built-in companions
    document.querySelectorAll('.companion-card:not(.companion-card--add):not(.companion-card--custom)').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.id;
            prefs.companion = id;
            loadCompanionProfile(id);
            if (fromSettings) {
                syncSettings();
                document.getElementById('companion-select-overlay').style.display = 'none';
                send(W.REQUEST_VRM, { companion: id });
            } else {
                prefs.firstTimeDone = true;
                buildShell();
            }
        });
    });

    // Custom VRM card (already uploaded) — switch to it with its own profile
    document.querySelectorAll('.companion-card--custom').forEach(card => {
        card.addEventListener('click', () => {
            prefs.companion = 'custom';
            loadCompanionProfile('custom');
            if (fromSettings) {
                syncSettings();
                document.getElementById('companion-select-overlay').style.display = 'none';
                send(W.REQUEST_VRM, { companion: 'custom' });
            } else {
                prefs.firstTimeDone = true;
                buildShell();
            }
        });
    });

    // "Add your own" → open file picker
    document.getElementById('companion-add-btn').addEventListener('click', () => {
        document.getElementById('vrm-file-input').click();
    });

    document.getElementById('vrm-file-input').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.vrm')) {
            showCompanionUploadError('Only .vrm files are supported.'); return;
        }

        const circle = document.getElementById('companion-add-circle');
        const icon   = document.getElementById('companion-add-icon');
        if (circle) circle.classList.add('companion-card-circle--loading');
        if (icon)   icon.style.display = 'none';

        const reader = new FileReader();
        reader.onload = ev => {
            const base64 = arrayBufferToBase64(ev.target.result);
            // Reset loading state before wizard opens
            if (circle) circle.classList.remove('companion-card-circle--loading');
            if (icon)   icon.style.display = '';
            showCreationWizard(base64, file.name, fromSettings);
        };
        reader.onerror = () => showCompanionUploadError('Failed to read file.');
        reader.readAsArrayBuffer(file);
    });
}

function showCompanionUploadError(msg) {
    const sub = document.querySelectorAll('#companion-add-btn .companion-card-sub');
    if (sub.length) { sub[0].textContent = msg; sub[0].style.color = 'var(--red)'; }
}

// ─── CREATION WIZARD ──────────────────────────────────────────────────────────
let _wizard = {};

function showCreationWizard(base64, filename, fromSettings) {
    _wizard = { base64, filename, fromSettings };
    let w = document.getElementById('creation-wizard');
    if (!w) {
        w = document.createElement('div');
        w.id = 'creation-wizard';
        w.className = 'creation-wizard';
        document.getElementById('app').appendChild(w);
    }
    _renderWizardStep(w, 1);
    requestAnimationFrame(() => w.classList.add('creation-wizard--open'));
}

function closeWizard() {
    const w = document.getElementById('creation-wizard');
    if (!w) return;
    w.classList.remove('creation-wizard--open');
    setTimeout(() => { if (w.parentNode) w.parentNode.removeChild(w); }, 260);
    _wizard = {};
}

function _renderWizardStep(w, step) {
    if (step === 1) {
        w.innerHTML = `
          <div class="wizard-card">
            <p class="wizard-step-label">Step 1 of 2</p>
            <h2 class="wizard-title">Name your companion</h2>
            <p class="wizard-hint">What should they be called?</p>
            <input class="wizard-input" id="wizard-name" type="text" maxlength="24"
              placeholder="e.g. Zara, Max, Luna..." autocomplete="off"
              value="${escHtml(_wizard.name || '')}"/>
            <p class="wizard-input-err" id="wizard-name-err" style="display:none">Enter a name to continue.</p>
            <div class="wizard-actions">
              <button class="wizard-btn-cancel" id="wizard-cancel">Cancel</button>
              <button class="wizard-btn-primary" id="wizard-next">Continue</button>
            </div>
          </div>`;

        setTimeout(() => w.querySelector('#wizard-name')?.focus(), 60);

        const doNext = () => {
            const name = w.querySelector('#wizard-name').value.trim();
            if (!name) {
                w.querySelector('#wizard-name-err').style.display = 'block';
                w.querySelector('#wizard-name').focus();
                return;
            }
            _wizard.name = name;
            _renderWizardStep(w, 2);
        };
        w.querySelector('#wizard-cancel').onclick = closeWizard;
        w.querySelector('#wizard-next').onclick = doNext;
        w.querySelector('#wizard-name').onkeydown = e => { if (e.key === 'Enter') doNext(); };

    } else {
        w.innerHTML = `
          <div class="wizard-card">
            <p class="wizard-step-label">Step 2 of 2</p>
            <h2 class="wizard-title">${escHtml(_wizard.name)}'s personality</h2>
            <p class="wizard-hint">How should they act and talk?</p>
            <div class="wizard-pers-grid">
              ${PERSONALITIES.map(p => `
                <div class="wizard-pers-card ${_wizard.personality === p.id ? 'wizard-pers-card--active' : ''}"
                     data-id="${p.id}" style="--pc:${p.color}">
                  <span class="wizard-pers-name">${p.label}</span>
                  <span class="wizard-pers-desc">${p.desc}</span>
                </div>`).join('')}
            </div>
            <p class="wizard-input-err" id="wizard-pers-err" style="display:none">Pick a personality to continue.</p>
            <div class="wizard-actions">
              <button class="wizard-btn-cancel" id="wizard-back">Back</button>
              <button class="wizard-btn-primary" id="wizard-create" ${_wizard.personality ? '' : 'disabled'}>Create</button>
            </div>
          </div>`;

        w.querySelectorAll('.wizard-pers-card').forEach(card => {
            card.onclick = () => {
                w.querySelectorAll('.wizard-pers-card').forEach(c => c.classList.remove('wizard-pers-card--active'));
                card.classList.add('wizard-pers-card--active');
                _wizard.personality = card.dataset.id;
                w.querySelector('#wizard-pers-err').style.display = 'none';
                w.querySelector('#wizard-create').disabled = false;
            };
        });
        w.querySelector('#wizard-back').onclick = () => _renderWizardStep(w, 1);
        w.querySelector('#wizard-create').onclick = _finishWizard;
    }
}

function _finishWizard() {
    if (!_wizard.personality || !_wizard.name) return;
    const w = document.getElementById('creation-wizard');

    const gradient = gradientFromPersonality(_wizard.personality);
    saveProfile('custom', { name: _wizard.name, personality: _wizard.personality, gradient });
    prefs.customVrmName  = _wizard.name;
    prefs.companion      = 'custom';
    prefs.companionName  = _wizard.name;
    prefs.personality    = _wizard.personality;

    if (w) w.innerHTML = `
      <div class="wizard-card wizard-card--center">
        <div class="wizard-spinner"></div>
        <p class="wizard-loading-text">Setting up ${escHtml(_wizard.name)}...</p>
      </div>`;

    window.__vrmUploadFromSettings = _wizard.fromSettings;
    send(W.UPLOAD_VRM, { data: _wizard.base64, name: _wizard.filename });
}

// ─── SHELL ────────────────────────────────────────────────────────────────────
function buildShell() {
    const app = document.getElementById('app');
    applyTheme(prefs.theme);

    app.innerHTML = `
    <!-- Settings panel -->
    <div id="settings-panel" class="settings-panel">
      <div class="settings-header">
        <span class="settings-title">Settings</span>
        <button id="settings-close" class="settings-close" title="Close">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/>
          </svg>
        </button>
      </div>
      <div id="settings-body" class="settings-body"></div>
      <div class="settings-footer">
        <button id="settings-reset-btn" class="settings-reset-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>
          </svg>
          Reset Everything
        </button>
      </div>
      <div id="reset-modal" class="reset-modal" aria-hidden="true">
        <div class="reset-modal-card">
          <div class="reset-modal-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <p class="reset-modal-title">Reset Everything?</p>
          <p class="reset-modal-subtitle">This will permanently remove:</p>
          <ul class="reset-modal-list">
            <li>Your Groq API key — you'll need to re-enter it to reconnect</li>
            <li>All conversation memory and context history</li>
            <li>All preferences — theme, voice, companion name, settings</li>
          </ul>
          <p class="reset-modal-caution">This cannot be undone.</p>
          <div class="reset-modal-actions">
            <button id="reset-cancel" class="reset-action-cancel">Cancel</button>
            <button id="reset-confirm" class="reset-action-confirm">Reset Everything</button>
          </div>
        </div>
      </div>
    </div>
    <div id="settings-backdrop" class="settings-backdrop"></div>

    <!-- Companion select overlay (used from settings) -->
    <div id="companion-select-overlay" class="companion-select-overlay" style="display:none"></div>

    <!-- API key overlay -->
    <div id="apikey-overlay" class="apikey-overlay" style="display:none">
      <div class="apikey-card">
        <div class="apikey-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M12 11l8-8"/><path d="M18 5l2 2"/><path d="M15 8l2 2"/></svg></div>
        <p class="apikey-title">groq api key</p>
        <p class="apikey-hint">stored securely in VS Code · never leaves your machine</p>
        <input id="apikey-input" class="apikey-input" type="password"
          placeholder="gsk_••••••••••••" autocomplete="off" spellcheck="false"/>
        <p id="apikey-err" class="apikey-err" style="display:none"></p>
        <button id="apikey-submit" class="btn-primary">save key</button>
        <a class="apikey-link" href="https://console.groq.com" target="_blank">get a free key ↗</a>
      </div>
    </div>

    <!-- Loading overlay -->
    <div id="loading-overlay" class="loading-overlay" style="display:none">
      <div class="loading-spin"></div>
      <p class="loading-txt">connecting…</p>
    </div>

    <!-- VRM viewport -->
    <div id="vrm-viewport" class="vrm-viewport">
      <canvas id="vrm-canvas"></canvas>
      <div id="vrm-loading" class="vrm-loading">
        <div class="loading-spin"></div>
        <span id="vrm-pct">loading model…</span>
      </div>
      <!-- Talking animation indicator — top-left, always visible -->
      <div id="talk-indicator" class="talk-indicator" data-state="idle">
        <canvas id="vw-orb" class="vw-orb-inner"></canvas>
      </div>
      <!-- MIC HUD — visible only when mic input mode is active -->
      <div id="mic-hud" class="mic-hud" style="display:none">
        <p id="wave-hint" class="wave-hint-hud">hold space to speak</p>
        <button id="mic-back-btn" class="mic-back-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
            <path d="M6 11h.01M10 11h.01M14 11h.01M18 11h.01M8 15h8"/>
          </svg>
          switch to chat
        </button>
      </div>
      <!-- Theme toggle -->
      <button id="theme-btn" class="theme-btn" data-cur-theme="${prefs.theme === 'dark' ? 'dark' : 'light'}" title="Toggle theme">
        <svg class="theme-icon theme-icon--sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <circle cx="12" cy="12" r="4"/>
          <line x1="12" y1="2"    x2="12" y2="5"/>
          <line x1="12" y1="19"   x2="12" y2="22"/>
          <line x1="2"  y1="12"   x2="5"  y2="12"/>
          <line x1="19" y1="12"   x2="22" y2="12"/>
          <line x1="4.22" y1="4.22"   x2="6.34" y2="6.34"/>
          <line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
          <line x1="19.78" y1="4.22"  x2="17.66" y2="6.34"/>
          <line x1="6.34"  y1="17.66" x2="4.22"  y2="19.78"/>
        </svg>
        <svg class="theme-icon theme-icon--moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
      <!-- Zoom button -->
      <button id="zoom-btn" class="zoom-btn" data-zoom="out" title="Portrait zoom">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7.5"/>
          <line x1="20.5" y1="20.5" x2="16.2" y2="16.2"/>
          <line class="zoom-plus-v" x1="11" y1="8" x2="11" y2="14"/>
          <line class="zoom-plus-h" x1="8"  y1="11" x2="14" y2="11"/>
          <line class="zoom-minus"  x1="8"  y1="11" x2="14" y2="11"/>
        </svg>
      </button>
      <!-- Settings button -->
      <button id="settings-btn" class="settings-btn" title="Settings">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <circle cx="12" cy="12" r="3.2"/>
          <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22
                   M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77
                   M19.07 4.93l-1.77 1.77M6.7 17.3l-1.77 1.77"/>
        </svg>
      </button>
    </div>

    <!-- Bottom bar — chat mode text input (hidden in mic mode) -->
    <div class="bottom-bar" id="bottom-bar">

      <!-- CHAT MODE: text input -->
      <div class="text-bar" id="text-bar">
        <input id="text-input" class="text-input-field" type="text"
          placeholder="type a message…" maxlength="500"
          autocomplete="off" spellcheck="false" enterkeyhint="send">
        <button id="text-send-btn" class="text-send-btn" title="Send">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2z"/>
          </svg>
        </button>
        <button class="mode-toggle-btn" id="mode-toggle-chat" title="Switch to voice">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
            <line x1="8" y1="22" x2="16" y2="22"/>
          </svg>
        </button>
      </div>

      <!-- SoX missing banner — visible only when host reports voiceEnabled:false -->
      <div class="sox-banner" id="sox-banner" style="display:none">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        Voice disabled &mdash; run <code>brew install sox</code> to enable mic
      </div>
    </div>`;

    // Prime AudioContext on first user interaction so code-watcher TTS can play
    // without needing the user to press Space first.
    document.addEventListener('click', function primeAudio() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        document.removeEventListener('click', primeAudio);
    }, { once: true });

    // Wire up events
    document.getElementById('settings-btn').addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
    document.getElementById('settings-reset-btn').addEventListener('click', showResetModal);
    document.getElementById('reset-cancel').addEventListener('click', hideResetModal);
    document.getElementById('reset-confirm').addEventListener('click', confirmReset);
    document.getElementById('zoom-btn').addEventListener('click', () => {
        const btn = document.getElementById('zoom-btn');
        if (!window.PixieVRM) return;
        const state = window.PixieVRM.toggleZoom();
        btn.dataset.zoom = state;
    });
    document.getElementById('theme-btn').addEventListener('click', () => {
        const btn = document.getElementById('theme-btn');
        const next = prefs.theme === 'dark' ? 'light' : 'dark';
        prefs.theme = next;
        btn.dataset.curTheme = next;
        document.querySelectorAll('#ss-themes .ss-chip').forEach(b => {
            b.classList.toggle('ss-chip--active', b.dataset.val === next);
        });
    });

    window.addEventListener('vrm-progress', e => {
        const el = document.getElementById('vrm-pct');
        if (el) el.textContent = `loading model… ${e.detail}%`;
    });

    // API key overlay wiring
    const akInput = document.getElementById('apikey-input');
    const akSubmit = document.getElementById('apikey-submit');
    const akErr = document.getElementById('apikey-err');

    function submitKey() {
        const key = akInput.value.trim();
        if (!key || !key.startsWith('gsk_')) {
            akErr.textContent = 'key must start with gsk_';
            akErr.style.display = 'block';
            return;
        }
        akErr.style.display = 'none';
        akSubmit.disabled = true;
        send(W.SAVE_API_KEY, { key });
    }
    akSubmit.addEventListener('click', submitKey);
    akInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitKey(); });

    // Apply persisted prefs
    applyCharSize(prefs.charSize);
    applyBgColor(prefs.bgColor);
    applyWallpaper(prefs.wallpaper);

    shellReady = true;
    initVRM();
    VoiceWave.init();
    bindSpaceToTalk();
    bindTextInput();
    bindModeToggle();
    send(W.WEBVIEW_READY);
    loadCompanionProfile(prefs.companion);
    syncSettings();

    // Apply any screen message that arrived before shell was ready
    if (queuedScreen) {
        applyScreen(queuedScreen);
        queuedScreen = null;
    }
}

// ─── SCREENS ─────────────────────────────────────────────────────────────────
function applyScreen(screen) {
    const loadingOv = document.getElementById('loading-overlay');
    const apikeyOv = document.getElementById('apikey-overlay');
    const akSubmit = document.getElementById('apikey-submit');

    switch (screen) {
        case 'START':
            if (loadingOv) loadingOv.style.display = 'none';
            if (apikeyOv) apikeyOv.style.display = 'none';
            setClientReady(false);
            break;

        case 'API_KEY':
            if (loadingOv) loadingOv.style.display = 'none';
            if (apikeyOv) { apikeyOv.style.display = 'flex'; if (akSubmit) akSubmit.disabled = false; }
            setClientReady(false);
            break;

        case 'LOADING':
            if (loadingOv) loadingOv.style.display = 'flex';
            if (apikeyOv) apikeyOv.style.display = 'none';
            break;

        case 'VOICE_UI':
            if (loadingOv) loadingOv.style.display = 'none';
            if (apikeyOv) apikeyOv.style.display = 'none';
            setClientReady(true);
            break;
    }
}

function setClientReady(ready) {
    clientReady = ready;
    const hint = document.getElementById('wave-hint');
    if (!hint) return;
    hint.textContent = ready ? 'press space to speak' : 'connecting…';
}

// ─── SETTINGS PANEL ──────────────────────────────────────────────────────────
function openSettings() {
    settingsOpen = true;
    renderSettingsBody();
    document.getElementById('settings-panel').classList.add('settings-panel--open');
    document.getElementById('settings-backdrop').classList.add('settings-backdrop--visible');
}

function closeSettings() {
    settingsOpen = false;
    document.getElementById('settings-panel').classList.remove('settings-panel--open');
    document.getElementById('settings-backdrop').classList.remove('settings-backdrop--visible');
    const co = document.getElementById('companion-select-overlay');
    if (co) co.style.display = 'none';
    hideResetModal();
}

function showResetModal() {
    const modal = document.getElementById('reset-modal');
    if (!modal) return;
    modal.classList.add('reset-modal--open');
    modal.setAttribute('aria-hidden', 'false');
}

function hideResetModal() {
    const modal = document.getElementById('reset-modal');
    if (!modal) return;
    modal.classList.remove('reset-modal--open');
    modal.setAttribute('aria-hidden', 'true');
}

function confirmReset() {
    // Clear all webview-side preferences (keep pixie_ftd so onboarding doesn't replay)
    Object.keys(localStorage)
        .filter(k => k.startsWith('pixie_') && k !== 'pixie_ftd')
        .forEach(k => localStorage.removeItem(k));
    applyWallpaper('');
    // Tell the host to clear API key + memory, and navigate to API_KEY screen
    send(W.RESET_ALL);
    hideResetModal();
    closeSettings();
    // Reset runtime state so the UI reflects the disconnected state
    clientReady = false;
    isBusy = false;
    setClientReady(false);
}

function renderSettingsBody() {
    const body = document.getElementById('settings-body');
    if (!body) return;

    const tabs = [
        {
            id: 'companion', label: 'Character', render: renderCompanionTab,
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`
        },
        {
            id: 'voice', label: 'Voice', render: renderVoiceTab,
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2v20M8 5v14M4 8v8M16 5v14M20 8v8"/></svg>`
        },
        {
            id: 'look', label: 'Look', render: renderAppearanceTab,
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
        },
        {
            id: 'api', label: 'API', render: renderApiTab,
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M12 11l9-9M17 6l2 2"/></svg>`
        },
        {
            id: 'about', label: 'About', render: renderAboutTab,
            icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="8.5"/><line x1="12" y1="12" x2="12" y2="16"/></svg>`
        },
    ];

    let activeTab = tabs[0].id;

    body.innerHTML = `
    <div class="settings-tabs" id="st-tabs">
      ${tabs.map(t => `
      <button class="st-tab${t.id === activeTab ? ' st-tab--active' : ''}" data-tab="${t.id}">
        ${t.icon}
        <span>${t.label}</span>
      </button>`).join('')}
    </div>
    <div class="settings-content" id="settings-content"></div>`;

    function switchTab(id) {
        activeTab = id;
        body.querySelectorAll('.st-tab').forEach(b => b.classList.toggle('st-tab--active', b.dataset.tab === id));
        const content = document.getElementById('settings-content');
        if (content) {
            content.innerHTML = '';
            tabs.find(t => t.id === id)?.render(content);
        }
    }

    body.querySelectorAll('.st-tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    switchTab(activeTab);
}

// ── Tab renderers ──────────────────────────────────────────────────────────

function renderCompanionTab(el) {
    el.innerHTML = `
    <p class="ss-section-title">Identity</p>
    <div class="ss-card">
      <div class="ss-card-row">
        <span class="ss-card-label">Name</span>
        <input id="ss-cname" class="ss-input ss-input--sm" type="text"
          value="${escHtml(prefs.companionName)}" maxlength="24"/>
      </div>
      <div class="ss-card-row">
        <span class="ss-card-label">Personality</span>
        <select id="ss-cpersonality" class="ss-select ss-select--sm">
          <option value="friendly"     ${prefs.personality === 'friendly'     ? 'selected' : ''}>Friendly</option>
          <option value="professional" ${prefs.personality === 'professional' ? 'selected' : ''}>Professional</option>
          <option value="casual"       ${prefs.personality === 'casual'       ? 'selected' : ''}>Casual</option>
          <option value="sarcastic"    ${prefs.personality === 'sarcastic'    ? 'selected' : ''}>Sarcastic</option>
          <option value="meanie"       ${prefs.personality === 'meanie'       ? 'selected' : ''}>Meanie</option>
          <option value="innocent"     ${prefs.personality === 'innocent'     ? 'selected' : ''}>Innocent</option>
        </select>
      </div>
      <div class="ss-card-row">
        <div>
          <div class="ss-card-label">Switch Character</div>
          <div class="ss-card-desc">Choose a different companion</div>
        </div>
        <button id="ss-change-companion" class="ss-link-btn">
          Change
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L7.5 6l-3 3.5"/></svg>
        </button>
      </div>
    </div>

    <p class="ss-section-title">Memory</p>
    <div class="ss-card">
      <div class="ss-card-row">
        <div>
          <div class="ss-card-label">Remember Conversations</div>
          <div class="ss-card-desc">Keep recent context across sessions</div>
        </div>
        <label class="ss-toggle">
          <input type="checkbox" id="ss-mem-toggle" ${prefs.enableMemory ? 'checked' : ''}/>
          <span class="ss-toggle-track"></span>
        </label>
      </div>
    </div>
    <div class="ss-mem-summary" id="ss-mem-summary">${escHtml(memSummary()).replace(/\n/g, '<br>')}</div>
    <div id="ss-clear-mem-warn" class="ss-mem-warn" style="display:none">
      <p class="ss-mem-warn-text">This will permanently delete all remembered context. The companion will forget everything about you.</p>
      <div class="ss-mem-warn-actions">
        <button id="ss-clear-mem-confirm" class="ss-danger-btn ss-danger-btn--sm">Yes, delete everything</button>
        <button id="ss-clear-mem-cancel" class="ss-btn ss-btn--sm ss-btn--ghost">Cancel</button>
      </div>
    </div>
    <button id="ss-clear-mem" class="ss-danger-btn" ${!memHasData() ? 'disabled' : ''}>Clear memory</button>`;

    el.querySelector('#ss-cname').addEventListener('change', e => {
        prefs.companionName = e.target.value.trim() || 'Yuriko';
        saveCurrentProfile();
        syncSettings();
    });
    el.querySelector('#ss-cpersonality').addEventListener('change', e => {
        prefs.personality = e.target.value;
        saveCurrentProfile();
        syncSettings();
        if (window.PixieVRM) window.PixieVRM.setPersonality(e.target.value);
    });
    el.querySelector('#ss-change-companion').addEventListener('click', () => showCompanionSelect(true));
    el.querySelector('#ss-mem-toggle').addEventListener('change', e => {
        prefs.enableMemory = e.target.checked;
    });
    el.querySelector('#ss-clear-mem').addEventListener('click', () => {
        el.querySelector('#ss-clear-mem-warn').style.display = 'block';
        el.querySelector('#ss-clear-mem').style.display = 'none';
    });
    el.querySelector('#ss-clear-mem-cancel').addEventListener('click', () => {
        el.querySelector('#ss-clear-mem-warn').style.display = 'none';
        el.querySelector('#ss-clear-mem').style.display = '';
    });
    el.querySelector('#ss-clear-mem-confirm').addEventListener('click', () => {
        memClear();
        send(W.CLEAR_MEMORY);
        el.querySelector('#ss-mem-summary').textContent = 'No conversations remembered yet.';
        el.querySelector('#ss-clear-mem-warn').style.display = 'none';
        el.querySelector('#ss-clear-mem').style.display = '';
        el.querySelector('#ss-clear-mem').disabled = true;
    });
}

function renderVoiceTab(el) {
    el.innerHTML = `
    <p class="ss-section-title">Playback</p>
    <div class="ss-card">
      <div class="ss-card-row">
        <div>
          <div class="ss-card-label">Voice Responses</div>
          <div class="ss-card-desc">Speak replies aloud via TTS</div>
        </div>
        <label class="ss-toggle">
          <input type="checkbox" id="ss-voice-toggle" ${prefs.voiceEnabled ? 'checked' : ''}/>
          <span class="ss-toggle-track"></span>
        </label>
      </div>
      <div class="ss-card-row">
        <span class="ss-card-label">Speed</span>
        <div class="ss-slider-wrap">
          <input type="range" id="ss-vspeed" class="ss-slider"
            min="0.5" max="2" step="0.1" value="${prefs.voiceSpeed}"/>
          <span id="ss-vspeed-val" class="ss-slider-val">${prefs.voiceSpeed.toFixed(1)}×</span>
        </div>
      </div>
    </div>

    <p class="ss-section-title">Voice Character</p>
    <div class="ss-card">
      <div class="ss-card-row">
        <span class="ss-card-label">Voice</span>
        <select id="ss-vname" class="ss-select ss-select--sm">
          <option value="diana" ${prefs.voiceName === 'diana' ? 'selected' : ''}>Diana</option>
          <option value="tara"  ${prefs.voiceName === 'tara'  ? 'selected' : ''}>Tara</option>
          <option value="leah"  ${prefs.voiceName === 'leah'  ? 'selected' : ''}>Leah</option>
          <option value="jess"  ${prefs.voiceName === 'jess'  ? 'selected' : ''}>Jess</option>
          <option value="zac"   ${prefs.voiceName === 'zac'   ? 'selected' : ''}>Zac</option>
        </select>
      </div>
    </div>`;

    el.querySelector('#ss-voice-toggle').addEventListener('change', e => { prefs.voiceEnabled = e.target.checked; });
    const speedSlider = el.querySelector('#ss-vspeed');
    const speedVal    = el.querySelector('#ss-vspeed-val');
    speedSlider.addEventListener('input', () => {
        const v = parseFloat(speedSlider.value);
        prefs.voiceSpeed = v;
        speedVal.textContent = v.toFixed(1) + '×';
    });
    el.querySelector('#ss-vname').addEventListener('change', e => { prefs.voiceName = e.target.value; syncSettings(); });
}

function renderAppearanceTab(el) {
    const themes    = [{ val: 'vscode', label: 'VS Code' }, { val: 'light', label: 'Light' }, { val: 'dark', label: 'Dark' }];
    const sizes     = [{ val: 'small', label: 'S' }, { val: 'medium', label: 'M' }, { val: 'large', label: 'L' }];
    const bgPresets = ['', '#f5f4ed', '#0d0d0c', '#1a1a2e', '#faf7f2', '#e8f4f8'];

    el.innerHTML = `
    <p class="ss-section-title">Theme</p>
    <div class="ss-card">
      <div class="ss-card-row">
        <div class="ss-chip-group" id="ss-themes">
          ${themes.map(t => `
          <button class="ss-chip ${prefs.theme === t.val ? 'ss-chip--active' : ''}" data-val="${t.val}">${t.label}</button>`).join('')}
        </div>
      </div>
    </div>

    <p class="ss-section-title">Character Size</p>
    <div class="ss-card">
      <div class="ss-card-row">
        <div class="ss-chip-group" id="ss-sizes">
          ${sizes.map(s => `
          <button class="ss-chip ${prefs.charSize === s.val ? 'ss-chip--active' : ''}" data-val="${s.val}">${s.label}</button>`).join('')}
        </div>
      </div>
    </div>

    <p class="ss-section-title">Background Color</p>
    <div class="ss-card">
      <div class="ss-card-row ss-card-row--col">
        <div class="ss-swatches" id="ss-bg">
          ${bgPresets.map(c => `
          <button class="ss-swatch ${prefs.bgColor === c ? 'ss-swatch--active' : ''}"
            data-val="${c}"
            style="background:${c || 'linear-gradient(135deg,#f5f4ed,#eae5dc)'}"
            title="${c || 'default'}"></button>`).join('')}
          <input type="color" id="ss-bg-custom" class="ss-color-pick"
            value="${prefs.bgColor || '#f5f4ed'}" title="Custom color"/>
        </div>
      </div>
    </div>

    <p class="ss-section-title">Wallpaper</p>
    <div class="ss-card">
      <div class="ss-card-row ss-wallpaper-row">
        <div class="ss-wp-preview" id="ss-wp-preview"
          style="${prefs.wallpaper ? `background-image:url(${prefs.wallpaper})` : ''}">
          ${!prefs.wallpaper ? '<span class="ss-wp-placeholder">No image</span>' : ''}
        </div>
        <div class="ss-wp-actions">
          <label class="ss-btn ss-btn--sm" for="ss-wp-input">Choose image</label>
          <input type="file" id="ss-wp-input" accept="image/*" style="display:none">
          <button id="ss-wp-remove" class="ss-btn ss-btn--sm ss-btn--ghost"
            style="${prefs.wallpaper ? '' : 'display:none'}">Remove</button>
        </div>
      </div>
    </div>`;

    el.querySelectorAll('#ss-themes .ss-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('#ss-themes .ss-chip').forEach(b => b.classList.remove('ss-chip--active'));
            btn.classList.add('ss-chip--active');
            prefs.theme = btn.dataset.val;
            const themBtn = document.getElementById('theme-btn');
            if (themBtn) themBtn.dataset.curTheme = btn.dataset.val === 'dark' ? 'dark' : 'light';
        });
    });
    el.querySelectorAll('#ss-sizes .ss-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('#ss-sizes .ss-chip').forEach(b => b.classList.remove('ss-chip--active'));
            btn.classList.add('ss-chip--active');
            prefs.charSize = btn.dataset.val;
        });
    });
    el.querySelectorAll('#ss-bg .ss-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('.ss-swatch').forEach(b => b.classList.remove('ss-swatch--active'));
            btn.classList.add('ss-swatch--active');
            prefs.bgColor = btn.dataset.val;
        });
    });
    el.querySelector('#ss-bg-custom').addEventListener('input', e => {
        el.querySelectorAll('.ss-swatch').forEach(b => b.classList.remove('ss-swatch--active'));
        prefs.bgColor = e.target.value;
    });

    el.querySelector('#ss-wp-input').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                // Resize to max 1400px to keep localStorage usage reasonable
                const MAX = 1400;
                const scale = Math.min(1, MAX / Math.max(img.width, img.height));
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const tmp = document.createElement('canvas');
                tmp.width = w; tmp.height = h;
                tmp.getContext('2d').drawImage(img, 0, 0, w, h);
                const dataUrl = tmp.toDataURL('image/jpeg', 0.88);
                prefs.wallpaper = dataUrl;
                const preview = el.querySelector('#ss-wp-preview');
                if (preview) {
                    preview.style.backgroundImage = `url(${dataUrl})`;
                    preview.innerHTML = '';
                }
                const removeBtn = el.querySelector('#ss-wp-remove');
                if (removeBtn) removeBtn.style.display = '';
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });

    el.querySelector('#ss-wp-remove').addEventListener('click', () => {
        prefs.wallpaper = '';
        const preview = el.querySelector('#ss-wp-preview');
        if (preview) {
            preview.style.backgroundImage = '';
            preview.innerHTML = '<span class="ss-wp-placeholder">No image</span>';
        }
        const removeBtn = el.querySelector('#ss-wp-remove');
        if (removeBtn) removeBtn.style.display = 'none';
    });
}

function renderApiTab(el) {
    el.innerHTML = `
    <p class="ss-section-title">Groq API</p>
    <div class="ss-card">
      <div class="ss-card-row ss-card-row--col">
        <div class="ss-card-label">API Key</div>
        <div class="ss-apikey-wrap">
          <input id="ss-apikey" class="ss-input ss-input--mono" type="password"
            placeholder="gsk_••••••••••••" autocomplete="off" spellcheck="false"/>
          <button id="ss-apikey-save" class="ss-btn">Save</button>
        </div>
        <span id="ss-apikey-msg" class="ss-hint"></span>
      </div>
      <div class="ss-card-row">
        <span class="ss-card-label">LLM Model</span>
        <select id="ss-model" class="ss-select ss-select--sm">
          <option value="llama-3.3-70b-versatile" ${prefs.model === 'llama-3.3-70b-versatile' ? 'selected' : ''}>Llama 3.3 70B</option>
          <option value="llama-3.1-8b-instant"    ${prefs.model === 'llama-3.1-8b-instant'    ? 'selected' : ''}>Llama 3.1 8B</option>
          <option value="mixtral-8x7b-32768"       ${prefs.model === 'mixtral-8x7b-32768'       ? 'selected' : ''}>Mixtral 8×7B</option>
        </select>
      </div>
    </div>
    <button id="ss-clear-key" class="ss-danger-btn" style="margin-top:4px">Clear API key</button>`;

    const keyInput = el.querySelector('#ss-apikey');
    const keyMsg   = el.querySelector('#ss-apikey-msg');

    el.querySelector('#ss-apikey-save').addEventListener('click', () => {
        const key = keyInput.value.trim();
        if (!key || !key.startsWith('gsk_')) {
            keyMsg.textContent = 'Key must start with gsk_';
            keyMsg.style.color = 'var(--red)';
            return;
        }
        send(W.SAVE_API_KEY, { key });
        keyMsg.textContent = 'Saved — reconnecting…';
        keyMsg.style.color = 'var(--muted)';
        keyInput.value = '';
    });
    el.querySelector('#ss-model').addEventListener('change', e => { prefs.model = e.target.value; syncSettings(); });
    el.querySelector('#ss-clear-key').addEventListener('click', () => {
        if (!confirm('Clear API key? You will need to re-enter it.')) return;
        send(W.CLEAR_API_KEY);
        closeSettings();
    });
}

function renderAboutTab(el) {
    el.innerHTML = `
    <div class="ss-about">
      <div class="ss-about-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <circle cx="12" cy="8" r="4"/>
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>
      </div>
      <p class="ss-about-name">Pixie <span class="ss-about-ver">v0.1.0</span></p>
      <p class="ss-about-desc">3D AI voice companion for VS Code.<br>Powered by Groq · three-vrm · Orpheus TTS.</p>
      <div class="ss-card ss-about-link-row">
        <a class="ss-about-link" href="https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english" target="_blank">
          Accept Orpheus TTS terms
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 2.5L7.5 6l-3 3.5"/></svg>
        </a>
        <a class="ss-about-link" href="https://console.groq.com" target="_blank">
          Groq Console
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 2.5L7.5 6l-3 3.5"/></svg>
        </a>
      </div>

      <p class="ss-section-title" style="margin-top:20px">Creator</p>
      <button class="ss-creator-card" id="ss-creator-btn">
        <img class="ss-creator-thumb" src="${window.__creatorUri || ''}" alt="Venkatesh"/>
        <div class="ss-creator-info">
          <span class="ss-creator-cname">Venkatesh Annabathina</span>
          <span class="ss-creator-ctag">Developer &amp; Designer</span>
        </div>
        <svg class="ss-creator-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 2.5L7.5 6l-3 3.5"/></svg>
      </button>
    </div>`;

    el.querySelector('#ss-creator-btn').addEventListener('click', openCreatorCard);
}

function openCreatorCard() {
    let modal = document.getElementById('creator-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'creator-modal';
        modal.className = 'creator-modal';
        modal.innerHTML = `
          <div class="creator-modal-inner">
            <button class="creator-modal-close" id="creator-modal-close" aria-label="Close">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                <line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/>
              </svg>
            </button>

            <div class="creator-card-hero">
              <img class="creator-card-photo" src="${window.__creatorUri || ''}" alt="Venkatesh Annabathina"/>
              <p class="creator-card-headline">from Developer.</p>
            </div>

            <div class="creator-card-body">
              <p class="creator-card-notice-label">Notice:</p>
              <p class="creator-card-notice-text">Sorry guys that I couldn't add all the features I planned to, but I need you to hang tight to get more cool features in the future. Thank You...</p>
            </div>

            <div class="creator-card-footer">
              <div class="creator-card-links">
                <a class="creator-card-link" href="https://github.com/venkateshannabathina" target="_blank">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.38.6.11.82-.26.82-.58v-2.04c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 3-.4c1.02.005 2.04.14 3 .4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/></svg>
                  GitHub
                </a>
                <a class="creator-card-link" href="https://linkedin.com/in/venkatesh-annabathina" target="_blank">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.37V9h3.41v1.56h.05c.47-.9 1.64-1.85 3.37-1.85 3.61 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zm1.78 13.02H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>
                  LinkedIn
                </a>
              </div>
              <p class="creator-card-sig">Venkatesh Annabathina..</p>
            </div>
          </div>`;
        document.getElementById('app').appendChild(modal);
        modal.querySelector('#creator-modal-close').addEventListener('click', closeCreatorCard);
        modal.addEventListener('click', e => { if (e.target === modal) closeCreatorCard(); });
    }
    requestAnimationFrame(() => modal.classList.add('creator-modal--open'));
}

function closeCreatorCard() {
    const modal = document.getElementById('creator-modal');
    if (!modal) return;
    modal.classList.remove('creator-modal--open');
}

// ─── VRM ─────────────────────────────────────────────────────────────────────
function initVRM() {
    const canvas = document.getElementById('vrm-canvas');
    const viewport = document.getElementById('vrm-viewport');
    if (!canvas || !viewport) {
        console.error('[Pixie] initVRM: canvas or viewport not found');
        return;
    }
    canvas.width = viewport.clientWidth || 300;
    canvas.height = viewport.clientHeight || 480;
    if (!window.PixieVRM) {
        console.error('[Pixie] initVRM: window.PixieVRM is not defined — vrm-bundle.js may have failed');
        const loadingEl = document.getElementById('vrm-loading');
        if (loadingEl) { const pct = loadingEl.querySelector('#vrm-pct'); if (pct) pct.textContent = 'bundle load failed'; }
        return;
    }
    window.PixieVRM.init(canvas);
    send(W.REQUEST_VRM, { companion: prefs.companion });
}

async function loadVRM(vrmUri, vrmaUri, animations) {
    if (_vrmLoading) { console.warn('[Pixie] loadVRM: already loading, ignoring duplicate call'); return; }
    _vrmLoading = true;
    console.log('[Pixie] loadVRM uri:', vrmUri);
    if (!window.PixieVRM) {
        console.error('[Pixie] loadVRM: window.PixieVRM not defined');
        _vrmLoading = false;
        return;
    }
    if (animations) vrmAnimations = animations;
    const loadingEl = document.getElementById('vrm-loading');
    const pct = loadingEl ? loadingEl.querySelector('#vrm-pct') : null;
    try {
        await window.PixieVRM.load(vrmUri);
        if (loadingEl) loadingEl.style.display = 'none';
        if (vrmaUri) await window.PixieVRM.loadAnimation(vrmaUri);
        window.PixieVRM.setPersonality(prefs.personality);
    } catch (err) {
        console.error('[Pixie] VRM load failed:', err);
        if (pct) pct.textContent = 'load failed: ' + (err.message || err);
    } finally {
        _vrmLoading = false;
    }
}

// ─── TEXT INPUT ──────────────────────────────────────────────────────────────
function bindTextInput() {
    const input = document.getElementById('text-input');
    const btn   = document.getElementById('text-send-btn');
    if (!input || !btn) return;

    function doSend() {
        const text = input.value.trim();
        if (!text || !clientReady || isBusy) return;
        input.value = '';
        send(W.SEND_TEXT, { text });
    }

    btn.addEventListener('click', doSend);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
}

// ─── INPUT MODE TOGGLE ───────────────────────────────────────────────────────
function setInputMode(mode) {
    _inputMode = mode;
    const bb = document.getElementById('bottom-bar');
    const hud = document.getElementById('mic-hud');
    if (mode === 'mic') {
        if (bb) bb.style.display = 'none';
        if (hud) hud.style.display = 'flex';
    } else {
        if (bb) bb.style.display = '';
        if (hud) hud.style.display = 'none';
        const inp = document.getElementById('text-input');
        if (inp) setTimeout(() => inp.focus(), 50);
    }
}

function bindModeToggle() {
    document.getElementById('mode-toggle-chat')?.addEventListener('click', () => {
        if (!_voiceEnabled || isBusy) return;
        setInputMode('mic');
    });
    document.getElementById('mic-back-btn')?.addEventListener('click', () => {
        if (isBusy) return;
        setInputMode('chat');
    });
}

// ─── SPACE-TO-TALK ───────────────────────────────────────────────────────────
let spaceHeld = false;
let _startListeningSent = false;

function bindSpaceToTalk() {
    window.addEventListener('keydown', e => {
        if (e.code !== 'Space') return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
        e.preventDefault();
        if (e.repeat || spaceHeld) return;
        spaceHeld = true;
        if (!_voiceEnabled || _inputMode !== 'mic') { spaceHeld = false; return; }
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (!clientReady || isBusy) { spaceHeld = false; return; }
        if (currentUIState === 'idle' || currentUIState === 'error') {
            _startListeningSent = true;
            send(W.START_LISTENING);
        }
    });
    window.addEventListener('keyup', e => {
        if (e.code !== 'Space' || !spaceHeld) return;
        spaceHeld = false;
        e.preventDefault();
        // Use _startListeningSent instead of currentUIState — avoids race where
        // SET_STATE:'listening' hasn't arrived yet when the user releases space
        if (_startListeningSent || currentUIState === 'listening') {
            _startListeningSent = false;
            send(W.STOP_LISTENING);
        }
    });
}

// ─── UI STATE ─────────────────────────────────────────────────────────────────
function setUIState(state) {
    currentUIState = state;
    console.log('[AUDIO STATE]', state, '← animations/lighting will update');
    const app = document.getElementById('app');
    if (app) app.dataset.state = state;
    VoiceWave.setMode(state);
    if (window.PixieVRM) window.PixieVRM.setExpression(state);
}

// ─── VOICE ORB (rotating petal flower) ───────────────────────────────────────
const VoiceWave = {
    canvas: null,
    ctx: null,
    mode: 'idle',
    rotation: 0,
    targetScale: 0.30,
    currentScale: 0.30,
    targetAlpha: 0.22,
    currentAlpha: 0.22,
    analyser: null,
    freqData: null,
    running: false,
    color: '#d16b8e',

    init() {
        this.canvas = document.getElementById('vw-orb');
        if (!this.canvas) return;
        this.canvas.width = 64;
        this.canvas.height = 64;
        this.ctx = this.canvas.getContext('2d');
        // Resolve accent color from CSS
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        if (accent) this.color = accent;
        this.running = true;
        const loop = () => { if (!this.running) return; this._tick(); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    },

    setMode(mode) {
        const indicator = document.getElementById('talk-indicator');
        if (indicator) indicator.dataset.state = mode;
        this.mode = mode;
        const cfg = {
            idle:       { scale: 0.30, alpha: 0.22 },
            listening:  { scale: 0.92, alpha: 0.82 },
            processing: { scale: 0.68, alpha: 0.65 },
            speaking:   { scale: 0.95, alpha: 0.85 },
            error:      { scale: 0.48, alpha: 0.50 },
        };
        const c = cfg[mode] || cfg.idle;
        this.targetScale = c.scale;
        this.targetAlpha = c.alpha;
    },

    bindAnalyser(analyser) {
        this.analyser = analyser;
        this.freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    },

    _tick() {
        const ctx = this.ctx;
        if (!ctx) return;
        const W = this.canvas.width, H = this.canvas.height;
        const cx = W / 2, cy = H / 2;

        // Rotation speed per frame
        const speeds = { idle: 0.0028, listening: 0.0075, processing: 0.024, speaking: 0.010, error: 0.020 };
        this.rotation += speeds[this.mode] || 0.004;

        // Audio amplitude
        let amp = 0;
        if (this.analyser && this.freqData && (this.mode === 'listening' || this.mode === 'speaking')) {
            this.analyser.getByteFrequencyData(this.freqData);
            let sum = 0;
            for (let i = 2; i < 28; i++) sum += this.freqData[i];
            amp = sum / (26 * 255);
        }

        // Smooth lerp
        this.currentScale += (this.targetScale - this.currentScale) * 0.07;
        this.currentAlpha += (this.targetAlpha - this.currentAlpha) * 0.07;

        const scale = this.currentScale + amp * 0.18;
        const perPetalAlpha = Math.min(0.55, (this.currentAlpha + amp * 0.15) / 6 * 2.8);

        ctx.clearRect(0, 0, W, H);

        // 6 elongated ellipses centered at canvas center, each rotated evenly
        // screen blend = overlapping petals glow brighter at center
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = this.color;
        ctx.globalAlpha = perPetalAlpha;

        const rX = cx * 0.38 * scale;
        const rY = cy * 0.88 * scale;

        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI + this.rotation;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.ellipse(0, 0, rX, rY, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    },
};

function flashError(msg) {
    console.error('[pixie]', msg);
    console.error('[DEBUG] Error message:', msg);
    const prev = currentUIState;
    setUIState('error');
    setTimeout(() => { if (currentUIState === 'error') setUIState('idle'); }, 2200);
}

// ─── AUDIO ────────────────────────────────────────────────────────────────────
async function playAudio(base64Data) {
    console.log('[Pixie] playAudio: voiceEnabled=', prefs.voiceEnabled);
    if (!prefs.voiceEnabled) { send(W.TTS_DONE); return; }
    // Always create a fresh AudioContext if the old one is closed/broken
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch {}
    }
    // If still suspended after resume attempt, recreate
    if (audioCtx.state === 'suspended') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    console.log('[Pixie] playAudio: audioCtx state=', audioCtx.state);

    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    console.log('[Pixie] playAudio: decoded base64, bytes=', bytes.length);

    try {
        const decoded = await audioCtx.decodeAudioData(bytes.buffer);
        console.log('[Pixie] playAudio: audio decoded, duration=', decoded.duration.toFixed(2), 's');
        const source = audioCtx.createBufferSource();
        source.buffer = decoded;
        source.playbackRate.value = prefs.voiceSpeed;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        VoiceWave.bindAnalyser(analyser);

        const data = new Uint8Array(analyser.fftSize);
        let isPlaying = true;
        let ttsFinished = false;

        function finishTTS() {
            if (ttsFinished) return;
            ttsFinished = true;
            isPlaying = false;
            if (window.PixieVRM) window.PixieVRM.setLipSync(0);
            VoiceWave.bindAnalyser(null);
            send(W.TTS_DONE);
        }

        function tick() {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128.0; sum += v * v; }
            const rms = Math.sqrt(sum / data.length);
            if (window.PixieVRM) window.PixieVRM.setLipSync(rms);
            if (isPlaying) requestAnimationFrame(tick);
        }

        source.onended = () => {
            console.log('[Pixie] playAudio: source ended');
            finishTTS();
        };
        // Safety fallback in case onended never fires (e.g. in hidden webview)
        setTimeout(finishTTS, Math.ceil(decoded.duration * 1000) + 3000);
        console.log('[Pixie] playAudio: starting source');
        source.start(0);
        tick();
    } catch (err) {
        console.error('[Pixie] Audio decode error:', err);
        flashError('Audio failed: ' + (err?.message || String(err)));
        send(W.TTS_DONE);
    }
}

// ─── UTIL ─────────────────────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ─── HOST MESSAGE DISPATCHER ──────────────────────────────────────────────────
// All messages from the host (panel.js) arrive here. Use H.* constants.
async function onHostMessage(e) {
    const msg = e.data;
    switch (msg.type) {

        case H.SHOW_SCREEN:
            if (!shellReady) { queuedScreen = msg.screen; return; }
            applyScreen(msg.screen);
            break;

        case H.SHOW_ERROR:
            if (!shellReady) { buildShell(); }
            flashError(msg.message);
            break;

        case H.SET_STATE:
            isBusy = msg.state !== 'idle' && msg.state !== 'error';
            if (msg.state === 'idle' || msg.state === 'error') _startListeningSent = false;
            setUIState(msg.state);
            if (msg.state === 'idle' && window.PixieVRM) window.PixieVRM.setPersonality(prefs.personality);
            break;

        case H.LOAD_VRM:
            await loadVRM(msg.vrmUri, msg.vrmaUri, msg.animations);
            break;

        case H.UPLOAD_VRM_DONE:
            closeWizard();
            if (msg.success) {
                syncSettings();
                if (window.__vrmUploadFromSettings) {
                    const overlay = document.getElementById('companion-select-overlay');
                    if (overlay) overlay.style.display = 'none';
                    send(W.REQUEST_VRM, { companion: 'custom' });
                } else {
                    prefs.firstTimeDone = true;
                    buildShell();
                }
            } else {
                showCompanionUploadError(msg.error || 'Upload failed.');
            }
            window.__vrmUploadFromSettings = undefined;
            break;

        case H.MEMORY_UPDATED:
            memSetSummary(msg.summary);
            break;

        case H.USER_SAID:
            memAdd('user', msg.text);
            break;

        case H.LLM_WORD_CHUNK:
            break;

        case H.LLM_DONE:
            break;

        case H.PIXIE_SAID:
            memAdd('pixie', msg.text);
            if (window.PixieVRM) {
                const emotion = msg.emotion || analyzeSentiment(msg.text);
                window.PixieVRM.setSentiment(emotion);
            }
            break;

        case H.PLAY_AUDIO:
            await playAudio(msg.audioBase64);
            break;

        case H.ERROR:
            flashError(msg.message);
            isBusy = false;
            break;

        case H.INIT_STATE:
            _voiceEnabled = msg.voiceEnabled !== false;
            if (!_voiceEnabled) {
                // Show SoX banner; hide mic toggle so user can't switch to mic mode
                const banner = document.getElementById('sox-banner');
                if (banner) banner.style.display = 'flex';
                const micBtn = document.getElementById('mode-toggle-chat');
                if (micBtn) micBtn.style.display = 'none';
            }
            break;
    }
}
window.addEventListener('message', onHostMessage);

// Android → WebView message bridge
window.receiveFromAndroid = function(json) {
    try {
        const data = JSON.parse(json);
        onHostMessage({ data });
    } catch(e) {
        console.error('[Pixie] receiveFromAndroid parse error', e);
    }
};

// ─── SENTIMENT ANALYSIS ───────────────────────────────────────────────────────
function analyzeSentiment(text) {
    const t = text.toLowerCase();
    if (/\b(angry|furious|rage|outraged|infuriated|irritated|annoyed|mad at|hate|disgusted|unacceptable|ridiculous|outrage)\b/.test(t)) return 'angry';
    if (/\b(suspicious|fishy|sketchy|strange|weird|odd|doesn't add up|something's off|doubt|skeptical|not convinced|questionable|shady|sus|suss)\b/.test(t)) return 'suspicious';
    if (/\b(sorry|apologize|unfortunately|regret|failed|cannot|can't|unable|my bad|forgive|pardon|mistake|oops)\b/.test(t)) return 'apologetic';
    if (/\b(sad|sorrow|cry|tear|weep|heartache|painful|tragic|awful|terrible|horrible|dreadful|grief|mourn|heartbroken|disappoint)\b/.test(t)) return 'sad';
    if (/\b(understand|feel your|empathize|must be hard|difficult time|there for you|support you|with you|i hear you|that sounds rough|hang in there)\b/.test(t)) return 'empathetic';
    if (/!!|wow|omg|oh my|unbelievable|mind-?blown|whoa|holy/.test(t) || /\b(excited|thrilled|pumped|ecstatic|can't believe|no way|seriously)\b/.test(t)) return 'excited';
    if (/\b(fun|game|play|joke|haha|lol|hilarious|entertaining|silly|goofy|prank|meme|laugh|cracking up|comedic)\b/.test(t)) return 'fun';
    if (/\b(love|joy|delight|wonderful|amazing|awesome|fantastic|brilliant|perfect|great|happy|cheerful|gleeful|overjoyed|beautiful|incredible)\b/.test(t) || /!/.test(t)) return 'joy';
    if (/\b(obviously|clearly|of course|naturally|technically|ironic|irony|sarcastic|predictable|well actually|classic|typical|as expected)\b/.test(t)) return 'smirk';
    if (/\b(just kidding|jk|gotcha|teasing|playful|pulling your leg|kidding|tease|banter|cheeky)\b/.test(t)) return 'teasing';
    if (/\b(definitely|absolutely|certainly|without a doubt|clearly|precisely|exactly|of course|i know|trust me|guaranteed)\b/.test(t)) return 'confident';
    if (/\b(here is|here are|the following|in summary|to summarize|note that|please note|calm|relax|breathe|peace|serene|gentle|chill)\b/.test(t)) return 'calm';
    if (/\?/.test(t) || /\b(what|how|why|when|where|which|who|wonder|curious|interesting|fascinating|i wonder)\b/.test(t)) return 'question';
    return null;
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
const _probe = document.getElementById('js-probe');
if (_probe) _probe.remove();

if (!prefs.firstTimeDone) {
    runOnboarding();
} else {
    buildShell();
}
