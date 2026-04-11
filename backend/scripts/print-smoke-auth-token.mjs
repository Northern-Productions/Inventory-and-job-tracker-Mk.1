import '../load-env.mjs';
import { resolveSmokeAuthToken } from './lib/smoke-auth.mjs';

const { token } = await resolveSmokeAuthToken({
  required: true,
  requiredFor: 'printing a smoke auth token'
});

process.stdout.write(token);
