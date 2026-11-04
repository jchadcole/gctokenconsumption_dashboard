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
  const fmtTok = (n) => fmt(n, Math.abs(n) < 100 ? 1 : 0);
  const compact = (n) => (Math.abs(n) >= 1000 ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmt(n, n < 10 && n % 1 ? 1 : 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  const today = () => iso(new Date());
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

  const state = {
    preset: 'thisMonth', start: '', end: '', granularity: 'day', categories: [],
    divisionIds: [], flowIds: [], mediaTypes: [], languages: [], botProducts: [], includeUnmetered: false,
    tab: 'byFlow', sort: { key: 'tokens', dir: 'desc' },
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
    for (const k of ['preset', 'start', 'end', 'granularity', 'tab']) if (p.get(k)) state[k] = p.get(k);
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
  $('#refreshCatalog').onclick = async () => {
    try { catalog = await api('/api/catalog?refresh=1'); computeOptions(lastUsage?.filterOptions); refresh(); } catch (e) { showError(e.message); }
  };

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
  function renderKpis(s) {
    const total = s.totals.all.tokens || 0;
    const active = (id) => !state.categories.length || state.categories.includes(id);
    const share = CATS.map((c) => total ? `<span style="width:${(s.totals[c.id].tokens / total) * 100}%;background:${c.color}" title="${c.label}"></span>` : '').join('');
    const subs = {
      bot: (t) => `${fmt(t.sessions)} sessions · ${fmt(t.minutes)} voice min`,
      va: (t) => `${fmt(t.sessions)} interactions`,
      ava: (t) => `${fmt(t.sessions)} interactions`,
    };
    $('#kpis').innerHTML = `
      <div class="kpi total"><div class="k-label">Estimated tokens, all types</div>
        <div class="k-value">${fmtTok(total)}</div><div class="k-sub">${state.start} to ${state.end}</div>
        <div class="share" aria-hidden="true">${share}</div></div>
      ${CATS.map((c) => {
        const t = s.totals[c.id];
        const pct = total ? (t.tokens / total) * 100 : 0;
        return `<button class="kpi ${active(c.id) ? '' : 'dim'}" data-c="${c.id}" title="Show only ${c.label}" style="--c:${c.color}">
          <div class="k-label"><span class="sw"></span>${c.label}</div>
          <div class="k-value">${fmtTok(t.tokens)}</div>
          <div class="k-sub">${fmt(pct, 0)}% of total · ${subs[c.id](t)}</div></button>`;
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
  function renderChart(series) {
    const el = $('#chart');
    const visible = CATS.filter((c) => !state.categories.length || state.categories.includes(c.id));
    $('#legend').innerHTML = visible.map((c) => `<span><i style="--c:${c.color}"></i>${c.label}</span>`).join('');
    const W = Math.max(320, el.clientWidth || 800); const H = 300;
    const m = { t: 12, r: 8, b: 28, l: 52 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b;
    const totals = series.map((s) => visible.reduce((a, c) => a + s[c.id], 0));
    const max = niceMax(Math.max(0, ...totals));
    const n = series.length || 1;
    const step = iw / n;
    const bw = Math.max(2, Math.min(48, step * 0.62));
    const y = (v) => m.t + ih - (v / max) * ih;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    const labelEvery = Math.ceil(n / Math.max(1, Math.floor(iw / 64)));
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
    svg += `<g class="grid">${ticks.slice(1).map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>`;
    svg += `<g class="axis">${ticks.map((t) => `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join('')}</g>`;
    svg += '<g class="cols">';
    series.forEach((s, i) => {
      const cx = m.l + step * i + step / 2; const x = cx - bw / 2;
      let acc = 0; let segs = '';
      const parts = visible.filter((c) => s[c.id] > 0);
      parts.forEach((c, j) => {
        const v = s[c.id]; const y0 = y(acc); const y1 = y(acc + v);
        const top = j === parts.length - 1;
        const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between stacked segments
        const r = top ? Math.min(4, bw / 2, h) : 0;
        const yy = y1;
        segs += top && r > 0
          ? `<path class="bseg" fill="${c.color}" d="M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + h} Z"/>`
          : `<rect class="bseg" fill="${c.color}" x="${x}" y="${yy}" width="${bw}" height="${h}"/>`;
        acc += v;
      });
      svg += `<g class="col" data-i="${i}">${segs}<rect class="hit" x="${m.l + step * i}" y="${m.t}" width="${step}" height="${ih}"/></g>`;
    });
    svg += '</g>';
    svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    svg += `<g class="axis">${series.map((s, i) => (i % labelEvery === 0 ? `<text x="${m.l + step * i + step / 2}" y="${H - 8}" text-anchor="middle">${esc(bucketLabel(s.bucket, true))}</text>` : '')).join('')}</g>`;
    if (!totals.some((t) => t > 0)) svg += `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">No token-consuming activity for these filters</text>`;
    svg += '</svg>';
    el.innerHTML = svg;
    el.setAttribute('aria-label', `Stacked bars of estimated tokens per ${state.granularity}, ${state.start} to ${state.end}. Peak ${fmtTok(Math.max(0, ...totals))} tokens.`);

    el.querySelectorAll('.col').forEach((g) => {
      g.addEventListener('mousemove', (e) => {
        const s = series[+g.dataset.i];
        const tot = visible.reduce((a, c) => a + s[c.id], 0);
        tip.innerHTML = `<div class="t-head">${esc(bucketLabel(s.bucket))}</div>${visible.slice().reverse().map((c) => `<div class="t-row"><span><i style="--c:${c.color}"></i>${c.short}</span><b>${fmtTok(s[c.id])}</b></div>`).join('')}<div class="t-row t-total"><span>Total</span><b>${fmtTok(tot)}</b></div>`;
        tip.hidden = false;
        const tw = tip.offsetWidth; const th = tip.offsetHeight;
        let lx = e.clientX + 14; if (lx + tw > innerWidth - 8) lx = e.clientX - tw - 14;
        tip.style.left = `${Math.max(8, lx)}px`; tip.style.top = `${Math.min(innerHeight - th - 8, Math.max(8, e.clientY - th / 2))}px`;
        g.classList.add('hover');
      });
      g.addEventListener('mouseleave', () => { tip.hidden = true; g.classList.remove('hover'); });
    });
  }
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => lastUsage && renderChart(lastUsage.summary.series), 120); });

  // ---------- table ----------
  const TABLES = {
    byFlow: {
      cols: [
        { key: 'name', label: 'Bot / flow', render: (r) => `${esc(r.name)}<span class="sub">${esc([r.flowType, r.divisionName].filter(Boolean).join(' · '))}${r.avaNames?.length ? ` · AVA: ${esc(r.avaNames.join(', '))}` : ''}${r.metered ? '' : ' · not token-metered'}</span>` },
        { key: 'category', label: 'Type', render: (r) => catTag(r.category) },
        { key: 'sessions', label: 'Sessions / interactions', num: true },
        { key: 'minutes', label: 'Voice minutes', num: true },
        { key: 'tokens', label: 'Est. tokens', num: true, tok: true },
      ],
      drill: (r) => { state.flowIds = [r.flowId]; },
    },
    byDivision: { cols: [{ key: 'name', label: 'Division' }, { key: 'sessions', label: 'Sessions / interactions', num: true }, { key: 'minutes', label: 'Voice minutes', num: true }, { key: 'tokens', label: 'Est. tokens', num: true, tok: true }], drill: (r) => { state.divisionIds = [r.key]; } },
    byCategoryMedia: { cols: [{ key: 'category', label: 'Type', render: (r) => catTag(r.category) }, { key: 'name', label: 'Media type' }, { key: 'sessions', label: 'Sessions / interactions', num: true }, { key: 'minutes', label: 'Voice minutes', num: true }, { key: 'tokens', label: 'Est. tokens', num: true, tok: true }], drill: (r) => { state.categories = [r.category]; state.mediaTypes = [r.name]; } },
    byLanguage: { cols: [{ key: 'name', label: 'Language' }, { key: 'sessions', label: 'Sessions / interactions', num: true }, { key: 'minutes', label: 'Voice minutes', num: true }, { key: 'tokens', label: 'Est. tokens', num: true, tok: true }], drill: (r) => { if (r.key !== '__none__') state.languages = [r.key]; } },
    byBotProduct: { cols: [{ key: 'name', label: 'Bot product' }, { key: 'sessions', label: 'Sessions / interactions', num: true }, { key: 'minutes', label: 'Voice minutes', num: true }, { key: 'tokens', label: 'Est. tokens', num: true, tok: true }], drill: (r) => { if (r.key !== '__none__') state.botProducts = [r.key]; } },
  };
  const catTag = (c) => `<span class="cat"><i style="--c:${CAT[c].color}"></i>${CAT[c].short}</span>`;

  function renderTable() {
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
    const head = `<thead><tr>${def.cols.map((c) => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}" ${key === c.key ? `aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}<th>Share</th></tr></thead>`;
    const cell = (c, r) => (c.render ? c.render(r) : c.num ? (c.tok ? fmtTok(r[c.key]) : fmt(r[c.key])) : esc(r[c.key]));
    const color = (r) => (r.category ? CAT[r.category].color : 'var(--accent)');
    const body = rows.length ? rows.map((r, i) => `<tr class="click" data-i="${i}" tabindex="0">${def.cols.map((c) => `<td class="${c.num ? 'num' : ''}">${cell(c, r)}</td>`).join('')}
      <td><div class="bar" title="${fmt(total ? (r.tokens / total) * 100 : 0, 1)}%"><span style="width:${maxTok ? (r.tokens / maxTok) * 100 : 0}%;--c:${color(r)}"></span></div></td></tr>`).join('')
      : `<tr><td colspan="${def.cols.length + 1}" class="muted">No data for these filters.</td></tr>`;
    const sums = { sessions: rows.reduce((s, r) => s + r.sessions, 0), minutes: rows.reduce((s, r) => s + r.minutes, 0), tokens: total };
    const foot = rows.length > 1 ? `<tfoot><tr>${def.cols.map((c, i) => `<td class="${c.num ? 'num' : ''}">${i === 0 ? 'Total' : c.num ? (c.tok ? fmtTok(sums[c.key]) : fmt(sums[c.key])) : ''}</td>`).join('')}<td></td></tr></tfoot>` : '';
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
    const r = cfg.rates;
    $('#method').innerHTML = `
      <p>Genesys Cloud does not publish an API that splits token usage by bot, so this page counts bot sessions and interactions from the analytics APIs and applies the published token rates. Use the billing section above for the official org total.</p>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>How it is identified</th><th>Rate applied</th></tr></thead><tbody>
        <tr><td>${catTag('bot')}</td><td>Architect bot and digital bot flows without Virtual Agent or AVA</td><td>Voice: ${r.voiceBotMinutesPerToken} minutes per token, each call rounded up to ${r.voiceBotRoundSeconds} s. Digital: ${r.digitalBotSessionsPerToken} sessions per token.</td></tr>
        <tr><td>${catTag('va')}</td><td>Bot flows with <code>virtualAgentEnabled</code></td><td>${r.virtualAgentTokensPerInteraction} tokens per interaction</td></tr>
        <tr><td>${catTag('ava')}</td><td>Any flow that contains an Agentic Virtual Agent block (Architect dependency tracking)</td><td>${r.avaTokensPerInteraction} tokens per interaction</td></tr>
      </tbody></table></div>
      <ul>
        <li>An interaction is billed once at the highest tier it touched (AVA, then Virtual Agent, then Bot). Analytics aggregates count each flow separately, so a single interaction that passes through two token-consuming flows is counted in both. Expect the estimate to run slightly above the invoice in that case.</li>
        <li>Voice rounding is estimated as half an increment per call, because analytics returns total duration rather than each call.</li>
        <li>Third-party bots reached through Bot Connector (for example Amazon Lex or Google Dialogflow) appear in analytics but are not charged Genesys bot tokens. Tick "Show non-metered bots" to list them.</li>
        <li>Days are bucketed in ${esc(cfg.timeZone)}. Rates come from server settings and can be changed in <code>.env</code> to match your contract.</li>
      </ul>`;
  }

  // ---------- main ----------
  let seq = 0;
  async function refresh() {
    if (!state.start || !state.end) applyPreset(state.preset === 'custom' ? 'thisMonth' : state.preset);
    if (state.start > state.end) [state.start, state.end] = [state.end, state.start];
    syncControls();
    history.replaceState(null, '', `?${queryString(true)}`);
    const my = ++seq;
    document.body.classList.add('loading');
    try {
      const u = await api(`/api/usage?${queryString(false)}`);
      if (my !== seq) return;
      lastUsage = u; showError('');
      computeOptions(u.filterOptions);
      renderActiveFilters();
      renderKpis(u.summary); renderChart(u.summary.series); renderTable();
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
