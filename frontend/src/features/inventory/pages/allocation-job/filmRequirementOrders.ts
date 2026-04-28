import type { FilmOrderEntry, JobRequirementLine } from '../../../../domain';

/**
 * PURPOSE:
 * Matches job film requirements to unresolved manual film orders so the job
 * detail page can expose explicit Order/Cancel actions without duplicates.
 *
 * AFFECTS:
 * FilmRequirementsSection row actions, Order All behavior, manual film-order
 * cache updates, and server duplicate-prevention expectations.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeJobsMutations.mjs duplicate checks, api_film_orders_create
 * migration logic, FilmOrdersPage creation, and allocation-job tests.
 *
 * COMMON FAILURE MODES:
 * Duplicate unresolved orders, wrong requirement IDs, stale buttons after
 * cancel, or using allocated box width instead of requirement width.
 */
export function normalizeFilmRequirementOrderKey(
  entry: Pick<JobRequirementLine | FilmOrderEntry, 'manufacturer' | 'filmName' | 'widthIn'>
) {
  const manufacturer = String(entry.manufacturer || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const filmName = String(entry.filmName || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const widthIn = Number(entry.widthIn) || 0;
  return `${manufacturer}|${filmName}|${widthIn}`;
}

export function isUnresolvedRequirementFilmOrder(order: FilmOrderEntry) {
  return order.status === 'FILM_ORDER' || order.status === 'FILM_ON_THE_WAY';
}

export function findUnresolvedOrderForRequirement(
  requirement: JobRequirementLine,
  filmOrders: FilmOrderEntry[]
) {
  const requirementId = String(requirement.requirementId || '').trim();
  const requirementKey = normalizeFilmRequirementOrderKey(requirement);
  return filmOrders.find((order) => {
    if (!isUnresolvedRequirementFilmOrder(order)) {
      return false;
    }

    const orderRequirementId = String(order.requirementId || '').trim();
    if (requirementId && orderRequirementId) {
      return orderRequirementId === requirementId &&
        normalizeFilmRequirementOrderKey(order) === requirementKey;
    }

    return normalizeFilmRequirementOrderKey(order) === requirementKey;
  });
}

export function getOrderableFilmRequirements(
  requirements: JobRequirementLine[],
  filmOrders: FilmOrderEntry[]
) {
  return requirements.filter(
    (requirement) =>
      Math.max(0, Number(requirement.remainingFeet || 0)) > 0 &&
      !findUnresolvedOrderForRequirement(requirement, filmOrders)
  );
}
