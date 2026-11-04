// One HTTP client for every adapter: polite User-Agent (project name, no email), timeouts,
// gzip, and conditional requests (ETag / Last-Modified) remembered per URL.
import { config } from './config.js';

const validators = new Map(); // url → { etag, lastModified, body }

export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * GET a URL. With { conditional: true } it sends If-None-Match / If-Modified-Since and reports
 * `notModified` when the server answers 304 (the previous body is returned too).
 * @returns {Promise<{ status:number, notModified:boolean, text:string, headers:Headers }>}
 */
export async function get(url, { conditional = false, timeoutMs = 20000, accept = '*/*' } = {}) {
  const headers = { 'User-Agent': config.userAgent, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br' };
  const prev = conditional ? validators.get(url) : null;
  if (prev?.etag) headers['If-None-Match'] = prev.etag;
  if (prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (res.status === 304 && prev) return { status: 304, notModified: true, text: prev.body, headers: res.headers };
  if (!res.ok) throw new HttpError(url, res.status);
  const text = await res.text();
  if (conditional) {
    validators.set(url, { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), body: text });
  }
  return { status: res.status, notModified: false, text, headers: res.headers };
}

/** HEAD a URL (change detection without downloading the body). Same UA / timeout as get(). */
export async function head(url, { timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': config.userAgent, Accept: '*/*' },
  });
  if (!res.ok) throw new HttpError(url, res.status);
  return { status: res.status, headers: res.headers };
}

export async function getJson(url, opts) {
  const r = await get(url, { ...opts, accept: 'application/json' });
  return { ...r, json: JSON.parse(r.text) };
}

/** GET binary (zip, etc.). Same UA / timeout / conditional behaviour as get(); body is a Uint8Array. */
export async function getBuffer(url, { conditional = false, timeoutMs = 60000, accept = '*/*' } = {}) {
  const headers = { 'User-Agent': config.userAgent, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br' };
  const prev = conditional ? validators.get(url) : null;
  if (prev?.etag) headers['If-None-Match'] = prev.etag;
  if (prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (res.status === 304 && prev) return { status: 304, notModified: true, body: prev.body, headers: res.headers };
  if (!res.ok) throw new HttpError(url, res.status);
  const body = new Uint8Array(await res.arrayBuffer());
  if (conditional) validators.set(url, { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), body });
  return { status: res.status, notModified: false, body, headers: res.headers };
}

/** POST (for sources whose read API is a POST, e.g. ASP.NET services). Body is sent as given. */
export async function post(url, body, { timeoutMs = 20000, contentType = 'application/json', accept = 'application/json' } = {}) {
  const res = await fetch(url, {
    method: 'POST', body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': config.userAgent, Accept: accept, 'Content-Type': contentType, 'Accept-Encoding': 'gzip, deflate, br' },
  });
  if (!res.ok) throw new HttpError(url, res.status);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}
