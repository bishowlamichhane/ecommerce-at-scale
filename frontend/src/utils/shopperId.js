import axios from "axios";

// There's no login yet, so each browser gets a random shopper id. It's kept
// in localStorage and sent as X-User-Id with every request; the cart and
// orders services use it to keep shoppers apart.
const KEY = "shopper-id";

const newId = () => `shopper-${crypto.randomUUID()}`;

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
  axios.defaults.headers.common["X-User-Id"] = id;
}
