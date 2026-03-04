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

async function readRequestBody(req) {
  if (typeof req.body === 'string') {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }

  if (req.body !== undefined && req.body !== null) {
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return '';
  }

  return Buffer.concat(chunks).toString('utf8');
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
    const requestBody = req.method === 'POST' ? await readRequestBody(req) : undefined;
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers:
        req.method === 'POST'
          ? {
              'Content-Type': req.headers['content-type'] || 'text/plain;charset=utf-8'
            }
          : undefined,
      body: requestBody
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
