import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  applyRedisCommit,
  commitDbReservation,
  normalizeItems,
  releaseDbReservation,
  reserveNaive,
  reservePostgres,
  reservePostgresLock,
} from "../models/Inventory.model.js";
import {
  forgetRedisReservation,
  getRedisReservation,
  releaseRedis,
  reserveRedis,
} from "../utils/inventoryRedis.js";

// How stock is taken at checkout. Restart the service to switch; the load
// test runs the same requests against each mode. See
// docs/projects/01-flash-sale.md for what each one does.
const MODES = ["naive", "postgres", "postgres-lock", "redis"];

export const checkoutMode = () => {
  const mode = process.env.CHECKOUT_MODE || "postgres";
  if (!MODES.includes(mode)) throw new Error(`CHECKOUT_MODE must be one of: ${MODES.join(", ")}`);
  return mode;
};

const requireReservationId = (body) => {
  if (!body?.reservationId) throw new ApiError(400, "reservationId is required");
  return String(body.reservationId);
};

// These endpoints are for the orders service only; the gateway refuses
// /products/inventory/* from outside.

// Take the stock for every item, or answer 409 (sold out) / 404 and take nothing.
const reserve = asyncHandler(async (req, res) => {
  const reservationId = requireReservationId(req.body);
  const items = normalizeItems(req.body.items);
  const mode = checkoutMode();

  if (mode === "naive") await reserveNaive(reservationId, items);
  else if (mode === "postgres") await reservePostgres(reservationId, items);
  else if (mode === "postgres-lock") await reservePostgresLock(reservationId, items);
  else await reserveRedis(reservationId, items);

  return res.status(200).json(new ApiResponse(200, "Stock reserved", { reservationId, mode }));
});

// The order now exists: make the reservation final. Safe to repeat.
const commit = asyncHandler(async (req, res) => {
  const reservationId = requireReservationId(req.body);

  let committed;
  if (checkoutMode() === "redis") {
    const items = await getRedisReservation(reservationId);
    committed = items ? await applyRedisCommit(reservationId, items) : false;
    if (items) await forgetRedisReservation(reservationId);
  } else {
    committed = await commitDbReservation(reservationId);
  }

  return res.status(200).json(new ApiResponse(200, "Commit handled", { reservationId, committed }));
});

// The order failed: put the stock back. Safe to repeat.
const release = asyncHandler(async (req, res) => {
  const reservationId = requireReservationId(req.body);

  const released = checkoutMode() === "redis"
    ? await releaseRedis(reservationId)
    : await releaseDbReservation(reservationId);

  return res.status(200).json(new ApiResponse(200, "Release handled", { reservationId, released }));
});

export { reserve, commit, release };
