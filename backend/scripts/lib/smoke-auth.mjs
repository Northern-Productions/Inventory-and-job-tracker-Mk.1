function asTrimmedString(value) {
  return String(value || '').trim();
}

function maskEmail(email) {
  const trimmed = asTrimmedString(email);
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 1) {
    return trimmed || '<unset>';
  }

  return `${trimmed.slice(0, 1)}***${trimmed.slice(atIndex)}`;
}

export function buildSmokeAuthSetupMessage(requiredFor = 'authenticated smoke checks') {
  return (
    `Set SMOKE_AUTH_TOKEN or configure SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD in backend/.env ` +
    `for ${requiredFor}.`
  );
}

export async function resolveSmokeAuthToken(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const required = options.required === true;
  const requiredFor = asTrimmedString(options.requiredFor) || 'authenticated smoke checks';

  const configuredToken = asTrimmedString(env.SMOKE_AUTH_TOKEN);
  if (configuredToken) {
    return {
      token: configuredToken,
      source: 'SMOKE_AUTH_TOKEN'
    };
  }

  const email = asTrimmedString(env.SMOKE_USER_EMAIL);
  const password = asTrimmedString(env.SMOKE_USER_PASSWORD);
  if (!email || !password) {
    if (required) {
      throw new Error(buildSmokeAuthSetupMessage(requiredFor));
    }

    return {
      token: '',
      source: 'missing'
    };
  }

  const supabaseUrl = asTrimmedString(env.SUPABASE_URL).replace(/\/+$/g, '');
  const supabaseAnonKey = asTrimmedString(env.SUPABASE_ANON_KEY);
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_ANON_KEY are required to mint a smoke auth token from SMOKE_USER_EMAIL.'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to mint a smoke auth token.');
  }

  const response = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    body: JSON.stringify({
      email,
      password
    })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      asTrimmedString(payload?.msg) ||
      asTrimmedString(payload?.error_description) ||
      asTrimmedString(payload?.error) ||
      asTrimmedString(payload?.message);
    throw new Error(
      `Unable to mint a smoke auth token for ${maskEmail(email)}.${detail ? ` ${detail}` : ''}`.trim()
    );
  }

  const token = asTrimmedString(payload?.access_token);
  if (!token) {
    throw new Error(`Supabase Auth returned no access_token for ${maskEmail(email)}.`);
  }

  env.SMOKE_AUTH_TOKEN = token;

  return {
    token,
    source: 'SMOKE_USER_EMAIL'
  };
}
