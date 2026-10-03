import {
  applyRedisCommit,
  commitDbReservation,
  openDbReservations,
  releaseDbReservation,
  reservationStatus,
  reserveNaive,
  reservePostgres,
  reservePostgresLock,
  staleDbReservations,
} from "../models/Inventory.model.js";
import {
  claimRedisReservation,
  forgetRedisReservation,
  openRedisReservations,
  redisStock,
  releaseRedis,
  reserveRedis,
  staleRedisReservations,
} from "./inventoryRedis.js";

// What the inventory can do, whichever checkout mode is on. Used by the HTTP
// endpoints (controllers/inventory.controller.js) and by the worker that
// commits reservations in the background (worker.js).

// How stock is taken at checkout. Restart the service (and its worker) to
// switch; the load tests run the same requests against each mode. See
// docs/projects/01-flash-sale.md for what each one does.
const MODES = ["naive", "postgres", "postgres-lock", "redis"];

export const checkoutMode = () => {
  const mode = process.env.CHECKOUT_MODE || "postgres";
  if (!MODES.includes(mode)) throw new Error(`CHECKOUT_MODE must be one of: ${MODES.join(", ")}`);
  return mode;
};

// Take the stock for every item, or throw 409 (sold out) / 404 and take nothing.
export async function reserveStock(reservationId, items) {
  const mode = checkoutMode();
  if (mode === "naive") return reserveNaive(reservationId, items);
  if (mode === "postgres") return reservePostgres(reservationId, items);
  if (mode === "postgres-lock") return reservePostgresLock(reservationId, items);
  return reserveRedis(reservationId, items);
}

// The order exists: make its stock final. Safe to repeat, and safe to race
// with a release (only one of them can win). Returns:
//   'committed'  the stock is final (now, or by an earlier attempt)
//   'released'   too late: the stock went back, so the order must be cancelled
//   'unknown'    no such reservation (in redis mode, also: released)
export async function commitReservation(reservationId) {
  if (checkoutMode() !== "redis") return commitDbReservation(reservationId);

  // Claim first: from here on, release.lua refuses this reservation.
  const items = await claimRedisReservation(reservationId);
  if (!items) return (await reservationStatus(reservationId)) === "committed" ? "committed" : "unknown";

  // If the process dies between these two lines, the reservation stays
  // 'committing' and the retried job claims it again. The Postgres write is
  // idempotent by reservation id, so it applies once.
  await applyRedisCommit(reservationId, items);
  await forgetRedisReservation(reservationId);
  return "committed";
}

// No order will use this stock: give it back. Safe to repeat. Returns:
//   'released'    the stock is back (now, or by an earlier attempt)
//   'committed'   an order owns the stock: nothing released
//   'committing'  (redis mode) an order is claiming it right now: nothing released
//   'unknown'     no such reservation
export async function releaseReservation(reservationId) {
  if (checkoutMode() !== "redis") return releaseDbReservation(reservationId);

  const result = await releaseRedis(reservationId);
  if (result !== "gone") return result;
  return (await reservationStatus(reservationId)) === "committed" ? "committed" : "unknown";
}

// Reservations still open after `olderThanMs`, for the sweeper.
export function staleReservations(olderThanMs, limit = 100) {
  return checkoutMode() === "redis"
    ? staleRedisReservations(olderThanMs, limit)
    : staleDbReservations(olderThanMs, limit);
}

// A product's stock as each part of the system sees it:
//   live       what the next buyer is checked against
//   committed  what Postgres holds; in redis mode it catches up as commits run
//   pending    reservations waiting for their commit
export async function stockView(product) {
  const committed = product.stock ?? null;
  if (checkoutMode() !== "redis") {
    return { live: committed, committed, pending: await openDbReservations(product.id) };
  }
  const live = await redisStock(product.id);
  return {
    live: live === undefined ? committed : live,
    committed,
    // Redis keeps one list of open reservations for every product; a sale
    // has one product, so for the sale page that's the same number.
    pending: await openRedisReservations(),
  };
}
