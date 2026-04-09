import { API_BUILD_SHA, API_BUILT_AT } from '../config/runtime.mjs';
import { ensureConfigured } from '../db/client.mjs';
import { HttpError, ok } from '../lib/http.mjs';
import { routeParams } from '../routes/params.mjs';
import { integerOrZero } from './core/helpers.mjs';
import { dispatchMutationWithHandlers } from './handlers/mutationHandlers.mjs';
import { dispatchReadWithHandlers } from './handlers/readHandlers.mjs';
import { runAutomaticAllocationReconciliationForRead } from './handlers/reconciliation.mjs';
import {
  createDeniedFeaturePermissions,
  ensureEffectiveRouteAccess,
  mapDatabaseBootstrapError,
  resolveAuthContext,
} from './services/access.mjs';

export async function handleSupabaseRequest({ method, logicalPath, requestUrl, bodyJson, headers }) {
  try {
    ensureConfigured();

    if (logicalPath === '/health') {
      return {
        statusCode: 200,
        payload: ok({
          status: 'ok',
          timestamp: new Date().toISOString(),
          sheets: [],
          mode: 'supabase',
          apiBuildSha: API_BUILD_SHA,
          apiBuiltAt: API_BUILT_AT,
        }),
      };
    }

    const params = routeParams(method, requestUrl, bodyJson);
    const authContext = await resolveAuthContext(headers, bodyJson);

    if (logicalPath === '/auth/context') {
      return {
        statusCode: 200,
        payload: ok({
          orgId: authContext.orgId,
          accessStatus: authContext.accessStatus,
          role: authContext.role || '',
          permissions: authContext.permissions || createDeniedFeaturePermissions(),
          isAdminConsoleAllowed: Boolean(authContext.isAdminConsoleAllowed),
          pendingCount: integerOrZero(authContext.pendingCount),
          receivesInAppNotifications: Boolean(authContext.receivesInAppNotifications),
        }),
      };
    }

    ensureEffectiveRouteAccess(authContext, method, logicalPath);

    if (method === 'GET') {
      await runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext);
      return {
        statusCode: 200,
        payload: await dispatchReadWithHandlers(logicalPath, params, authContext),
      };
    }

    return {
      statusCode: 200,
      payload: await dispatchMutationWithHandlers(logicalPath, params, authContext),
    };
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        statusCode: error.statusCode,
        payload: {
          ok: false,
          error: error.message,
          warnings: error.warnings || [],
        },
      };
    }

    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: mapDatabaseBootstrapError(error instanceof Error ? error.message : ''),
        warnings: [],
      },
    };
  }
}
