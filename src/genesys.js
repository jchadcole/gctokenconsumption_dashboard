'use strict';
// Minimal Genesys Cloud Platform API client: OAuth client credentials, retries on 429/5xx, pagination helpers.

class GenesysError extends Error {
  constructor(message, status, body, path) {
    super(message);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

async function netFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const host = new URL(url).host;
    throw new GenesysError(`Could not reach ${host} (${e.cause?.code || e.cause?.message || e.message}). Check GENESYS_REGION and network access.`, 503, null, new URL(url).pathname);
  }
}

class GenesysClient {
  constructor({ clientId, clientSecret, region }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.loginBase = `https://login.${region}`;
    this.apiBase = `https://api.${region}`;
    this.token = null;
    this.tokenExpires = 0;
    this.tokenPromise = null;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const res = await netFetch(`${this.loginBase}/oauth/token`, {
          method: 'POST',
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new GenesysError(`OAuth failed: ${body.error_description || body.error || res.status}`, res.status, body, '/oauth/token');
        this.token = body.access_token;
        this.tokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
        return this.token;
      })().finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  async request(method, path, { query, body } = {}, attempt = 0) {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
    const token = await this.getToken();
    const res = await netFetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      return this.request(method, path, { query, body }, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.request(method, path, { query, body }, attempt + 1);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new GenesysError(`${method} ${path} -> ${res.status}: ${json.message || text.slice(0, 200)}`, res.status, json, path);
    }
    return json;
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body, query) { return this.request('POST', path, { body, query }); }

  // Page-number pagination (most /api/v2 listings)
  async getAllPages(path, query = {}, { pageSize = 100, maxPages = 100 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.get(path, { ...query, pageSize, pageNumber: page });
      out.push(...(res.entities || []));
      const pageCount = res.pageCount || (res.nextUri ? page + 1 : page);
      if (page >= pageCount || !(res.entities || []).length) break;
    }
    return out;
  }

  // Cursor pagination (billing contracts)
  async getAllCursor(path, query = {}, { maxPages = 50 } = {}) {
    const out = [];
    let after;
    for (let i = 0; i < maxPages; i++) {
      const res = await this.get(path, { ...query, after });
      out.push(...(res.entities || []));
      if (!res.nextUri) break;
      after = new URL(res.nextUri, this.apiBase).searchParams.get('after');
      if (!after) break;
    }
    return out;
  }
}

module.exports = { GenesysClient, GenesysError };
