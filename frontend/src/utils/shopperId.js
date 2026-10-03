import axios from "axios";

// There's no login yet, so each browser gets a random shopper id. It's kept
// in localStorage and sent as X-User-Id with every request; the cart and
// orders services use it to keep shoppers apart, and the gateway rate limits
// by it.
const KEY = "shopper-id";

const newId = () => `shopper-${crypto.randomUUID()}`;

function applyShopperId(id) {
  axios.defaults.headers.common["X-User-Id"] = id;
  return id;
}

export function setupShopperId() {
  let id;
  try {
    id = localStorage.getItem(KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(KEY, id);
    }
  } catch {
    id = newId(); // storage blocked: the id lasts until the page reloads
  }
  return applyShopperId(id);
}

export const currentShopperId = () => axios.defaults.headers.common["X-User-Id"];

// Become a different shopper: new cart, new orders, fresh rate limits.
export function switchShopper() {
  const id = newId();
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage blocked: the new id lasts until the page reloads
  }
  return applyShopperId(id);
}
