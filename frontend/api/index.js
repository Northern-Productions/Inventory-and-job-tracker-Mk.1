function appendQuery(searchParams, key, value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      searchParams.append(key, String(entry));
    }
    return;
  }

  if (value !== undefined) {
    searchParams.append(key, String(value));
  }
}

function readRequestBody(body) {
  if (typeof body === 'string') {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  if (body === undefined || body === null) {
    return '';
  }

  return JSON.stringify(body);
}

function sendJson(res, status, payload) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(payload));
}

export default async function handler(req, res) {
  const upstreamBaseUrl = process.env.APPS_SCRIPT_URL?.trim();
  if (!upstreamBaseUrl) {
    sendJson(res, 500, {
      ok: false,
      error: 'APPS_SCRIPT_URL is not configured on the server.'
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, {
      ok: false,
      error: `Unsupported method: ${req.method}`
    });
    return;
  }

  const upstreamUrl = new URL(upstreamBaseUrl);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    appendQuery(upstreamUrl.searchParams, key, value);
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers:
        req.method === 'POST'
          ? {
              'Content-Type': req.headers['content-type'] || 'text/plain;charset=utf-8'
            }
          : undefined,
      body: req.method === 'POST' ? readRequestBody(req.body) : undefined
    });

    const responseText = await upstreamResponse.text();

    res.status(upstreamResponse.status);
    res.setHeader(
      'content-type',
      upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8'
    );
    res.send(responseText);
  } catch (_error) {
    sendJson(res, 502, {
      ok: false,
      error: 'The upstream Apps Script deployment could not be reached.'
    });
  }
}
