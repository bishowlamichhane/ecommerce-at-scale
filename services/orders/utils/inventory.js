import axios from "axios";
import ApiError from "./ApiError.js";

// Stock belongs to the products service; orders asks it to reserve, commit
// or release. These calls skip the circuit breaker on purpose: "sold out"
// (409) is a normal answer during a sale, and the shared breaker would count
// a burst of 409s as failures and open.

const call = (action, body) =>
  axios.post(`${process.env.PRODUCT_SERVICE_URL}/inventory/${action}`, body, { timeout: 5000 });

// items: [{ productId, quantity }]
export const reserveStock = (reservationId, items) => call("reserve", { reservationId, items });
export const commitStock = (reservationId) => call("commit", { reservationId });
export const releaseStock = (reservationId) => call("release", { reservationId });

// Keep the status and message of an error from another service (e.g. 409
// sold out, 404 no cart) instead of turning everything into a 500.
export const toApiError = (error, fallbackMessage) => {
  if (error instanceof ApiError) return error;
  if (error.response)
    return new ApiError(error.response.status, error.response.data?.message || fallbackMessage);
  return new ApiError(error.statusCode || 500, error.message || fallbackMessage);
};
