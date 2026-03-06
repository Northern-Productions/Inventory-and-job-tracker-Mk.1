// Paste into Apps Script file: http.gs

function successEnvelope_(data, warnings) {
  return {
    ok: true,
    data: data,
    warnings: warnings || []
  };
}

function errorEnvelope_(message, warnings) {
  return {
    ok: false,
    error: message,
    warnings: warnings || []
  };
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON
  );
}

var REQUEST_CONTEXT_ = null;

function getRequestContext_() {
  if (!REQUEST_CONTEXT_) {
    REQUEST_CONTEXT_ = {};
  }

  return REQUEST_CONTEXT_;
}

function clearRequestContext_() {
  REQUEST_CONTEXT_ = null;
}

function resolveRoute_(e) {
  var raw = '/';

  if (e && e.parameter && e.parameter.path) {
    raw = String(e.parameter.path);
  } else if (e && e.pathInfo) {
    raw = '/' + String(e.pathInfo).replace(/^\/+/, '');
  }

  if (raw.charAt(0) !== '/') {
    raw = '/' + raw;
  }

  return raw;
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (_error) {
    throw new Error('Invalid JSON request body.');
  }
}

function cloneObject_(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function getAuthenticatedAuditUser_(payload) {
  var authUser = payload && payload.authUser ? payload.authUser : null;
  if (!authUser) {
    throw new Error('Authenticated session is required.');
  }

  var email = requireString_(authUser.email, 'authUser.email');
  var name = requireString_(authUser.name, 'authUser.name');
  return name + ' <' + email + '>';
}
