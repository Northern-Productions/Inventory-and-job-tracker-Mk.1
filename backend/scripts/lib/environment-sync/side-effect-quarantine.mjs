import { SIDE_EFFECT_POLICY_VERSION } from './constants.mjs';

const FORBIDDEN_NONPROD_SECRET_NAME = /(?:^|_)(?:APPS_SCRIPT|RESEND|SENDGRID|TWILIO|PROD|PRODUCTION|LIVE|STRIPE|WEBHOOK)(?:_|$)/i;

function asText(value) {
  return String(value ?? '').trim();
}

function verifySideEffectQuarantine({ inventory = {}, policy = {} } = {}) {
  const failures = [];
  const database = inventory.sideEffects?.database || {};
  const platform = inventory.platform || {};
  const secretNames = Array.isArray(platform.secrets?.names) ? platform.secrets.names : [];

  if (policy.version !== SIDE_EFFECT_POLICY_VERSION) failures.push('policy_version');
  if (!['dev', 'sandbox', 'local'].includes(asText(policy.target))) failures.push('target');
  if (!['disabled', 'sink'].includes(asText(policy.authEmailMode))) failures.push('auth_email');
  if (asText(policy.smsMode) !== 'disabled') failures.push('sms');
  if (policy.edgeSecretsTargetLocal !== true) failures.push('edge_secret_locality');
  if (policy.frontendProductionAliasAbsent !== true) failures.push('frontend_alias');
  if (policy.nonprodUrlsVerified !== true) failures.push('nonprod_urls');
  if (policy.storageBehaviorReviewed !== true) failures.push('storage_review');

  for (const [name, value] of [
    ['pg_cron', database.pgCronJobs],
    ['pg_net', database.pgNetEnabled === true && policy.databaseNetworkExtensionsDisabled !== true],
    ['database_webhooks', database.databaseWebhookCount],
    ['foreign_tables', database.foreignTableCount],
    ['external_function_references', database.externalFunctionReferenceCount]
  ]) {
    const safe = typeof value === 'boolean' ? value === false : Number(value || 0) === 0;
    if (!safe) failures.push(name);
  }

  const explicitlyAllowed = new Set(policy.allowedSecretNames || []);
  const forbiddenSecrets = secretNames.filter(
    (name) => FORBIDDEN_NONPROD_SECRET_NAME.test(name) && !explicitlyAllowed.has(name)
  );
  if (forbiddenSecrets.length > 0) failures.push('forbidden_secret_names');

  return {
    ok: failures.length === 0,
    classification: failures.length === 0 ? 'NONPROD_SIDE_EFFECTS_QUARANTINED' : 'NONPROD_SIDE_EFFECTS_UNSAFE',
    failures: Array.from(new Set(failures)).sort(),
    checks: {
      outboundAuth: ['disabled', 'sink'].includes(asText(policy.authEmailMode)),
      smsDisabled: asText(policy.smsMode) === 'disabled',
      databaseExternalEffectsAbsent:
        Number(database.pgCronJobs || 0) === 0 &&
        (database.pgNetEnabled !== true || policy.databaseNetworkExtensionsDisabled === true) &&
        Number(database.databaseWebhookCount || 0) === 0 &&
        Number(database.foreignTableCount || 0) === 0 &&
        Number(database.externalFunctionReferenceCount || 0) === 0,
      forbiddenSecretNameCount: forbiddenSecrets.length,
      urlsNonprod: policy.nonprodUrlsVerified === true,
      productionAliasAbsent: policy.frontendProductionAliasAbsent === true
    }
  };
}

export { FORBIDDEN_NONPROD_SECRET_NAME, verifySideEffectQuarantine };
