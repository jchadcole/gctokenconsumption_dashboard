'use strict';
(() => {
  const CATS = [
    { id: 'bot', label: 'Bots', short: 'Bot', color: 'var(--series-bot)' },
    { id: 'va', label: 'Virtual Agents', short: 'Virtual Agent', color: 'var(--series-va)' },
    { id: 'ava', label: 'Agentic Virtual Agents', short: 'AVA', color: 'var(--series-ava)' },
  ];
  const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));
  const MS_KEYS = ['divisionIds', 'flowIds', 'mediaTypes', 'languages', 'botProducts'];
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
  // Tokens are whole numbers when TOKEN_ROUNDING is on; decimals only show when it is turned off.
  const fmtTok = (n) => (Number.isInteger(Math.round(n * 1e9) / 1e9) ? fmt(n, 0) : fmt(n, Math.abs(n) < 10 ? 2 : Math.abs(n) < 100 ? 1 : 0));
  // Voice time as minutes:seconds, e.g. 4.25 -> "4:15", so it is never confused with whole billed minutes.
  const fmtMin = (m) => {
    if (m === null || m === undefined || Number.isNaN(m)) return '–';
    const total = Math.round(m * 60);
    return `${Math.floor(total / 60).toLocaleString()}:${String(total % 60).padStart(2, '0')}`;
  };
  // Billed voice minutes: whole for a single range total, fractional for a row's share of it.
  const fmtBilledMin = (m) => (m === null || m === undefined || Number.isNaN(m) ? '–' : Number(m).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const compact = (n) => (Math.abs(n) >= 1000 ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : Number(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 1 ? 3 : Math.abs(n) < 10 ? 2 : 0 }));
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = () => iso(new Date());
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

  const state = {
    preset: 'thisMonth', start: '', end: '', granularity: 'day', categories: [],
    divisionIds: [], flowIds: [], mediaTypes: [], languages: [], botProducts: [], includeUnmetered: false,
    tab: 'byFlow', sort: { key: 'tokens', dir: 'desc' }, scale: 'auto',
  };
  let catalog = null; let cfg = null; let lastUsage = null; let options = {};

  // ---------- theme ----------
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  $('#themeToggle').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch {}
    if (lastUsage) renderChart(lastUsage.summary.series);
  };

  // ---------- URL state ----------
  function readUrl() {
    const p = new URLSearchParams(location.search);
    for (const k of ['preset', 'start', 'end', 'granularity', 'tab', 'scale']) if (p.get(k)) state[k] = p.get(k);
    for (const k of ['categories', ...MS_KEYS]) if (p.get(k)) state[k] = p.get(k).split(',').filter(Boolean);
    state.includeUnmetered = p.get('includeUnmetered') === '1';
  }
  function queryString(forUrl) {
    const p = new URLSearchParams();
    if (forUrl) p.set('preset', state.preset);
    p.set('start', state.start); p.set('end', state.end); p.set('granularity', state.granularity);
    for (const k of ['categories', ...MS_KEYS]) if (state[k].length) p.set(k, state[k].join(','));
    if (state.includeUnmetered) p.set('includeUnmetered', '1');
    if (forUrl && state.tab !== 'byFlow') p.set('tab', state.tab);
    if (forUrl && state.scale !== 'auto') p.set('scale', state.scale);
    return p.toString();
  }

  function applyPreset(preset) {
    const t = today();
    const m0 = `${t.slice(0, 7)}-01`;
    if (preset === 'thisMonth') { state.start = m0; state.end = t; }
    if (preset === 'lastMonth') { const e = addDays(m0, -1); state.start = `${e.slice(0, 7)}-01`; state.end = e; }
    if (preset === 'last7') { state.start = addDays(t, -6); state.end = t; }
    if (preset === 'last30') { state.start = addDays(t, -29); state.end = t; }
    if (preset === 'last90') { state.start = addDays(t, -89); state.end = t; }
  }

  // ---------- API ----------
  async function api(path) {
    const res = await fetch(path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }
  function showError(msg) { const el = $('#error'); el.hidden = !msg; el.textContent = msg || ''; }

  // ---------- multi-selects ----------
  const msLabels = { divisionIds: 'All divisions', flowIds: 'All bots & flows', mediaTypes: 'All media', languages: 'All languages', botProducts: 'All products' };
  function buildMultiSelects() {
    for (const key of MS_KEYS) {
      const host = document.querySelector(`[data-ms="${key}"]`);
      if (!host.querySelector('.ms-btn')) {
        const btn = document.createElement('button');
        btn.className = 'ms-btn'; btn.type = 'button'; btn.setAttribute('aria-haspopup', 'listbox');
        btn.onclick = (e) => { e.stopPropagation(); togglePop(host, key); };
        host.appendChild(btn);
      }
      updateMsButton(key);
    }
  }
  function updateMsButton(key) {
    const btn = document.querySelector(`[data-ms="${key}"] .ms-btn`);
    const sel = state[key];
    const opts = options[key] || [];
    btn.classList.toggle('has', sel.length > 0);
    btn.textContent = !sel.length ? msLabels[key] : sel.length === 1 ? (opts.find((o) => o.value === sel[0])?.label || sel[0]) : `${sel.length} selected`;
  }
  function closePops() { document.querySelectorAll('.ms-pop').forEach((p) => p.remove()); }
  document.addEventListener('click', (e) => { if (!e.target.closest('.ms-pop')) closePops(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePops(); });

  function togglePop(host, key) {
    const open = host.querySelector('.ms-pop');
    closePops();
    if (open) return;
    const pop = document.createElement('div');
    pop.className = 'ms-pop';
    pop.addEventListener('click', (e) => e.stopPropagation());
    const opts = options[key] || [];
    const draft = new Set(state[key]);
    pop.innerHTML = `${opts.length > 8 ? '<input type="search" placeholder="Search…" aria-label="Search options">' : ''}<div class="ms-list" role="listbox"></div>
      <div class="ms-foot"><button data-a="clear" type="button">Clear</button><button data-a="apply" type="button"><b>Apply</b></button></div>`;
    const listEl = $('.ms-list', pop);
    const draw = (q = '') => {
      const ql = q.toLowerCase();
      const shown = opts.filter((o) => !ql || `${o.label} ${o.sub || ''}`.toLowerCase().includes(ql));
      listEl.innerHTML = shown.length ? shown.map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${draft.has(o.value) ? 'checked' : ''}>
        <span>${o.color ? `<span class="cat"><i style="--c:${o.color}"></i></span> ` : ''}${esc(o.label)}${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</span></label>`).join('')
        : '<div class="muted small" style="padding:6px">No options for this range</div>';
    };
    draw();
    listEl.addEventListener('change', (e) => { if (e.target.checked) draft.add(e.target.value); else draft.delete(e.target.value); });
    $('input[type=search]', pop)?.addEventListener('input', (e) => draw(e.target.value));
    $('[data-a=clear]', pop).onclick = () => { draft.clear(); draw($('input[type=search]', pop)?.value || ''); };
    $('[data-a=apply]', pop).onclick = () => { state[key] = [...draft]; closePops(); refresh(); };
    host.appendChild(pop);
    $('input[type=search]', pop)?.focus();
  }

  function computeOptions(filterOptions) {
    const flows = (catalog?.flows || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const divs = new Map();
    for (const f of flows) if (f.divisionId) divs.set(f.divisionId, f.divisionName || f.divisionId);
    options = {
      divisionIds: [...divs].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
      flowIds: flows.map((f) => ({
        value: f.id, label: f.name, color: CAT[f.category].color,
        sub: [CAT[f.category].short, f.flowType, f.divisionName, f.avas?.length ? `AVA: ${f.avas.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(' · '),
      })),
      mediaTypes: (filterOptions?.mediaTypes || []).map((v) => ({ value: v, label: v })),
      languages: (filterOptions?.languages || []).map((v) => ({ value: v, label: v })),
      botProducts: (filterOptions?.botProducts || []).map((v) => ({ value: v, label: v.replace(/^Genesys/, 'Genesys ') })),
    };
    MS_KEYS.forEach(updateMsButton);
  }

  // ---------- controls ----------
  function renderCategoryChips() {
    $('#categories').innerHTML = CATS.map((c) => {
      const on = !state.categories.length || state.categories.includes(c.id);
      return `<button class="chip ${on ? 'on' : ''}" data-c="${c.id}" aria-pressed="${on}" style="--c:${c.color}"><span class="sw"></span>${c.short}</button>`;
    }).join('');
  }
  $('#categories').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    toggleCategory(b.dataset.c);
  });
  function toggleCategory(id, only = false) {
    let cur = state.categories.length ? [...state.categories] : CATS.map((c) => c.id);
    if (only) cur = cur.length === 1 && cur[0] === id ? CATS.map((c) => c.id) : [id];
    else cur = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    if (!cur.length) cur = CATS.map((c) => c.id);
    state.categories = cur.length === CATS.length ? [] : cur;
    refresh();
  }

  $('#preset').onchange = (e) => { state.preset = e.target.value; if (state.preset !== 'custom') applyPreset(state.preset); refresh(); };
  $('#start').onchange = (e) => { state.start = e.target.value; state.preset = 'custom'; refresh(); };
  $('#end').onchange = (e) => { state.end = e.target.value; state.preset = 'custom'; refresh(); };
  $('#granularity').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.granularity = b.dataset.v; refresh(); };
  $('#includeUnmetered').onchange = (e) => { state.includeUnmetered = e.target.checked; refresh(); };
  $('#reset').onclick = () => {
    Object.assign(state, { preset: 'thisMonth', granularity: 'day', categories: [], divisionIds: [], flowIds: [], mediaTypes: [], languages: [], botProducts: [], includeUnmetered: false });
    applyPreset('thisMonth'); refresh();
  };
  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.tab = b.dataset.t; state.sort = { key: 'tokens', dir: 'desc' };
    syncControls(); renderTable(); history.replaceState(null, '', `?${queryString(true)}`);
  };
  $('#refreshData').onclick = async () => {
    const btn = $('#refreshData');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      await refresh({ force: true });
      catalog = await api('/api/catalog');
      computeOptions(lastUsage?.filterOptions);
    } catch (e) { showError(e.message); } finally {
      btn.disabled = false; btn.textContent = 'Refresh';
    }
  };
  function renderAsOf(iso) {
    const el = $('#asOf');
    if (!iso) { el.textContent = ''; return; }
    const d = new Date(iso);
    el.textContent = `Data as of ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    el.title = d.toLocaleString();
  }

  function syncControls() {
    $('#preset').value = state.preset;
    $('#start').value = state.start; $('#end').value = state.end;
    $('#start').max = state.end; $('#end').min = state.start;
    document.querySelectorAll('#granularity button').forEach((b) => { b.classList.toggle('on', b.dataset.v === state.granularity); b.setAttribute('aria-checked', b.dataset.v === state.granularity); });
    document.querySelectorAll('#tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.t === state.tab); b.setAttribute('aria-selected', b.dataset.t === state.tab); });
    $('#includeUnmetered').checked = state.includeUnmetered;
    renderCategoryChips();
    MS_KEYS.forEach(updateMsButton);
    renderActiveFilters();
    $('#csv').href = `/api/usage.csv?${queryString(false)}`;
  }

  function renderActiveFilters() {
    const pills = [];
    for (const key of MS_KEYS) {
      for (const v of state[key]) {
        const label = (options[key] || []).find((o) => o.value === v)?.label || v;
        pills.push(`<span class="pill">${esc(label)}<button data-k="${key}" data-v="${esc(v)}" aria-label="Remove ${esc(label)}">×</button></span>`);
      }
    }
    $('#activeFilters').innerHTML = pills.join('');
  }
  $('#activeFilters').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state[b.dataset.k] = state[b.dataset.k].filter((x) => x !== b.dataset.v); refresh();
  };

  // ---------- KPIs ----------
  // Tokens are rounded up to whole tokens; say how much was used before that, when it differs.
  function renderKpis(s) {
    const total = s.totals.all.tokens || 0;
    const active = (id) => !state.categories.length || state.categories.includes(id);
    const share = CATS.map((c) => total ? `<span style="width:${(s.totals[c.id].tokens / total) * 100}%;background:${c.color}" title="${c.label}"></span>` : '').join('');
    const subs = {
      bot: (t) => `<span class="split"><span>Voice <b>${fmtTok(t.voiceTokens)}</b> · ${fmtBilledMin(t.voiceMinutesRounded)} billed min${t.callMinutes ? ` (${fmtMin(t.callMinutes)} of calls)` : ''}</span><span>Digital <b>${fmtTok(t.digitalTokens)}</b> · ${fmt(t.digitalTurns)} turns</span></span>`,
      va: (t) => `<span class="split"><span>Voice <b>${fmtTok(t.voiceTokens)}</b> · ${fmt(t.voiceBillableSessions)} sessions</span><span>Digital <b>${fmtTok(t.digitalTokens)}</b> · ${fmt(t.digitalBillableSessions)} sessions</span></span>`,
      ava: (t) => `<span class="split"><span>Voice <b>${fmtTok(t.voiceTokens)}</b> · ${fmt(t.voiceBillableSessions)} sessions</span><span>Digital <b>${fmtTok(t.digitalTokens)}</b> · ${fmt(t.digitalBillableSessions)} sessions</span></span>`,
    };
    $('#kpis').innerHTML = `
      <div class="kpi total"><div class="k-label">Estimated tokens, all types</div>
        <div class="k-value">${fmtTok(total)}</div><div class="k-sub">${state.start} to ${state.end}${s.totals.all.absorbedSessions ? ` · ${fmt(s.totals.all.absorbedSessions)} lower-tier sessions not billed` : ''}</div>
        <div class="share" aria-hidden="true">${share}</div></div>
      ${CATS.map((c) => {
        const t = s.totals[c.id];
        const pct = total ? (t.tokens / total) * 100 : 0;
        return `<button class="kpi ${active(c.id) ? '' : 'dim'}" data-c="${c.id}" title="Show only ${c.label}" style="--c:${c.color}">
          <div class="k-label"><span class="sw"></span>${c.label}</div>
          <div class="k-value">${fmtTok(t.tokens)}</div>
          <div class="k-sub">${subs[c.id](t)}${fmt(pct, 0)}% of total${t.absorbedSessions && c.id === 'va' ? ` · ${fmt(t.absorbedSessions)} escalated to AVA` : ''}</div></button>`;
      }).join('')}`;
  }
  $('#kpis').onclick = (e) => { const b = e.target.closest('button.kpi'); if (b) toggleCategory(b.dataset.c, true); };

  // ---------- chart ----------
  const tip = $('#tooltip');
  function bucketLabel(b, short) {
    if (state.granularity === 'month') return new Date(`${b}-01T00:00:00Z`).toLocaleDateString(undefined, { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' });
    const d = new Date(`${b}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return state.granularity === 'week' ? (short ? d : `Week of ${d}`) : d;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  // Grouped bars: each time bucket has one bar per type (Bot, Virtual Agent, AVA), so every type's
  // value is visible on its own. The vertical axis is linear, or a log scale (0, 1, 10, 100, ...)
  // when small and large values are far apart, so a 1-token bar still shows next to hundreds.
  const logTicks = (max) => {
    const out = [0];
    for (let p = 1; p <= max; p *= 10) out.push(p);
    // Few decades: add 2x and 5x gridlines so the axis is not bare.
    if (out.length <= 3) for (const p of out.slice(1)) for (const k of [2, 5]) if (p * k <= max) out.push(p * k);
    return out.sort((a, b) => a - b);
  };
  function chartScale(values) {
    const nz = values.filter((v) => v > 0);
    const peak = Math.max(0, ...nz);
    const spread = nz.length ? peak / Math.min(...nz) : 1;
    const log = state.scale === 'log' || (state.scale === 'auto' && spread >= 20);
    if (log) {
      const max = 10 ** Math.ceil(Math.log10(Math.max(peak, 1)) + 1e-9);
      const f = (v) => Math.log10(1 + Math.max(0, v)) / Math.log10(1 + max);
      return { log, max, f, ticks: logTicks(max) };
    }
    const whole = values.every((v) => Number.isInteger(Math.round(v * 1e9) / 1e9));
    const max = whole ? Math.max(4, Math.ceil(niceMax(peak) / 4) * 4) : niceMax(peak);
    return { log, max, f: (v) => v / max, ticks: [0, 0.25, 0.5, 0.75, 1].map((k) => k * max) };
  }
  function renderChart(series) {
    const el = $('#chart');
    const visible = CATS.filter((c) => !state.categories.length || state.categories.includes(c.id));
    $('#legend').innerHTML = visible.map((c) => `<span><i style="--c:${c.color}"></i>${c.label}</span>`).join('');
    document.querySelectorAll('#scale button').forEach((b) => { b.classList.toggle('on', b.dataset.v === state.scale); b.setAttribute('aria-checked', b.dataset.v === state.scale); });
    const W = Math.max(320, el.clientWidth || 800); const H = 300;
    const m = { t: 18, r: 8, b: 28, l: 52 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b;
    // A day whose usage was rounded into the bot's busier days (0 whole tokens, but tokens used)
    // still gets a faint bar at its used value, so no day with activity looks empty.
    const used = (s, c) => s[`${c.id}Used`] ?? s[c.id];
    const usedOnly = (s, c) => !(s[c.id] > 0) && used(s, c) > 0;
    const shown = (s, c) => (usedOnly(s, c) ? used(s, c) : s[c.id]);
    const totals = series.map((s) => visible.reduce((a, c) => a + shown(s, c), 0));
    const sc = chartScale(series.flatMap((s) => visible.map((c) => shown(s, c))));
    const n = series.length || 1;
    const step = iw / n;
    const groupW = Math.max(3 * visible.length, Math.min(30 * visible.length, step * 0.8));
    const gap = visible.length > 1 && groupW / visible.length > 8 ? 2 : 0;
    const bw = Math.max(1, (groupW - gap * (visible.length - 1)) / visible.length);
    const y = (v) => m.t + ih - sc.f(v) * ih;
    const labelEvery = Math.ceil(n / Math.max(1, Math.floor(iw / 64)));
    const showValues = bw >= 18; // value labels above bars when there is room
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
    svg += `<g class="grid">${sc.ticks.slice(1).map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>`;
    svg += `<g class="axis">${sc.ticks.map((t) => `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}</g>`;
    if (sc.log) svg += `<text class="axis-note" x="${m.l}" y="10">Log scale</text>`;
    svg += '<g class="cols">';
    series.forEach((s, i) => {
      const x0 = m.l + step * i + (step - groupW) / 2;
      let bars = '';
      visible.forEach((c, j) => {
        const v = shown(s, c);
        if (!(v > 0)) return;
        const faint = usedOnly(s, c);
        const x = x0 + j * (bw + gap);
        const h = Math.max(faint ? 4 : 2, y(0) - y(v)); // a non-zero value is always visible
        const yy = y(0) - h;
        const r = Math.min(3, bw / 2, h);
        bars += `<path class="bseg${faint ? ' used-only' : ''}" fill="${c.color}" stroke="${c.color}" d="M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + h} Z"/>`;
        const exact = fmtTok(v); // exact value when it fits above the bar, else 1.3K style
        if (showValues) bars += `<text class="val" x="${x + bw / 2}" y="${yy - 4}" text-anchor="middle">${exact.length * 6 <= bw + gap + 6 ? exact : compact(v)}</text>`;
      });
      svg += `<g class="col" data-i="${i}">${bars}<rect class="hit" x="${m.l + step * i}" y="${m.t}" width="${step}" height="${ih}"/></g>`;
    });
    svg += '</g>';
    svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    svg += `<g class="axis">${series.map((s, i) => (i % labelEvery === 0 ? `<text x="${m.l + step * i + step / 2}" y="${H - 8}" text-anchor="middle">${esc(bucketLabel(s.bucket, true))}</text>` : '')).join('')}</g>`;
    if (!totals.some((t) => t > 0)) svg += `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">No token-consuming activity for these filters</text>`;
    svg += '</svg>';
    el.innerHTML = svg;
    el.setAttribute('aria-label', `Bars of estimated tokens per ${state.granularity} for ${visible.map((c) => c.label).join(', ')}, ${state.start} to ${state.end}${sc.log ? ', log scale' : ''}. Peak ${fmtTok(Math.max(0, ...totals))} tokens in one ${state.granularity}.`);

    el.querySelectorAll('.col').forEach((g) => {
      g.addEventListener('mousemove', (e) => {
        const s = series[+g.dataset.i];
        const tot = visible.reduce((a, c) => a + s[c.id], 0);
        const usedNote = visible.some((c) => usedOnly(s, c))
          ? '<div class="t-note">Faint bar: tokens used this day that are billed in the whole-token total on a busier day.</div>' : '';
        tip.innerHTML = `<div class="t-head">${esc(bucketLabel(s.bucket))}</div>${visible.map((c) => `<div class="t-row"><span><i style="--c:${c.color}"></i>${c.short}</span><b>${fmtTok(s[c.id])}${usedOnly(s, c) ? ` <small>(${fmtTok(used(s, c))} used)</small>` : ''}</b></div>`).join('')}<div class="t-row t-total"><span>Total</span><b>${fmtTok(tot)}</b></div>${usedNote}`;
        tip.hidden = false;
        const tw = tip.offsetWidth; const th = tip.offsetHeight;
        let lx = e.clientX + 14; if (lx + tw > innerWidth - 8) lx = e.clientX - tw - 14;
        tip.style.left = `${Math.max(8, lx)}px`; tip.style.top = `${Math.min(innerHeight - th - 8, Math.max(8, e.clientY - th / 2))}px`;
        g.classList.add('hover');
      });
      g.addEventListener('mouseleave', () => { tip.hidden = true; g.classList.remove('hover'); });
    });
  }
  $('#scale').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.scale = b.dataset.v;
    history.replaceState(null, '', `?${queryString(true)}`);
    if (lastUsage) renderChart(lastUsage.summary.series);
  };
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => lastUsage && renderChart(lastUsage.summary.series), 120); });

  // ---------- table ----------
  // Columns shared by every breakdown tab: a Voice group and a Digital group, so each bot, Virtual
  // Agent and AVA shows how much of its usage and tokens came from calls and from digital channels.
  // Minutes and turns only apply to bots (Virtual Agents and AVAs bill per session), so they are
  // blank (–) on rows with no bot usage of that channel. A channel a row never used is blank too.
  const NUM_COLS = [
    { key: 'voiceSessions', label: 'Billed calls', num: true, group: 'voice', na: (r) => !r.channels?.includes('voice'), title: 'Calls billed at this row\'s tier. Calls that went on to a higher tier are under Escalated.' },
    { key: 'voiceMinutes', label: 'Bot min', num: true, group: 'voice', billedMin: true, na: (r) => !r.botVoice, title: 'Billed voice-bot minutes: each call rounded up to 15 s, plus a share of rounding the total up to a whole minute. Virtual Agents and AVAs bill per session, so minutes do not apply to them.' },
    { key: 'voiceTokens', label: 'Tokens', num: true, group: 'voice', tok: true, used: 'voiceUsedTokens', na: (r) => !r.channels?.includes('voice') },
    { key: 'digitalSessions', label: 'Billed sessions', num: true, group: 'digital', na: (r) => !r.channels?.includes('digital'), title: 'Chat, messaging, email and other digital sessions billed at this row\'s tier. Sessions that went on to a higher tier are under Escalated.' },
    { key: 'digitalTurns', label: 'Bot turns', num: true, group: 'digital', na: (r) => !r.botDigital, title: 'Billed prompt/response turns of digital bots (51 per token). Virtual Agents and AVAs bill per session, so turns do not apply to them.' },
    { key: 'digitalTokens', label: 'Tokens', num: true, group: 'digital', tok: true, used: 'digitalUsedTokens', na: (r) => !r.channels?.includes('digital') },
    { key: 'absorbedSessions', label: 'Escalated', num: true, title: 'Sessions not billed because the same conversation reached a higher tier' },
    { key: 'tokens', label: 'Total tokens', num: true, tok: true, used: 'usedTokens' },
  ];
  const GROUPS = { voice: 'Voice', digital: 'Digital' };
  // The token rule a row is billed by, as shown in "How tokens are calculated".
  const ruleText = (r) => {
    const t = cfg?.rates; if (!t || r.metered === false) return '';
    if (r.category === 'va') return `sessions ÷ ${t.virtualAgentSessionsPerToken}, rounded up`;
    if (r.category === 'ava') return `${t.avaTokensPerSession} per session, rounded up`;
    const parts = [];
    if (r.botVoice || r.channels?.includes('voice')) parts.push(`min ÷ ${t.voiceBotMinutesPerToken}`);
    if (r.botDigital || r.channels?.includes('digital')) parts.push(`turns ÷ ${t.digitalBotTurnsPerToken}`);
    return parts.length ? `${parts.join(' · ')}, rounded up` : '';
  };
  const channelText = (r) => (r.channels?.length === 2 ? 'voice + digital' : r.channels?.[0] || '');
  const TABLES = {
    byFlow: {
      cols: [
        { key: 'name', label: 'Bot / flow', render: (r) => `${esc(r.name)}<span class="sub">${esc([r.flowType, channelText(r), r.divisionName].filter(Boolean).join(' · '))}${r.avaNames?.length ? ` · AVA: ${esc(r.avaNames.join(', '))}` : ''}${r.metered ? '' : ' · not token-metered'}</span>` },
        { key: 'category', label: 'Type', render: (r) => `${catTag(r.category)}<span class="sub rule">${esc(ruleText(r))}</span>` },
        ...NUM_COLS,
      ],
      drill: (r) => { state.flowIds = [r.flowId]; },
    },
    byCategory: { cols: [{ key: 'category', label: 'Type', render: (r) => `${catTag(r.category)}<span class="sub rule">${esc(ruleText(r))}</span>` }, ...NUM_COLS], drill: (r) => { state.categories = [r.category]; } },
    byDivision: { cols: [{ key: 'name', label: 'Division' }, ...NUM_COLS], drill: (r) => { state.divisionIds = [r.key]; } },
    byLanguage: { cols: [{ key: 'name', label: 'Language' }, ...NUM_COLS], drill: (r) => { if (r.key !== '__none__') state.languages = [r.key]; } },
    byBotProduct: { cols: [{ key: 'name', label: 'Bot product' }, ...NUM_COLS], drill: (r) => { if (r.key !== '__none__') state.botProducts = [r.key]; } },
  };
  const catTag = (c) => `<span class="cat"><i style="--c:${CAT[c].color}"></i>${CAT[c].short}</span>`;

  function renderTable() {
    if (!TABLES[state.tab]) state.tab = 'byFlow'; // e.g. an old link to the removed Type × media tab
    const def = TABLES[state.tab];
    const rows = (lastUsage?.summary[state.tab] || []).slice();
    const { key, dir } = state.sort;
    rows.sort((a, b) => {
      const av = a[key]; const bv = b[key];
      const c = typeof av === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
      return dir === 'asc' ? c : -c;
    });
    const total = rows.reduce((s, r) => s + r.tokens, 0);
    const maxTok = Math.max(0, ...rows.map((r) => r.tokens));
    const sortAttr = (c) => (key === c.key ? `aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : '');
    const th = (c, extra = '') => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}${c.group && def.cols.find((x) => x.group === c.group) === c ? ' g-start' : ''}" ${c.title ? `title="${esc(c.title)}"` : ''} ${sortAttr(c)} ${extra}>${c.label}</th>`;
    const groupRow = def.cols.map((c, i) => {
      if (!c.group) return th(c, 'rowspan="2"');
      if (def.cols[i - 1]?.group === c.group) return '';
      return `<th colspan="${def.cols.filter((x) => x.group === c.group).length}" class="grp g-start">${GROUPS[c.group]}</th>`;
    }).join('');
    const head = `<thead><tr>${groupRow}<th rowspan="2">Share</th></tr><tr>${def.cols.filter((c) => c.group).map((c) => th(c)).join('')}</tr></thead>`;
    const agg = lastUsage?.summary.mode === 'aggregate';
    const numText = (c, v, r) => ((c.blankIfAggregate && (agg || r?.mode === 'aggregate')) || (r && c.na?.(r)) ? '–' : c.billedMin ? fmtBilledMin(v) : c.min ? fmtMin(v) : c.tok ? fmtTok(v) : fmt(v));
    const cell = (c, r) => (c.render ? c.render(r) : c.num ? numText(c, r[c.key], r) : esc(r[c.key]));
    const color = (r) => (r.category ? CAT[r.category].color : 'var(--accent)');
    const tdClass = (c) => `${c.num ? 'num' : ''}${c.group && def.cols.find((x) => x.group === c.group) === c ? ' g-start' : ''}`;
    // Token cells explain themselves: the rule result for the row's billed units, plus its share of
    // rounding its type's total up to a whole token (rule 6).
    const tokTitle = (c, r) => {
      if (!c.used || c.na?.(r) || r[c.used] === undefined) return '';
      const extra = r[c.key] - r[c.used];
      return Math.abs(extra) > 0.005 ? ` title="${fmt(r[c.used], 2)} by the token rules, ${fmt(r[c.key], 0)} after rounding up to whole tokens"` : '';
    };
    const body = rows.length ? rows.map((r, i) => `<tr class="click" data-i="${i}" tabindex="0">${def.cols.map((c) => `<td class="${tdClass(c)}"${tokTitle(c, r)}>${cell(c, r)}</td>`).join('')}
      <td><div class="bar" title="${fmt(total ? (r.tokens / total) * 100 : 0, 1)}%"><span style="width:${maxTok ? (r.tokens / maxTok) * 100 : 0}%;--c:${color(r)}"></span></div></td></tr>`).join('')
      : `<tr><td colspan="${def.cols.length + 1}" class="muted">No data for these filters.</td></tr>`;
    const sums = Object.fromEntries(def.cols.filter((c) => c.num).map((c) => [c.key, rows.reduce((s, r) => s + (r[c.key] || 0), 0)]));
    sums.tokens = total;
    sums.botVoice = rows.some((r) => r.botVoice); sums.botDigital = rows.some((r) => r.botDigital);
    sums.channels = [...new Set(rows.flatMap((r) => r.channels || []))];
    const totalRow = rows.length > 1 ? `<tr>${def.cols.map((c, i) => `<td class="${tdClass(c)}">${i === 0 ? 'Total' : c.num ? numText(c, sums[c.key], sums) : ''}</td>`).join('')}<td></td></tr>` : '';
    const foot = totalRow ? `<tfoot>${totalRow}</tfoot>` : '';
    const t = $('#table');
    t.innerHTML = head + `<tbody>${body}</tbody>` + foot;
    t.querySelectorAll('th[data-k]').forEach((th) => th.onclick = () => {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
      renderTable();
    });
    const drill = (tr) => { def.drill(rows[+tr.dataset.i]); if (state.tab !== 'byFlow') state.tab = 'byFlow'; refresh(); };
    t.querySelectorAll('tbody tr.click').forEach((tr) => {
      tr.onclick = () => drill(tr);
      tr.onkeydown = (e) => { if (e.key === 'Enter') drill(tr); };
    });
  }

  // ---------- billing ----------
  async function loadBilling() {
    const el = $('#billing');
    el.innerHTML = '<div class="muted small">Loading billing…</div>';
    try {
      const b = await api(`/api/billing?start=${state.start}&end=${state.end}`);
      const errs = (b.errors || []).map((e) => `<div class="notice">${esc(e)}</div>`).join('');
      if (!b.periods?.length) { el.innerHTML = errs || '<div class="notice">No billing periods overlap this date range.</div>'; return; }
      el.innerHTML = b.periods.map((p) => {
        const w = p.wallets?.[0];
        return `<div class="billing-grid" style="margin-bottom:12px">
          <div><div class="muted small" style="margin-bottom:6px">Contract ${esc(p.contractNumber || p.contractId)} · period ${esc(p.dateStart)} to ${esc(p.dateEnd)} · ${esc(p.status)}${b.mock ? ' · sample data' : ''}</div>
            <div class="table-wrap"><table><thead><tr><th>Product</th><th>Unit</th><th class="num">Quantity</th><th class="num">Tokens</th></tr></thead><tbody>
            ${p.tokenCharges.map((c) => `<tr><td>${esc(c.name)}${c.sku && c.sku !== 'SAMPLE' ? `<span class="sub">${esc(c.sku)}</span>` : ''}</td><td>${esc(c.unitOfMeasure || '')}</td><td class="num">${fmt(c.actualQuantity)}</td><td class="num">${fmtTok(c.tokens)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No token-converted charges in this period yet.</td></tr>'}
            </tbody><tfoot><tr><td>Total</td><td></td><td></td><td class="num">${fmtTok(p.totalTokens)}</td></tr></tfoot></table></div></div>
          ${w ? `<div class="wallet"><b>${esc(w.name || 'Token wallet')}</b><dl>
            <dt>Starting balance</dt><dd>${fmt(w.startingBalance)}</dd><dt>Added</dt><dd>${fmt(w.increase)}</dd>
            <dt>Consumed</dt><dd>${fmt(w.consumption)}</dd><dt>Ending balance</dt><dd><b>${fmt(w.endingBalance)}</b></dd>
            <dt>Overage</dt><dd>${fmt(w.overage)}${w.overageCharge ? ` (${fmt(w.overageCharge, 2)} ${esc(w.currency || '')})` : ''}</dd></dl></div>` : '<div class="wallet muted small">No token wallet on this contract period.</div>'}
        </div>`;
      }).join('') + errs + (b.internalOverview ? `<details><summary class="small">Raw subscription overview (internal API)</summary><pre>${esc(JSON.stringify(b.internalOverview, null, 2))}</pre></details>` : '');
    } catch (e) {
      el.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
    }
  }

  function renderMethod() {
    if (!cfg) return;
    const r = cfg.rates;
    const roundLevel = { type: 'Each type\'s total for the date range (Bots, Virtual Agents, AVAs)', product: 'Each product\'s total for the date range (voice bots, digital bots, Virtual Agents, AVAs)', total: 'The total for the date range', flow: 'Each bot or flow\'s total for the date range' }[r.tokenRounding];
    $('#method').innerHTML = `
      <p>Genesys Cloud does not publish an API that splits token usage by bot, so this page reads bot and flow usage per conversation from the analytics APIs and applies the rules below. Use the billing section above to compare with the official org total.</p>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>How it is identified</th><th>Rule</th></tr></thead><tbody>
        <tr><td>${catTag('bot')} voice</td><td>Architect voice bot flows without Virtual Agent or AVA</td><td>Each call billed in ${r.voiceBotIncrementSeconds} s increments, rounded up. All calls are totaled, rounded up to a whole minute, and divided by ${r.voiceBotMinutesPerToken}.</td></tr>
        <tr><td>${catTag('bot')} digital</td><td>Digital bot flows without Virtual Agent or AVA</td><td>Prompt/response turns ÷ ${r.digitalBotTurnsPerToken}</td></tr>
        <tr><td>${catTag('va')}</td><td>Bot flows with <code>virtualAgentEnabled</code></td><td>Sessions ÷ ${r.virtualAgentSessionsPerToken}, whatever their length (${fmt(1 / r.virtualAgentSessionsPerToken, 2)} per session)</td></tr>
        <tr><td>${catTag('ava')}</td><td>Any flow that contains an Agentic Virtual Agent block (Architect dependency tracking)</td><td>${r.avaTokensPerSession} tokens per session, whatever its length</td></tr>
      </tbody></table></div>
      <ul>
        <li><b>Highest tier only.</b> A call or digital conversation consumes tokens only for the highest level of AI it reached. A bot that escalates to a Virtual Agent costs one Virtual Agent session; bot to Virtual Agent to AVA costs one AVA session. The lower-tier sessions still appear in the tables under "Escalated" but bill nothing.</li>
        ${['aggregate', 'mixed'].includes(lastUsage?.summary.mode) ? '<li><b>Fallback in use for some data:</b> per-conversation data was not available, so the highest-tier rule could not be applied and voice rounding is estimated at half an increment per call.</li>' : ''}
        <li><b>Whole tokens.</b> ${roundLevel ? `${roundLevel} is rounded up to a whole token${r.tokenRounding === 'flow' ? ' (for example 543 Virtual Agent sessions ÷ 2 = 271.5, billed as 272), and the tiles add those up' : ''}. Each rounded-up total is handed to its rows (days, channels, languages) in proportion to usage with the largest remainder method, so every figure on the page is a whole number and they all add up to the tiles. Hover a token cell to see its value by the rules.` : 'Token rounding is turned off (TOKEN_ROUNDING=none), so tokens show with decimals.'}</li>
        <li><b>Rounding is in every figure.</b> Voice-bot time for the date range is rounded up to a whole minute once, and the extra seconds are shared across the voice bots in proportion to their billed time. Tiles, the chart, every breakdown row and drill-downs all use these shared-out values, so they always add up to the same total. A drill-down shows that bot's share of the bill rather than rounding it again on its own.</li>
        <li>Third-party bots reached through Bot Connector (for example Amazon Lex or Google Dialogflow) appear in analytics but are not charged Genesys bot tokens. Tick "Show non-metered bots" to list them.</li>
        <li>Days are bucketed in ${esc(cfg.timeZone)}. Rates come from server settings and can be changed in <code>.env</code>.</li>
      </ul>`;
  }

  // ---------- main ----------
  let seq = 0;
  async function refresh({ force = false } = {}) {
    if (!state.start || !state.end) applyPreset(state.preset === 'custom' ? 'thisMonth' : state.preset);
    if (state.start > state.end) [state.start, state.end] = [state.end, state.start];
    syncControls();
    history.replaceState(null, '', `?${queryString(true)}`);
    const my = ++seq;
    document.body.classList.add('loading');
    try {
      const u = await api(`/api/usage?${queryString(false)}${force ? '&refresh=1' : ''}`);
      if (my !== seq) return;
      lastUsage = u; showError(u.warning || ''); renderAsOf(u.dataFetchedAt || u.generatedAt);
      computeOptions(u.filterOptions);
      renderActiveFilters();
      renderKpis(u.summary); renderChart(u.summary.series); renderTable(); renderMethod();
    } catch (e) {
      if (my === seq) showError(e.message);
    } finally {
      if (my === seq) document.body.classList.remove('loading');
    }
    loadBilling();
  }

  async function init() {
    readUrl();
    if (state.preset !== 'custom' || !state.start) applyPreset(state.preset);
    buildMultiSelects();
    try {
      [cfg, catalog] = await Promise.all([api('/api/config'), api('/api/catalog')]);
      const mode = $('#mode');
      mode.textContent = cfg.mock ? 'Sample data' : `Live · ${cfg.region}`;
      mode.classList.toggle('mock', cfg.mock);
      $('#org').textContent = catalog.org?.name || '';
      if (cfg.version) {
        const v = $('#version');
        v.textContent = `v${cfg.version.version}`;
        v.title = [`Version ${cfg.version.full}`, cfg.version.buildDate && `built ${cfg.version.buildDate}`].filter(Boolean).join(', ');
      }
      renderMethod();
      computeOptions();
    } catch (e) { showError(`Could not connect to Genesys Cloud: ${e.message}`); }
    refresh();
  }
  init();
})();
