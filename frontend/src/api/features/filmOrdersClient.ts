// Purpose: Film order and catalog API surface.
import type {
  CancelJobPayload,
  CancelJobResult,
  CreateFilmOrderPayload,
  DeleteFilmOrderPayload,
  FilmCatalogEntry,
  FilmCatalogResponse,
  FilmOrderDetail,
  FilmOrderEntry,
  FilmOrderListResponse
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

export async function getFilmOrders(options: { warehouse?: string } = {}): Promise<FilmOrderEntry[]> {
  assertFeatureAccess('film_orders', 'read');
  const normalizedWarehouse = String(options.warehouse || '').trim().toUpperCase();
  const params = normalizedWarehouse ? { warehouse: normalizedWarehouse } : {};
  const data = await requestReadWithFallback<FilmOrderListResponse>('/film-orders/list', params, params);
  return data.entries;
}

export async function getFilmOrderDetail(filmOrderId: string): Promise<FilmOrderDetail> {
  assertFeatureAccess('film_orders', 'read');
  return requestReadWithFallback<FilmOrderDetail>('/film-orders/get', { filmOrderId }, { filmOrderId });
}

export async function getFilmCatalog(): Promise<FilmCatalogEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<FilmCatalogResponse>('/film-data/catalog', {}, {});
  return data.entries;
}

export async function createFilmOrder(
  payload: CreateFilmOrderPayload
): Promise<{ result: FilmOrderEntry; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<FilmOrderEntry>('POST', '/film-orders/create', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function cancelJob(
  payload: CancelJobPayload
): Promise<{ result: CancelJobResult; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<CancelJobResult>('POST', '/film-orders/cancel', {
    body: payload
  });
  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function deleteFilmOrder(
  payload: DeleteFilmOrderPayload
): Promise<{ result: FilmOrderEntry; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<FilmOrderEntry>('POST', '/film-orders/delete', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}
