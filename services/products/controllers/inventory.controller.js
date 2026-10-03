import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { normalizeItems } from "../models/Inventory.model.js";
import {
  checkoutMode,
  commitReservation,
  releaseReservation,
  reserveStock,
  staleReservations,
} from "../utils/inventoryActions.js";

// These endpoints are for the orders service only; the gateway refuses
// /products/inventory/* from outside. The logic lives in
// utils/inventoryActions.js, shared with the background worker.

const requireReservationId = (body) => {
  if (!body?.reservationId) throw new ApiError(400, "reservationId is required");
  return String(body.reservationId);
};

// Take the stock for every item, or answer 409 (sold out) / 404 and take nothing.
const reserve = asyncHandler(async (req, res) => {
  const reservationId = requireReservationId(req.body);
  const items = normalizeItems(req.body.items);
  await reserveStock(reservationId, items);
  return res.status(200).json(new ApiResponse(200, "Stock reserved", { reservationId, mode: checkoutMode() }));
});

// The order exists: make the stock final. Normally the commit-stock job does
// this; the endpoint stays for manual use and tests.
const commit = asyncHandler(async (req, res) => {
  const reservationId = requireReservationId(req.body);
  const status = await commitReservation(reservationId);
  return res.status(200).json(new ApiResponse(200, "Commit handled", { reservationId, status }));
});

// No order will use the stock: give it back.
const release = asyncHandler(async (req, res) => {
  const reservationId = requireReservationId(req.body);
  const status = await releaseReservation(reservationId);
  return res.status(200).json(new ApiResponse(200, "Release handled", { reservationId, status }));
});

// Reservations still open after ?olderThanMs=, for the orders service's sweeper.
const stale = asyncHandler(async (req, res) => {
  const olderThanMs = Number(req.query.olderThanMs);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  if (!Number.isInteger(olderThanMs) || olderThanMs < 0)
    throw new ApiError(400, "olderThanMs must be a non-negative integer");
  const reservations = await staleReservations(olderThanMs, limit);
  return res.status(200).json(new ApiResponse(200, "Stale reservations", { reservations }));
});

export { reserve, commit, release, stale };
