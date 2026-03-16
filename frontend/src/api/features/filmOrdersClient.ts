// Purpose: Film order and catalog API surface.
import type {
  CreateFilmOrderPayload,
  FilmCatalogEntry,
  FilmCatalogResponse,
  FilmOrderEntry,
  FilmOrderListResponse
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

export async function getFilmOrders(): Promise<FilmOrderEntry[]> {
  assertFeatureAccess('film_orders', 'read');
  const data = await requestReadWithFallback<FilmOrderListResponse>('/film-orders/list', {}, {});
  return data.entries;
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
  payload: { jobNumber: string; reason?: string }
): Promise<{ result: { jobNumber: string }; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<{ jobNumber: string }>('POST', '/film-orders/cancel', {
    body: payload
  });
  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function deleteFilmOrder(
  payload: { filmOrderId: string; reason?: string }
): Promise<{ result: FilmOrderEntry; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<FilmOrderEntry>('POST', '/film-orders/delete', { body: payload });
  return {
    result: response.data,
    warnings: response.warnings
  };
}
