/* =========================================================
   ENGSTRO — client application
   ========================================================= */
(() => {
  'use strict';

  // ---------- API configuration ----------
  // Telegram Bot API calls go through a same-origin relay (/api/telegram/<method>)
  // that holds the bot token server-side in TELEGRAM_BOT_TOKEN, so it is never
  // exposed in the browser bundle. Each method maps 1:1 to the Bot API endpoint.
  const TELEGRAM_API = (method) => `/api/telegram/${method}`;
  const TG = {
    text: TELEGRAM_API('sendMessage'),
    photo: TELEGRAM_API('sendPhoto'),
    video: TELEGRAM_API('sendVideo'),
    audio: TELEGRAM_API('sendAudio'),
    voice: TELEGRAM_API('sendVoice'),
    document: TELEGRAM_API('sendDocument'),
  };
  const DIAGNOSE_API = '/api/diagnose';

  // ---------- Limits ----------
  const MB = 1024 * 1024;
  const MAX_FILE_BYTES = 100 * MB;
  const TELEGRAM_UPLOAD_CAP = 50 * MB; // Bot API hard limit for multipart uploads
  const MAX_VIDEO_SECONDS = 10;
  const MAX_AUDIO_SECONDS = 30;
  const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'log'];
  const TEXT_EXTENSIONS = ['txt', 'log', 'csv'];
  const PDF_INLINE_LIMIT = 1 * MB; // only PDFs this small are base64-inlined for the diagnostic engine
  const UPLOAD_TIMEOUT_MS = 90 * 1000;

  const STORE = {
    theme: 'engstro:theme',
    chatId: 'engstro:chatId',
    forward: 'engstro:autoForward',
    log: 'engstro:log',
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    feed: $('#feed'),
    empty: $('#emptyState'),
    composer: $('#composer'),
    prompt: $('#prompt'),
    send: $('#sendBtn'),
    attachBtn: $('#attachBtn'),
    attachMenu: $('#attachMenu'),
    preview: $('#attachPreview'),
    mic: $('#micBtn'),
    recorder: $('#recorder'),
    recWave: $('#recWave'),
    recTime: $('#recTime'),
    recStop: $('#recStop'),
    recCancel: $('#recCancel'),
    theme: $('#themeToggle'),
    install: $('#installBtn'),
    settingsBtn: $('#settingsBtn'),
    settings: $('#settingsPanel'),
    chatIdInput: $('#chatIdInput'),
    chatSource: $('#chatSource'),
    linkDot: $('#linkDot'),
    autoForward: $('#autoForward'),
    saveChatId: $('#saveChatId'),
    testTelegram: $('#testTelegram'),
    clearChat: $('#clearChat'),
    toasts: $('#toasts'),
    files: {
      image: $('#fileImage'),
      video: $('#fileVideo'),
      audio: $('#fileAudio'),
      document: $('#fileDoc'),
    },
  };

  const GEAR_PATH = document.querySelector('.brand-gear path').getAttribute('d');

  const state = {
    attachment: null, // { kind, file, name, size, mime, duration, objectUrl }
    busy: false,
    history: [], // { role, text, ts, attachment?: meta }
    deferredPrompt: null,
  };

  // =========================================================
  // Telegram Web App
  // =========================================================
  const tgApp = window.Telegram && window.Telegram.WebApp;
  const tgUserId = tgApp && tgApp.initDataUnsafe && tgApp.initDataUnsafe.user && tgApp.initDataUnsafe.user.id;
  if (tgApp) {
    try {
      tgApp.ready();
      tgApp.expand();
    } catch (_) {}
  }

  function getChatId() {
    if (tgUserId) return String(tgUserId);
    return (localStorage.getItem(STORE.chatId) || '').trim();
  }

  function autoForwardEnabled() {
    return localStorage.getItem(STORE.forward) !== 'off';
  }

  function refreshLinkUi() {
    const id = getChatId();
    el.linkDot.classList.toggle('on', !!id);
    el.chatSource.classList.toggle('on', !!id);
    if (tgUserId) {
      el.chatSource.textContent = 'Auto · Telegram';
      el.chatIdInput.value = String(tgUserId);
      el.chatIdInput.disabled = true;
    } else {
      el.chatSource.textContent = id ? 'Linked · Manual' : 'Not linked';
      el.chatIdInput.value = id;
    }
    el.autoForward.checked = autoForwardEnabled();
  }

  async function telegramCall(endpoint, body) {
    const isForm = body instanceof FormData;
    // For FormData, leave Content-Type unset: the browser writes
    // `multipart/form-data; boundary=…` itself and streams the File parts
    // from disk (no Base64, no in-memory copy). A hand-set header would lose
    // the boundary and Telegram would reject the body.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'Upload timed out — check your connection and try again.' : 'Network error while contacting Telegram.');
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.description || `Telegram error (${res.status})`);
    return data;
  }

  function tgText(chatId, text) {
    return telegramCall(TG.text, { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true });
  }

  // kind → Bot API multipart field; the field name matches the method
  // (sendVoice ↔ `voice`, so n8n's Telegram trigger sees a Voice message).
  function tgMedia(chatId, kind, file, filename, caption, { duration } = {}) {
    const field = { photo: 'photo', video: 'video', audio: 'audio', voice: 'voice', document: 'document' }[kind];
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append(field, file, filename);
    if (caption) form.append('caption', caption.slice(0, 1024));
    if (duration && (kind === 'voice' || kind === 'audio' || kind === 'video')) form.append('duration', String(Math.round(duration)));
    return telegramCall(TG[kind], form);
  }

  // =========================================================
  // Theme
  // =========================================================
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el.theme.setAttribute('aria-checked', String(theme === 'dark'));
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', theme === 'dark' ? '#0F0F12' : '#F8F9FA'));
    try {
      tgApp && tgApp.setHeaderColor && tgApp.setHeaderColor(theme === 'dark' ? '#0F0F12' : '#F8F9FA');
    } catch (_) {}
  }
  if (!localStorage.getItem(STORE.theme) && tgApp && tgApp.colorScheme) {
    applyTheme(tgApp.colorScheme);
  } else {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  }
  el.theme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORE.theme, next);
    applyTheme(next);
  });

  // =========================================================
  // PWA install + service worker
  // =========================================================
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (isStandalone()) return;
    state.deferredPrompt = e;
    el.install.hidden = false;
  });
  el.install.addEventListener('click', async () => {
    const prompt = state.deferredPrompt;
    if (!prompt) return;
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    state.deferredPrompt = null;
    el.install.hidden = true;
    if (choice && choice.outcome === 'accepted') toast('success', 'Installing', 'ENGSTRO is being added to your device.');
  });
  window.addEventListener('appinstalled', () => {
    el.install.hidden = true;
    state.deferredPrompt = null;
  });
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', (e) => {
    if (e.matches) el.install.hidden = true;
  });
  if (isStandalone()) el.install.hidden = true;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // =========================================================
  // Toasts
  // =========================================================
  function toast(type, title, message, ms = 4200) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<div><b></b><span></span></div>`;
    t.querySelector('b').textContent = title;
    t.querySelector('span').textContent = message;
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
    try {
      if (type === 'error') tgApp?.HapticFeedback?.notificationOccurred('error');
    } catch (_) {}
    setTimeout(() => {
      t.classList.add('leaving');
      t.addEventListener('animationend', () => t.remove(), { once: true });
    }, ms);
  }

  // =========================================================
  // Settings panel
  // =========================================================
  function toggleSettings(open) {
    const show = open ?? el.settings.hidden;
    el.settings.hidden = !show;
    el.settingsBtn.setAttribute('aria-expanded', String(show));
    if (show && !tgUserId) setTimeout(() => el.chatIdInput.focus(), 50);
  }
  el.settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings();
  });
  el.settings.addEventListener('click', (e) => e.stopPropagation());
  el.saveChatId.addEventListener('click', () => {
    if (!tgUserId) {
      const v = el.chatIdInput.value.trim();
      if (v && !/^-?\d{4,20}$/.test(v)) {
        toast('error', 'Invalid chat ID', 'A Telegram chat ID is a number, e.g. 123456789.');
        return;
      }
      if (v) localStorage.setItem(STORE.chatId, v);
      else localStorage.removeItem(STORE.chatId);
    }
    localStorage.setItem(STORE.forward, el.autoForward.checked ? 'on' : 'off');
    refreshLinkUi();
    toggleSettings(false);
    toast('success', 'Settings saved', getChatId() ? 'Reports will be delivered to your Telegram chat.' : 'Telegram delivery is off until a chat ID is set.');
  });
  el.autoForward.addEventListener('change', () => localStorage.setItem(STORE.forward, el.autoForward.checked ? 'on' : 'off'));
  el.testTelegram.addEventListener('click', async () => {
    const id = tgUserId ? String(tgUserId) : el.chatIdInput.value.trim();
    if (!id) return toast('error', 'No chat ID', 'Enter your Telegram chat ID first.');
    el.testTelegram.disabled = true;
    try {
      await tgText(id, '⚙️ ENGSTRO link test — your diagnostics console is connected.');
      toast('success', 'Telegram linked', 'Test message delivered.');
    } catch (err) {
      toast('error', 'Telegram failed', err.message);
    } finally {
      el.testTelegram.disabled = false;
    }
  });
  el.clearChat.addEventListener('click', () => {
    if (!confirm('Clear the diagnostic log on this device?')) return;
    state.history = [];
    localStorage.removeItem(STORE.log);
    el.feed.querySelectorAll('.msg').forEach((n) => n.remove());
    el.empty.hidden = false;
    toggleSettings(false);
  });

  document.addEventListener('click', () => {
    toggleSettings(false);
    toggleAttachMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleSettings(false);
      toggleAttachMenu(false);
    }
  });

  // =========================================================
  // Attachments (all optional)
  // =========================================================
  function toggleAttachMenu(open) {
    const show = open ?? el.attachMenu.hidden;
    el.attachMenu.hidden = !show;
    el.attachBtn.setAttribute('aria-expanded', String(show));
  }
  el.attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (recorder.active) return;
    toggleAttachMenu();
  });
  el.attachMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    toggleAttachMenu(false);
    el.files[btn.dataset.pick].click();
  });
  Object.entries(el.files).forEach(([kind, input]) => {
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) await acceptFile(kind, file);
    });
  });

  const ext = (name) => (name.split('.').pop() || '').toLowerCase();
  const fmtSize = (b) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const fmtDur = (s) => `${s.toFixed(1)}s`;

  function mediaDuration(file, tag) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const media = document.createElement(tag);
      media.preload = 'metadata';
      const done = (d) => {
        URL.revokeObjectURL(url);
        resolve(d);
      };
      media.onloadedmetadata = () => {
        if (media.duration === Infinity) {
          // Some recorders omit duration; force the browser to compute it
          media.currentTime = 1e101;
          media.ontimeupdate = () => {
            media.ontimeupdate = null;
            done(media.duration);
          };
        } else done(media.duration);
      };
      media.onerror = () => done(NaN);
      media.src = url;
    });
  }

  async function acceptFile(kind, file, extra = {}) {
    if (file.size > MAX_FILE_BYTES) {
      toast('error', 'File too large', `"${file.name}" is ${fmtSize(file.size)}. The maximum is 100 MB.`);
      return;
    }
    if (kind === 'document' && !DOC_EXTENSIONS.includes(ext(file.name))) {
      toast('error', 'Unsupported document', 'Use PDF, Word (.doc/.docx), Excel (.xls/.xlsx/.csv) or Text (.txt/.log).');
      return;
    }
    if (kind === 'image' && !file.type.startsWith('image/')) {
      toast('error', 'Unsupported file', 'Please choose an image file.');
      return;
    }
    let duration = extra.duration;
    if (kind === 'video') {
      if (!file.type.startsWith('video/')) return toast('error', 'Unsupported file', 'Please choose a video file.');
      duration = await mediaDuration(file, 'video');
      if (!isFinite(duration)) return toast('error', 'Unreadable video', 'This video format could not be read by your browser.');
      if (duration > MAX_VIDEO_SECONDS + 0.05) {
        toast('error', 'Video too long', `Clip is ${fmtDur(duration)}. Video clips are limited to ${MAX_VIDEO_SECONDS} seconds.`);
        return;
      }
    }
    if (kind === 'audio' && duration == null) {
      if (!file.type.startsWith('audio/')) return toast('error', 'Unsupported file', 'Please choose an audio file.');
      duration = await mediaDuration(file, 'audio');
      if (!isFinite(duration)) return toast('error', 'Unreadable audio', 'This audio format could not be read by your browser.');
      if (duration > MAX_AUDIO_SECONDS + 0.05) {
        toast('error', 'Audio too long', `Recording is ${fmtDur(duration)}. Audio is limited to ${MAX_AUDIO_SECONDS} seconds.`);
        return;
      }
    }
    clearAttachment();
    state.attachment = {
      kind,
      file,
      name: file.name,
      size: file.size,
      mime: file.type,
      duration: isFinite(duration) ? duration : undefined,
      voice: !!extra.voice || undefined,
      objectUrl: URL.createObjectURL(file),
    };
    renderPreview();
    updateSendState();
    el.prompt.focus();
  }

  function clearAttachment() {
    if (state.attachment && state.attachment.objectUrl && !state.attachment.sent) URL.revokeObjectURL(state.attachment.objectUrl);
    state.attachment = null;
    el.preview.hidden = true;
    el.preview.innerHTML = '';
    updateSendState();
  }

  function attachmentCard(a, { removable = false } = {}) {
    const card = document.createElement('div');
    card.className = 'att-card';
    let thumb;
    if (a.kind === 'image' && a.objectUrl) {
      thumb = document.createElement('img');
      thumb.src = a.objectUrl;
      thumb.alt = '';
    } else if (a.kind === 'video' && a.objectUrl) {
      thumb = document.createElement('video');
      thumb.src = a.objectUrl;
      thumb.muted = true;
      thumb.playsInline = true;
      thumb.preload = 'metadata';
    } else {
      thumb = document.createElement('div');
      thumb.className = 'att-ico';
      thumb.textContent = a.voice ? '🎙' : a.kind === 'audio' ? '♪' : a.kind === 'video' ? 'VID' : a.kind === 'image' ? 'IMG' : ext(a.name).toUpperCase().slice(0, 4);
    }
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'att-info';
    const name = document.createElement('span');
    name.className = 'att-name';
    name.textContent = a.name;
    const sub = document.createElement('span');
    sub.className = 'att-sub';
    sub.textContent = [a.voice ? 'VOICE' : a.kind.toUpperCase(), fmtSize(a.size), a.duration ? fmtDur(a.duration) : null].filter(Boolean).join(' · ');
    info.append(name, sub);
    if (a.kind === 'audio' && a.objectUrl) {
      const player = document.createElement('audio');
      player.controls = true;
      player.src = a.objectUrl;
      info.appendChild(player);
    }
    card.appendChild(info);

    if (removable) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'icon-btn small att-remove';
      rm.setAttribute('aria-label', 'Remove attachment');
      rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      rm.addEventListener('click', clearAttachment);
      card.appendChild(rm);
    }
    return card;
  }

  function renderPreview() {
    el.preview.innerHTML = '';
    if (!state.attachment) return (el.preview.hidden = true);
    el.preview.appendChild(attachmentCard(state.attachment, { removable: true }));
    el.preview.hidden = false;
  }

  // Prepare a compact representation of the attachment for the diagnostic engine
  function imageToDataUrl(src, maxSide = 1280) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve(undefined);
      img.src = src;
    });
  }

  function videoFrame(src, maxSide = 1280) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadeddata = () => {
        v.currentTime = Math.min(1, (v.duration || 2) / 2);
      };
      v.onseeked = () => {
        const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale);
        c.height = Math.round(v.videoHeight * scale);
        try {
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.8));
        } catch (_) {
          resolve(undefined);
        }
      };
      v.onerror = () => resolve(undefined);
      setTimeout(() => resolve(undefined), 5000);
      v.src = src;
    });
  }

  const readAsDataUrl = (file) =>
    new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(file);
    });

  async function buildAiAttachment(a) {
    const out = { kind: a.kind, name: a.name, size: a.size, mime: a.mime, duration: a.duration };
    try {
      if (a.kind === 'image') out.dataUrl = await imageToDataUrl(a.objectUrl);
      else if (a.kind === 'video') out.dataUrl = await videoFrame(a.objectUrl);
      else if (a.kind === 'document') {
        const e = ext(a.name);
        if (TEXT_EXTENSIONS.includes(e)) out.textExcerpt = (await a.file.slice(0, 40000).text()).slice(0, 20000);
        else if (e === 'pdf' && a.size <= PDF_INLINE_LIMIT) out.dataUrl = await readAsDataUrl(a.file);
      }
    } catch (_) {}
    return out;
  }

  // =========================================================
  // Voice recorder (max 30s)
  // =========================================================
  const recorder = { active: false, media: null, stream: null, chunks: [], start: 0, raf: 0, ctx: null, analyser: null, cancelled: false };

  // Voice notes are exported as OGG/Opus (Telegram's native voice format, read
  // by Groq Whisper) or WAV. OGG is recorded directly where supported (Firefox);
  // WebM/Opus (Chrome, Edge, Safari 18.4+) is remuxed losslessly into OGG;
  // anything else (older Safari's MP4/AAC) is decoded and re-encoded as WAV.
  function pickMime() {
    const types = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  // ---- WebM (Matroska) → Ogg Opus remux, no re-encoding ----
  function readVint(b, p, keepMarker) {
    const first = b[p];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || p + len > b.length) return null;
    let v = keepMarker ? first : first & (0xff >> len);
    let allOnes = v === (0xff >> len);
    for (let i = 1; i < len; i++) {
      v = v * 256 + b[p + i];
      if (b[p + i] !== 0xff) allOnes = false;
    }
    return { v, len, unknown: !keepMarker && allOnes };
  }

  function parseWebmOpus(b) {
    const MASTER = new Set([0x18538067, 0x1f43b675, 0x1654ae6b, 0xae, 0xe1, 0xa0]); // Segment, Cluster, Tracks, TrackEntry, Audio, BlockGroup
    const out = { head: null, channels: 1, packets: [] };
    let p = 0;
    while (p < b.length) {
      const id = readVint(b, p, true);
      if (!id) break;
      const size = readVint(b, p + id.len, false);
      if (!size) break;
      const start = p + id.len + size.len;
      if (MASTER.has(id.v) || size.unknown) {
        p = start; // descend into children
        continue;
      }
      const end = start + size.v;
      if (end > b.length) break;
      if (id.v === 0x63a2) out.head = b.slice(start, end); // CodecPrivate = OpusHead
      else if (id.v === 0x9f) out.channels = b[start]; // Channels
      else if (id.v === 0xa3 || id.v === 0xa1) {
        // SimpleBlock / Block: track vint, int16 timecode, flags, frame
        const track = readVint(b, start, false);
        const flags = b[start + track.len + 2];
        if (flags & 0x06) throw new Error('laced blocks unsupported');
        out.packets.push(b.slice(start + track.len + 3, end));
      }
      p = end;
    }
    if (!out.packets.length) throw new Error('no audio');
    return out;
  }

  function opusSamples(pkt) {
    const toc = pkt[0];
    const cfg = toc >> 3;
    const ms = cfg < 12 ? [10, 20, 40, 60][cfg & 3] : cfg < 16 ? [10, 20][cfg & 1] : [2.5, 5, 10, 20][cfg & 3];
    const c = toc & 3;
    const frames = c === 0 ? 1 : c < 3 ? 2 : pkt[1] & 0x3f;
    return frames * ms * 48;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      t[i] = r >>> 0;
    }
    return t;
  })();

  function oggPage(packets, granule, serial, seq, type) {
    const lacing = [];
    packets.forEach((pk) => {
      let n = pk.length;
      while (n >= 255) {
        lacing.push(255);
        n -= 255;
      }
      lacing.push(n);
    });
    const bodyLen = packets.reduce((a, pk) => a + pk.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLen);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53, 0, type]); // "OggS", version, header type
    dv.setUint32(6, granule % 0x100000000, true);
    dv.setUint32(10, Math.floor(granule / 0x100000000), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    packets.forEach((pk) => {
      page.set(pk, o);
      o += pk.length;
    });
    let crc = 0;
    for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
    dv.setUint32(22, crc, true);
    return page;
  }

  function webmToOgg(buffer) {
    const { head: rawHead, channels, packets } = parseWebmOpus(new Uint8Array(buffer));
    let head = rawHead;
    if (!head || String.fromCharCode(...head.slice(0, 8)) !== 'OpusHead') {
      head = new Uint8Array(19);
      const hv = new DataView(head.buffer);
      head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels || 1]);
      hv.setUint16(10, 312, true); // pre-skip
      hv.setUint32(12, 48000, true);
    }
    const enc = new TextEncoder();
    const vendor = enc.encode('ENGSTRO');
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(enc.encode('OpusTags'));
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);

    const serial = (Math.random() * 0xffffffff) >>> 0;
    const pages = [oggPage([head], 0, serial, 0, 0x02), oggPage([tags], 0, serial, 1, 0)];
    let seq = 2;
    let granule = new DataView(head.buffer, head.byteOffset).getUint16(10, true);
    let batch = [];
    let segs = 0;
    packets.forEach((pk, i) => {
      const need = Math.floor(pk.length / 255) + 1;
      if (batch.length && (segs + need > 255 || batch.length >= 50)) {
        pages.push(oggPage(batch, granule, serial, seq++, 0));
        batch = [];
        segs = 0;
      }
      batch.push(pk);
      segs += need;
      granule += opusSamples(pk);
      if (i === packets.length - 1) pages.push(oggPage(batch, granule, serial, seq++, 0x04));
    });
    return new Blob(pages, { type: 'audio/ogg' });
  }

  // ---- Fallback: decode → 16 kHz mono 16-bit PCM WAV (Whisper's native rate) ----
  async function blobToWav(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    } finally {
      ctx.close().catch(() => {});
    }
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const wav = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (o, t) => [...t].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    wav.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVEfmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true); // PCM
    wav.setUint16(22, 1, true); // mono
    wav.setUint32(24, rate, true);
    wav.setUint32(28, rate * 2, true);
    wav.setUint16(32, 2, true);
    wav.setUint16(34, 16, true);
    str(36, 'data');
    wav.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.max(-1, Math.min(1, pcm[i]));
      wav.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([wav], { type: 'audio/wav' });
  }

  async function exportVoice(chunks, recordedType) {
    const raw = new Blob(chunks, { type: recordedType });
    if (recordedType.includes('ogg')) return { blob: new Blob(chunks, { type: 'audio/ogg' }), extn: 'ogg' };
    if (recordedType.includes('webm')) {
      try {
        return { blob: webmToOgg(await raw.arrayBuffer()), extn: 'ogg' };
      } catch (_) {
        /* fall through to WAV */
      }
    }
    return { blob: await blobToWav(raw), extn: 'wav' };
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('error', 'Recorder unavailable', 'Voice recording is not supported in this browser.');
      return;
    }
    try {
      recorder.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
    } catch (_) {
      toast('error', 'Microphone blocked', 'Allow microphone access to record a voice note.');
      return;
    }
    const mime = pickMime();
    recorder.media = new MediaRecorder(recorder.stream, mime ? { mimeType: mime } : undefined);
    recorder.chunks = [];
    recorder.cancelled = false;
    recorder.media.ondataavailable = (e) => e.data.size && recorder.chunks.push(e.data);
    recorder.media.onstop = finishRecording;
    recorder.media.start(250);
    recorder.start = performance.now();
    recorder.active = true;

    // Live waveform
    try {
      recorder.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = recorder.ctx.createMediaStreamSource(recorder.stream);
      recorder.analyser = recorder.ctx.createAnalyser();
      recorder.analyser.fftSize = 256;
      src.connect(recorder.analyser);
    } catch (_) {}

    el.recorder.hidden = false;
    el.mic.classList.add('recording');
    el.mic.setAttribute('aria-label', 'Stop recording');
    updateSendState();
    try {
      tgApp?.HapticFeedback?.impactOccurred('medium');
    } catch (_) {}
    tick();
  }

  function tick() {
    if (!recorder.active) return;
    const elapsed = (performance.now() - recorder.start) / 1000;
    el.recTime.textContent = `${elapsed.toFixed(1).padStart(4, '0')} / ${MAX_AUDIO_SECONDS}s`;
    el.recTime.classList.toggle('near', elapsed > MAX_AUDIO_SECONDS - 5);
    drawWave();
    if (elapsed >= MAX_AUDIO_SECONDS) {
      toast('warn', 'Limit reached', `Voice notes stop automatically at ${MAX_AUDIO_SECONDS} seconds.`);
      stopRecording();
      return;
    }
    recorder.raf = requestAnimationFrame(tick);
  }

  function drawWave() {
    const c = el.recWave;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#FFD700';
    g.fillStyle = color;
    const bars = Math.max(8, Math.floor(w / 5));
    let data = null;
    if (recorder.analyser) {
      data = new Uint8Array(recorder.analyser.frequencyBinCount);
      recorder.analyser.getByteFrequencyData(data);
    }
    for (let i = 0; i < bars; i++) {
      const v = data ? data[Math.floor((i / bars) * data.length * 0.7)] / 255 : 0.15;
      const bh = Math.max(3, v * h);
      g.globalAlpha = 0.45 + v * 0.55;
      g.fillRect(i * 5, (h - bh) / 2, 3, bh);
    }
    g.globalAlpha = 1;
  }

  function stopRecording(cancel = false) {
    if (!recorder.active) return;
    recorder.cancelled = cancel;
    recorder.duration = Math.min(MAX_AUDIO_SECONDS, (performance.now() - recorder.start) / 1000);
    recorder.active = false;
    cancelAnimationFrame(recorder.raf);
    try {
      recorder.media.state !== 'inactive' && recorder.media.stop();
    } catch (_) {}
    recorder.stream && recorder.stream.getTracks().forEach((t) => t.stop());
    recorder.ctx && recorder.ctx.close().catch(() => {});
    recorder.ctx = recorder.analyser = null;
    el.recorder.hidden = true;
    el.mic.classList.remove('recording');
    el.mic.setAttribute('aria-label', 'Record voice note (max 30s)');
    updateSendState();
  }

  async function finishRecording() {
    if (recorder.cancelled || !recorder.chunks.length) return;
    const type = recorder.media.mimeType || 'audio/webm';
    let voice;
    try {
      voice = await exportVoice(recorder.chunks, type);
    } catch (_) {
      toast('error', 'Recording failed', 'The voice note could not be converted to OGG or WAV.');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const file = new File([voice.blob], `voice-note-${stamp}.${voice.extn}`, { type: voice.blob.type });
    acceptFile('audio', file, { duration: recorder.duration, voice: true });
  }

  el.mic.addEventListener('click', () => (recorder.active ? stopRecording() : startRecording()));
  el.recStop.addEventListener('click', () => stopRecording());
  el.recCancel.addEventListener('click', () => stopRecording(true));

  // =========================================================
  // Markdown → safe HTML (subset used by diagnostic reports)
  // =========================================================
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*\[(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*|\[(CRITICAL|HIGH|MEDIUM|LOW)\]/gi, (_, a, b) => {
        const lvl = (a || b).toLowerCase();
        return `<span class="sev ${lvl}">${lvl.toUpperCase()}</span>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function renderMarkdown(src) {
    const lines = src.replace(/\r/g, '').split('\n');
    let html = '';
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`;
      para = [];
    };
    const closeList = () => {
      if (list) html += `</${list}>`;
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara();
        closeList();
        const buf = [];
        while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i]);
        html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        flushPara();
        closeList();
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        html += `<table><thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
        i++;
        while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) {
          html += `<tr>${cells(lines[++i]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
        }
        html += '</tbody></table>';
        continue;
      }
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        flushPara();
        closeList();
        html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
      } else if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
        flushPara();
        closeList();
        html += '<hr>';
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ul') {
          closeList();
          html += '<ul>';
          list = 'ul';
        }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (list !== 'ol') {
          closeList();
          html += '<ol>';
          list = 'ol';
        }
        html += `<li>${inline(m[1])}</li>`;
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
    return html;
  }

  const toPlain = (md) =>
    md
      .replace(/^#{1,4}\s+(.*)$/gm, (_, t) => `▌${t.toUpperCase()}`)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '• ');

  // =========================================================
  // Chat feed
  // =========================================================
  const timeStr = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const reportId = (ts) => `ENG-${(ts % 1e6).toString(36).toUpperCase().padStart(4, '0')}`;

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      el.feed.scrollTo({ top: el.feed.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  function tgStatusEl(initial) {
    const s = document.createElement('span');
    setTgStatus(s, initial);
    return s;
  }
  function setTgStatus(node, status, detail) {
    const labels = { pending: 'Sending to Telegram…', uploading: 'Uploading to Telegram…', ok: 'Delivered to Telegram', err: 'Telegram failed', off: 'Telegram not linked', skip: 'Telegram: local only' };
    node.className = `tg-status ${status === 'skip' ? 'off' : status}`;
    node.textContent = labels[status] || '';
    if (detail) node.title = detail;
  }

  // Spinner + indeterminate bar on the sent message while a file uploads.
  function startUploadIndicator(statusNode, att) {
    setTgStatus(statusNode, 'uploading');
    const msg = statusNode.closest('.msg');
    const bar = document.createElement('div');
    bar.className = 'upload-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `Uploading ${att.name}`);
    const label = document.createElement('span');
    label.className = 'upload-label';
    const track = document.createElement('span');
    track.className = 'upload-track';
    bar.append(label, track);
    const card = msg && msg.querySelector('.att-card');
    if (card) card.after(bar);
    else if (msg) msg.prepend(bar);
    const started = performance.now();
    const update = () => {
      const secs = Math.floor((performance.now() - started) / 1000);
      label.textContent = `Uploading ${fmtSize(att.size)}${secs ? ` · ${secs}s` : ''}`;
      statusNode.textContent = `Uploading ${fmtSize(att.size)}…`;
    };
    update();
    const timer = setInterval(update, 1000);
    return () => {
      clearInterval(timer);
      bar.remove();
    };
  }

  function addUserMessage(entry, { live = false } = {}) {
    el.empty.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    if (entry.attachment) wrap.appendChild(attachmentCard(entry.attachment));
    if (entry.text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = entry.text;
      wrap.appendChild(b);
    }
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span>${timeStr(entry.ts)}</span>`;
    let status = null;
    if (live) {
      status = tgStatusEl(getChatId() ? (autoForwardEnabled() ? 'pending' : 'skip') : 'off');
      meta.appendChild(status);
    }
    wrap.appendChild(meta);
    el.feed.appendChild(wrap);
    scrollToBottom();
    return status;
  }

  function gearIcon(cls) {
    return `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true"><path d="${GEAR_PATH}"/><circle cx="32" cy="32" r="9" fill="var(--card)"/></svg>`;
  }

  function addThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'msg ai';
    wrap.innerHTML = `
      <div class="report">
        <div class="scanning">${gearIcon('scan-gear')}<span class="scan-text">Running diagnostics…</span></div>
        <div class="scan-bar"></div>
      </div>`;
    el.feed.appendChild(wrap);
    const phrases = ['Running diagnostics…', 'Analysing symptoms…', 'Cross-checking failure modes…', 'Compiling report…'];
    let i = 0;
    const timer = setInterval(() => {
      const t = wrap.querySelector('.scan-text');
      if (t) t.textContent = phrases[++i % phrases.length];
    }, 1800);
    scrollToBottom();
    return {
      remove() {
        clearInterval(timer);
        wrap.remove();
      },
    };
  }

  function addReport(entry, { error = false, live = false } = {}) {
    el.empty.hidden = true;
    const wrap = document.createElement('div');
    wrap.className = 'msg ai';
    const sevMatch = /\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i.exec(entry.text);
    const sev = sevMatch ? sevMatch[1].toLowerCase() : null;
    wrap.innerHTML = `
      <article class="report${error ? ' error' : ''}">
        <header class="report-head">
          ${gearIcon('r-ico')}
          <span class="report-title">${error ? 'System Notice' : 'Diagnostic Report'}</span>
          <span class="report-id">${reportId(entry.ts)} · ${timeStr(entry.ts)}</span>
          ${sev ? `<span class="sev ${sev}">${sev.toUpperCase()}</span>` : ''}
        </header>
        <div class="report-body"></div>
        <footer class="report-foot">
          <button class="r-act" type="button" data-act="copy">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copy
          </button>
          <button class="r-act" type="button" data-act="telegram">
            <svg viewBox="0 0 24 24"><path d="M21.5 4.5 2.8 11.7c-.9.4-.9 1.6.1 1.9l4.6 1.4 1.8 5.6c.2.7 1.1.9 1.6.4l2.6-2.5 4.9 3.6c.6.4 1.4.1 1.6-.6L23 5.8c.2-.9-.7-1.6-1.5-1.3Z"/></svg>Send to Telegram
          </button>
        </footer>
      </article>`;
    wrap.querySelector('.report-body').innerHTML = renderMarkdown(entry.text);
    const foot = wrap.querySelector('.report-foot');
    let status = null;
    if (live && !error) {
      status = tgStatusEl(getChatId() ? (autoForwardEnabled() ? 'pending' : 'skip') : 'off');
      foot.appendChild(status);
    }
    if (error) foot.querySelector('[data-act="telegram"]').remove();

    foot.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'copy') {
        try {
          await navigator.clipboard.writeText(entry.text);
          toast('success', 'Copied', 'Report copied to clipboard.', 2200);
        } catch (_) {
          toast('error', 'Copy failed', 'Clipboard access is not available.');
        }
      } else {
        const id = getChatId();
        if (!id) {
          toast('warn', 'Telegram not linked', 'Add your chat ID in Telegram Link settings.');
          toggleSettings(true);
          return;
        }
        btn.disabled = true;
        try {
          await tgText(id, `🛠 ENGSTRO · ${reportId(entry.ts)}\n\n${toPlain(entry.text)}`);
          toast('success', 'Sent', 'Report delivered to Telegram.', 2500);
        } catch (err) {
          toast('error', 'Telegram failed', err.message);
        } finally {
          btn.disabled = false;
        }
      }
    });

    el.feed.appendChild(wrap);
    scrollToBottom();
    return status;
  }

  // ---------- persistence (local device log) ----------
  function saveLog() {
    try {
      const slim = state.history.slice(-60).map((h) => ({
        role: h.role,
        text: h.text,
        ts: h.ts,
        error: h.error || undefined,
        attachment: h.attachment ? { kind: h.attachment.kind, name: h.attachment.name, size: h.attachment.size, duration: h.attachment.duration, voice: h.attachment.voice } : undefined,
      }));
      localStorage.setItem(STORE.log, JSON.stringify(slim));
    } catch (_) {}
  }

  function restoreLog() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE.log) || '[]');
      state.history = saved;
      saved.forEach((h) => (h.role === 'user' ? addUserMessage(h) : addReport(h, { error: h.error })));
      if (saved.length) scrollToBottom(false);
    } catch (_) {
      state.history = [];
    }
  }

  // =========================================================
  // Send flow
  // =========================================================
  function updateSendState() {
    const hasContent = el.prompt.value.trim().length > 0 || !!state.attachment;
    el.send.disabled = state.busy || recorder.active || !hasContent;
  }

  function autoGrow() {
    el.prompt.style.height = 'auto';
    el.prompt.style.height = `${Math.min(el.prompt.scrollHeight, 180)}px`;
  }
  el.prompt.addEventListener('input', () => {
    autoGrow();
    updateSendState();
  });
  el.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });

  document.querySelectorAll('.chip[data-prompt]').forEach((chip) =>
    chip.addEventListener('click', () => {
      el.prompt.value = chip.dataset.prompt;
      autoGrow();
      updateSendState();
      el.prompt.focus();
    }),
  );

  async function forwardQuery(chatId, text, att, statusNode) {
    try {
      if (att) {
        if (att.size > TELEGRAM_UPLOAD_CAP) {
          throw new Error('Telegram bots can only upload files up to 50 MB — the file was analysed but not forwarded.');
        }
        // Recorded voice notes go through sendVoice so n8n fires its Voice event.
        const telegramKind = att.voice ? 'voice' : att.kind === 'image' ? 'photo' : att.kind;
        const caption = `🛠 ENGSTRO query${text ? `\n\n${text}` : ''}`;
        const stopIndicator = startUploadIndicator(statusNode, att);
        try {
          await tgMedia(chatId, telegramKind, att.file, att.name, caption.length <= 1024 ? caption : '🛠 ENGSTRO query (details below)', {
            duration: att.duration,
          });
        } finally {
          stopIndicator();
        }
        if (caption.length > 1024) await tgText(chatId, text);
      } else {
        await tgText(chatId, `🛠 ENGSTRO query\n\n${text}`);
      }
      setTgStatus(statusNode, 'ok');
    } catch (err) {
      setTgStatus(statusNode, 'err', err.message);
      toast('error', 'Telegram delivery failed', err.message);
    }
  }

  el.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy || recorder.active) return;
    const text = el.prompt.value.trim();
    const att = state.attachment;
    if (!text && !att) return;

    state.busy = true;
    const ts = Date.now();
    const priorHistory = state.history.filter((h) => !h.error).map((h) => ({ role: h.role, text: h.text })).filter((h) => h.text);
    const entry = { role: 'user', text, ts, attachment: att ? { ...att } : undefined };
    if (att) state.attachment.sent = true; // keep object URL alive for the feed card
    state.history.push(entry);
    saveLog();

    const statusNode = addUserMessage(entry, { live: true });
    el.prompt.value = '';
    autoGrow();
    state.attachment = null;
    el.preview.hidden = true;
    el.preview.innerHTML = '';
    updateSendState();

    const chatId = getChatId();
    const forward = chatId && autoForwardEnabled();
    const forwarding = forward ? forwardQuery(chatId, text, att, statusNode) : Promise.resolve();

    const thinking = addThinking();
    let report;
    let failed = false;
    try {
      const aiAttachment = att ? await buildAiAttachment(att) : null;
      const res = await fetch(DIAGNOSE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, attachment: aiAttachment, history: priorHistory }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.report) throw new Error(data.error || 'The diagnostic engine did not respond.');
      report = data.report;
    } catch (err) {
      failed = true;
      report = `**Diagnostic engine unreachable.** ${err.message || ''}\n\nYour query${att ? ' and attachment were' : ' was'} kept in the log${forward ? ' and forwarded to Telegram' : ''}. Check your connection and try again.`;
      toast('error', 'Diagnostics offline', err.message || 'Request failed.');
    }
    thinking.remove();

    const aiEntry = { role: 'assistant', text: report, ts: Date.now(), error: failed || undefined };
    state.history.push(aiEntry);
    saveLog();
    const reportStatus = addReport(aiEntry, { error: failed, live: true });

    if (!failed && forward) {
      await forwarding;
      try {
        await tgText(chatId, `📋 ENGSTRO DIAGNOSTIC REPORT · ${reportId(aiEntry.ts)}\n\n${toPlain(report)}`);
        setTgStatus(reportStatus, 'ok');
      } catch (err) {
        setTgStatus(reportStatus, 'err', err.message);
      }
    }

    state.busy = false;
    updateSendState();
    try {
      tgApp?.HapticFeedback?.notificationOccurred(failed ? 'error' : 'success');
    } catch (_) {}
  });

  // =========================================================
  // Boot
  // =========================================================
  refreshLinkUi();
  restoreLog();
  updateSendState();
})();
