import { API_BUILD_SHA, API_BUILT_AT } from '../config/runtime.mjs';
import { ensureConfigured } from '../db/client.mjs';
import { HttpError, ok } from '../lib/http.mjs';
import { routeParams } from '../routes/params.mjs';
import { integerOrZero } from './core/helpers.mjs';
import { dispatchMutationWithHandlers } from './handlers/mutationHandlers.mjs';
import { dispatchReadWithHandlers } from './handlers/readHandlers.mjs';
import { runAutomaticAllocationReconciliationForRead } from './handlers/reconciliation.mjs';
import {
  getRouteTimingErrorCategory,
  maybeLogRouteTiming,
  resolveRouteTimingRequestId,
} from './routeTiming.mjs';
import {
  createDeniedFeaturePermissions,
  ensureEffectiveRouteAccess,
  mapDatabaseBootstrapError,
  resolveAuthContext,
} from './services/access.mjs';

export async function handleSupabaseRequest({ method, logicalPath, requestUrl, bodyJson, headers }) {
  const startedAt = Date.now();
  const requestId = resolveRouteTimingRequestId(headers);
  let response;
  let errorCategory = '';

  try {
    ensureConfigured();

    if (logicalPath === '/health') {
      response = {
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
      return response;
    }

    const params = routeParams(method, requestUrl, bodyJson);
    const authContext = await resolveAuthContext(headers, bodyJson);

    if (logicalPath === '/auth/context') {
      response = {
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
      return response;
    }

    ensureEffectiveRouteAccess(authContext, method, logicalPath);

    if (method === 'GET') {
      await runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext);
      response = {
        statusCode: 200,
        payload: await dispatchReadWithHandlers(logicalPath, params, authContext),
      };
      return response;
    }

    response = {
      statusCode: 200,
      payload: await dispatchMutationWithHandlers(logicalPath, params, authContext),
    };
    return response;
  } catch (error) {
    errorCategory = getRouteTimingErrorCategory(error);
    if (error instanceof HttpError) {
      response = {
        statusCode: error.statusCode,
        payload: {
          ok: false,
          error: error.message,
          warnings: error.warnings || [],
          ...(error.details || {}),
        },
      };
      return response;
    }

    response = {
      statusCode: 500,
      payload: {
        ok: false,
        error: mapDatabaseBootstrapError(error instanceof Error ? error.message : ''),
        warnings: [],
      },
    };
    return response;
  } finally {
    maybeLogRouteTiming({
      runtime: 'node-local',
      method,
      route: logicalPath,
      statusCode: response?.statusCode || 500,
      ok: Boolean(response?.payload?.ok),
      durationMs: Date.now() - startedAt,
      cache: 'none',
      requestId,
      errorCategory,
    });
  }
}
