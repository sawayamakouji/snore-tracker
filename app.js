(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    startBtn: $('startBtn'), stopBtn: $('stopBtn'), testBtn: $('testBtn'),
    elapsed: $('elapsed'), meterFill: $('meterFill'), liveLabel: $('liveLabel'), liveDb: $('liveDb'),
    eventCount: $('eventCount'), snoreDuration: $('snoreDuration'), snoreRate: $('snoreRate'), strongCount: $('strongCount'),
    timeline: $('timeline'), eventList: $('eventList'), threshold: $('threshold'), thresholdLabel: $('thresholdLabel'),
    historyList: $('historyList'), exportCsvBtn: $('exportCsvBtn'), exportJsonBtn: $('exportJsonBtn'), clearBtn: $('clearBtn'),
    secureStatus: $('secureStatus'), permissionDialog: $('permissionDialog'), dialogOk: $('dialogOk'), dialogCancel: $('dialogCancel')
  };

  const STORAGE_KEY = 'snoreTracker.sessions.v1';
  const SETTINGS_KEY = 'snoreTracker.settings.v1';
  const SAMPLE_INTERVAL = 200;
  const MIN_EVENT_MS = 800;
  const END_GRACE_MS = 1400;

  let audioCtx = null;
  let analyser = null;
  let stream = null;
  let source = null;
  let timer = null;
  let wakeLock = null;
  let session = null;
  let candidateStartedAt = null;
  let activeEvent = null;
  let lastSnoreLikeAt = null;
  let testTimeout = null;

  const settings = loadSettings();
  els.threshold.value = settings.threshold;
  els.thresholdLabel.textContent = `${settings.threshold} dB`;

  function loadSettings() {
    try { return { threshold: -42, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
    catch { return { threshold: -42 }; }
  }

  function loadSessions() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }

  function saveSessions(sessions) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 30)));
  }

  function formatClock(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function formatDuration(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return `${Math.round(ms / 1000)}秒`;
    if (mins < 60) return `${mins}分`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${h}時間${m ? `${m}分` : ''}`;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString('ja-JP', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function sumEventMs(s) {
    return s.events.reduce((sum, e) => sum + Math.max(0, (e.end || Date.now()) - e.start), 0);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {}
  }

  async function releaseWakeLock() {
    try { await wakeLock?.release(); } catch (_) {}
    wakeLock = null;
  }

  function setSecureStatus() {
    const isLocalhost = ['localhost','127.0.0.1'].includes(location.hostname);
    const ok = window.isSecureContext || isLocalhost;
    els.secureStatus.textContent = ok ? 'マイク利用OK' : 'HTTPSが必要';
    els.secureStatus.className = `status-pill ${ok ? 'ok' : 'warn'}`;
    if (!ok) {
      els.startBtn.disabled = true;
      els.testBtn.disabled = true;
    }
  }

  async function initAudio() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  }

  async function cleanupAudio() {
    if (timer) clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach(t => t.stop());
    try { source?.disconnect(); } catch (_) {}
    try { analyser?.disconnect(); } catch (_) {}
    try { await audioCtx?.close(); } catch (_) {}
    stream = source = analyser = audioCtx = null;
    els.meterFill.style.width = '0%';
    els.liveDb.textContent = '-- dB';
  }

  function analyzeFrame() {
    if (!analyser || !audioCtx) return null;
    const timeData = new Uint8Array(analyser.fftSize);
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);

    let sumSq = 0;
    for (const v of timeData) {
      const n = (v - 128) / 128;
      sumSq += n * n;
    }
    const rms = Math.sqrt(sumSq / timeData.length);
    const db = 20 * Math.log10(Math.max(rms, 0.000001));

    const binHz = audioCtx.sampleRate / analyser.fftSize;
    const band = (low, high) => {
      const a = Math.max(0, Math.floor(low / binHz));
      const b = Math.min(freqData.length - 1, Math.ceil(high / binHz));
      let total = 0;
      for (let i=a;i<=b;i++) total += freqData[i] * freqData[i];
      return total / Math.max(1, b-a+1);
    };
    const low = band(70, 500);
    const mid = band(500, 1400);
    const high = band(1400, 3200);
    const total = low + mid + high + 1;
    const lowRatio = low / total;
    const tonalRatio = low / (mid + high + 1);

    return { db, lowRatio, tonalRatio };
  }

  function isSnoreLike(f) {
    const threshold = Number(settings.threshold);
    return f.db >= threshold && f.lowRatio >= 0.45 && f.tonalRatio >= 0.82;
  }

  function sample() {
    if (!session) return;
    const f = analyzeFrame();
    if (!f) return;
    const now = Date.now();
    const threshold = Number(settings.threshold);
    const meterPct = Math.max(0, Math.min(100, ((f.db + 70) / 50) * 100));
    els.meterFill.style.width = `${meterPct}%`;
    els.liveDb.textContent = `${Math.round(f.db)} dB`;

    const snoreLike = isSnoreLike(f);
    if (snoreLike) {
      lastSnoreLikeAt = now;
      if (!candidateStartedAt) candidateStartedAt = now;
      const held = now - candidateStartedAt;
      els.liveLabel.textContent = held >= MIN_EVENT_MS ? 'いびき候補' : '音を確認中';

      if (!activeEvent && held >= MIN_EVENT_MS) {
        activeEvent = {
          start: candidateStartedAt,
          end: now,
          maxDb: f.db,
          strong: f.db >= threshold + 10
        };
        session.events.push(activeEvent);
      } else if (activeEvent) {
        activeEvent.end = now;
        activeEvent.maxDb = Math.max(activeEvent.maxDb, f.db);
        activeEvent.strong ||= f.db >= threshold + 10;
      }
    } else {
      els.liveLabel.textContent = '静か';
      if (activeEvent && lastSnoreLikeAt && now - lastSnoreLikeAt > END_GRACE_MS) {
        activeEvent.end = lastSnoreLikeAt;
        activeEvent = null;
        candidateStartedAt = null;
        lastSnoreLikeAt = null;
      } else if (!activeEvent && candidateStartedAt && now - candidateStartedAt > 700) {
        candidateStartedAt = null;
      }
    }

    session.samples.push({ t: now, db: Math.round(f.db), snore: snoreLike ? 1 : 0 });
    if (session.samples.length > 5000) session.samples.splice(0, session.samples.length - 5000);
    renderLive();
  }

  function renderLive() {
    if (!session) return;
    const now = Date.now();
    const elapsed = now - session.startedAt;
    const snoreMs = sumEventMs(session);
    const strong = session.events.filter(e => e.strong).length;
    els.elapsed.textContent = formatClock(elapsed);
    els.eventCount.textContent = `${session.events.length}回`;
    els.snoreDuration.textContent = formatDuration(snoreMs);
    els.snoreRate.textContent = `測定時間の ${elapsed ? ((snoreMs/elapsed)*100).toFixed(1) : '0.0'}%`;
    els.strongCount.textContent = `${strong}回`;
    renderTimeline(session, now);
    renderEventList(session.events);
  }

  function renderTimeline(s, endTs = s.endedAt || Date.now()) {
    const canvas = els.timeline;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(300, Math.floor(rect.width * dpr));
    canvas.height = 150 * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = rect.width, h = 150;
    ctx.clearRect(0,0,w,h);

    const pad = 18, top = 28, barH = 48;
    const start = s.startedAt;
    const span = Math.max(1, endTs - start);
    ctx.fillStyle = '#111827';
    ctx.fillRect(pad, top, w-pad*2, barH);

    for (const e of s.events) {
      const x = pad + ((e.start-start)/span) * (w-pad*2);
      const ew = Math.max(3, (((e.end || endTs)-e.start)/span) * (w-pad*2));
      ctx.fillStyle = e.strong ? '#fb7185' : '#60a5fa';
      ctx.fillRect(x, top, ew, barH);
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(formatTime(start).slice(0,5), pad, top + barH + 24);
    ctx.textAlign = 'right';
    ctx.fillText(formatTime(endTs).slice(0,5), w-pad, top + barH + 24);

    const pct = span ? (sumEventMs(s)/span)*100 : 0;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`いびき推定 ${pct.toFixed(1)}%`, pad, 18);
  }

  function renderEventList(events) {
    if (!events.length) {
      els.eventList.innerHTML = '<p class="empty">まだイベントはありません。</p>';
      return;
    }
    els.eventList.innerHTML = [...events].reverse().slice(0, 12).map(e => `
      <div class="event-row">
        <div>${formatTime(e.start).slice(0,5)}</div>
        <div><span class="event-level ${e.strong ? 'strong' : 'normal'}">${e.strong ? '強いいびき' : 'いびき候補'}</span></div>
        <div class="event-meta">${formatDuration((e.end||Date.now())-e.start)} / 最大 ${Math.round(e.maxDb)}dB</div>
      </div>
    `).join('');
  }

  function renderHistory() {
    const sessions = loadSessions();
    if (!sessions.length) {
      els.historyList.innerHTML = '<p class="empty">保存された測定はありません。</p>';
      return;
    }
    els.historyList.innerHTML = sessions.map(s => {
      const elapsed = Math.max(1, s.endedAt - s.startedAt);
      const snoreMs = sumEventMs(s);
      const pct = (snoreMs/elapsed)*100;
      return `<div class="history-item">
        <div>
          <div class="history-title">${formatDate(s.startedAt)}</div>
          <div class="history-meta">測定 ${formatDuration(elapsed)} ・ ${s.events.length}回 ・ 強い ${s.events.filter(e=>e.strong).length}回</div>
        </div>
        <div class="history-score"><strong>${pct.toFixed(1)}%</strong><div class="history-meta">いびき推定率</div></div>
      </div>`;
    }).join('');
  }

  async function startSession() {
    if (session) return;
    try {
      await initAudio();
      await requestWakeLock();
      session = { id: crypto.randomUUID?.() || `${Date.now()}`, startedAt: Date.now(), endedAt: null, threshold: Number(settings.threshold), events: [], samples: [] };
      candidateStartedAt = activeEvent = lastSnoreLikeAt = null;
      els.startBtn.classList.add('hidden');
      els.stopBtn.classList.remove('hidden');
      els.testBtn.disabled = true;
      timer = setInterval(sample, SAMPLE_INTERVAL);
      sample();
    } catch (err) {
      alert(`マイクを開始できませんでした.\n${err?.message || err}`);
      await cleanupAudio();
    }
  }

  async function stopSession({ save = true } = {}) {
    if (!session) return;
    const now = Date.now();
    if (activeEvent) activeEvent.end = lastSnoreLikeAt || now;
    session.endedAt = now;
    if (save) {
      const sessions = loadSessions();
      sessions.unshift({ ...session, samples: [] });
      saveSessions(sessions);
    }
    await cleanupAudio();
    await releaseWakeLock();
    renderTimeline(session, session.endedAt);
    renderEventList(session.events);
    renderHistory();
    session = null;
    activeEvent = candidateStartedAt = lastSnoreLikeAt = null;
    els.startBtn.classList.remove('hidden');
    els.stopBtn.classList.add('hidden');
    els.testBtn.disabled = false;
    els.liveLabel.textContent = '待機中';
  }

  async function runMicTest() {
    if (session) return;
    els.testBtn.disabled = true;
    try {
      await initAudio();
      const started = Date.now();
      els.liveLabel.textContent = 'マイクテスト中';
      timer = setInterval(() => {
        const f = analyzeFrame();
        if (!f) return;
        const pct = Math.max(0, Math.min(100, ((f.db + 70) / 50) * 100));
        els.meterFill.style.width = `${pct}%`;
        els.liveDb.textContent = `${Math.round(f.db)} dB`;
        els.elapsed.textContent = formatClock(Date.now() - started);
      }, SAMPLE_INTERVAL);
      testTimeout = setTimeout(async () => {
        await cleanupAudio();
        els.testBtn.disabled = false;
        els.liveLabel.textContent = '待機中';
        els.elapsed.textContent = '00:00:00';
      }, 10000);
    } catch (err) {
      alert(`マイクテストを開始できませんでした.\n${err?.message || err}`);
      els.testBtn.disabled = false;
      await cleanupAudio();
    }
  }

  function download(name, text, type='text/plain') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    const sessions = loadSessions();
    const rows = [['date','start','end','duration_min','snore_events','strong_events','snore_minutes','snore_rate_pct','threshold_db']];
    for (const s of sessions) {
      const elapsed = s.endedAt - s.startedAt;
      const snoreMs = sumEventMs(s);
      rows.push([
        new Date(s.startedAt).toLocaleDateString('ja-JP'),
        new Date(s.startedAt).toISOString(), new Date(s.endedAt).toISOString(),
        (elapsed/60000).toFixed(2), s.events.length, s.events.filter(e=>e.strong).length,
        (snoreMs/60000).toFixed(2), ((snoreMs/elapsed)*100).toFixed(2), s.threshold
      ]);
    }
    const csv = '\uFEFF' + rows.map(r => r.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
    download(`snore-tracker-${new Date().toISOString().slice(0,10)}.csv`, csv, 'text/csv;charset=utf-8');
  }

  function exportJson() {
    download(`snore-tracker-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(loadSessions(), null, 2), 'application/json');
  }

  els.startBtn.addEventListener('click', () => {
    if (els.permissionDialog.showModal) els.permissionDialog.showModal(); else startSession();
  });
  els.dialogOk.addEventListener('click', () => { els.permissionDialog.close(); startSession(); });
  els.dialogCancel.addEventListener('click', () => els.permissionDialog.close());
  els.stopBtn.addEventListener('click', () => stopSession({ save: true }));
  els.testBtn.addEventListener('click', runMicTest);
  els.threshold.addEventListener('input', () => {
    settings.threshold = Number(els.threshold.value);
    els.thresholdLabel.textContent = `${settings.threshold} dB`;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  });
  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.exportJsonBtn.addEventListener('click', exportJson);
  els.clearBtn.addEventListener('click', () => {
    if (confirm('保存した測定履歴をすべて削除しますか？')) {
      localStorage.removeItem(STORAGE_KEY); renderHistory();
    }
  });
  window.addEventListener('resize', () => {
    if (session) renderTimeline(session); else {
      const h = loadSessions()[0]; if (h) renderTimeline(h, h.endedAt);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session) requestWakeLock();
  });
  window.addEventListener('beforeunload', (e) => {
    if (session) { e.preventDefault(); e.returnValue = ''; }
  });

  setSecureStatus();
  renderHistory();
  const last = loadSessions()[0];
  if (last) renderTimeline(last, last.endedAt);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(()=>{}));
  }
})();
