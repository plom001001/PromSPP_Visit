
const ALLOWED_ORIGIN = 'https://plom001001.github.io';
const INTEGRATION_VERSION = '1';
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 110000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: origin === ALLOWED_ORIGIN ? 204 : 403,
        headers
      });
    }

    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse(
        { ok: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed' } },
        403,
        headers
      );
    }

    if (request.method === 'GET') {
      return jsonResponse(
        { ok: true, service: 'PromSPP API', status: 'ready' },
        200,
        headers
      );
    }

    if (request.method !== 'POST') {
      headers.set('Allow', 'GET, POST, OPTIONS');
      return jsonResponse(
        { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
        405,
        headers
      );
    }

    return handlePost(request, env, headers);
  }
};

async function handlePost(request, env, headers) {
  try {
    validateBindings(env);

    const contentType = request.headers.get('Content-Type') || '';
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
      return jsonResponse(
        { ok: false, error: { code: 'INVALID_REQUEST', message: 'รองรับเฉพาะ application/json' } },
        415,
        headers
      );
    }

    const declaredLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return requestTooLarge(headers);
    }

    let rawRequest;
    try {
      rawRequest = await readUtf8Body(request.body, MAX_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestTooLargeError) return requestTooLarge(headers);
      throw error;
    }

    let incoming;
    try {
      incoming = JSON.parse(rawRequest);
    } catch (ignored) {
      return invalidRequest('รูปแบบ JSON ไม่ถูกต้อง', headers);
    }

    if (!isPlainObject(incoming) || typeof incoming.action !== 'string' ||
        incoming.action.length === 0 || incoming.action.length > 120 ||
        (incoming.payload != null && !isPlainObject(incoming.payload))) {
      return invalidRequest('รูปแบบ action หรือ payload ไม่ถูกต้อง', headers);
    }

    const body = JSON.stringify({
      action: incoming.action,
      payload: incoming.payload || {}
    });
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return requestTooLarge(headers);
    }

    const timestamp = Date.now();
    const nonce = createNonce();
    const signedValue = [INTEGRATION_VERSION, String(timestamp), nonce, body].join('\n');
    const signature = await createSignature(signedValue, env.SPP_WORKER_SHARED_SECRET);
    const envelope = JSON.stringify({
      version: INTEGRATION_VERSION,
      timestamp,
      nonce,
      body,
      signature
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(env.GAS_WEB_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: envelope,
        redirect: 'follow',
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return jsonResponse(
          { ok: false, error: { code: 'UPSTREAM_TIMEOUT', message: 'Backend ใช้เวลาตอบกลับนานเกินกำหนด' } },
          504,
          headers
        );
      }
      return upstreamUnavailable(headers);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) return upstreamUnavailable(headers);

    let upstreamText;
    try {
      upstreamText = await readUtf8Body(upstream.body, MAX_REQUEST_BYTES);
    } catch (ignored) {
      return upstreamUnavailable(headers);
    }

    let result;
    try {
      result = JSON.parse(upstreamText);
    } catch (ignored) {
      return upstreamUnavailable(headers);
    }
    if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
      return upstreamUnavailable(headers);
    }

    return jsonResponse(result, 200, headers);
  } catch (ignored) {
    // Never log request bodies, passwords, session tokens, secrets, or upstream responses.
    return jsonResponse(
      { ok: false, error: { code: 'WORKER_ERROR', message: 'ระบบไม่สามารถดำเนินการได้' } },
      500,
      headers
    );
  }
}

function corsHeaders(origin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  return headers;
}

function jsonResponse(value, status, headers) {
  return new Response(JSON.stringify(value), { status, headers });
}

function invalidRequest(message, headers) {
  return jsonResponse(
    { ok: false, error: { code: 'INVALID_REQUEST', message } },
    400,
    headers
  );
}

function requestTooLarge(headers) {
  return jsonResponse(
    { ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'คำขอมีขนาดใหญ่เกินกำหนด' } },
    413,
    headers
  );
}

function upstreamUnavailable(headers) {
  return jsonResponse(
    { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'ไม่สามารถติดต่อ Backend ได้' } },
    502,
    headers
  );
}

function validateBindings(env) {
  const secret = env && env.SPP_WORKER_SHARED_SECRET;
  const gasUrl = env && env.GAS_WEB_APP_URL;
  if (typeof secret !== 'string' || secret.length < 32 || typeof gasUrl !== 'string') {
    throw new Error('Worker bindings are not configured');
  }
  const parsedUrl = new URL(gasUrl);
  if (parsedUrl.protocol !== 'https:') throw new Error('GAS_WEB_APP_URL must use HTTPS');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function createSignature(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readUtf8Body(stream, maxBytes) {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch (ignored) {}
    throw error;
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

class RequestTooLargeError extends Error {}
