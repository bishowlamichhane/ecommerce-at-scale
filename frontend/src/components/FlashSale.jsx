import axios from "axios";
import { useEffect, useState } from "react";
import { currentShopperId, switchShopper } from "../utils/shopperId";
import { usePolling } from "../utils/usePolling";

// The flash sale page: one product, its live stock, and everything that
// happens after you press Buy (rate limits, background jobs, the
// confirmation email), visible as it happens.

const API = "http://localhost:5000";
const BULL_BOARD = "http://localhost:5003/admin/queues";
const ADDRESS = { billing_address: "Kathmandu, Dhapasi-7", shipping_address: "Kathmandu, Dhapasi-7" };

const STATUS = {
  Pending: { label: "Confirming…", className: "border-amber-300 text-amber-300" },
  Processing: { label: "Confirmed", className: "border-green-400 text-green-400" },
  Cancelled: { label: "Cancelled", className: "border-red-400 text-red-400" },
};

const TONE = {
  ok: "border-green-500 text-green-300",
  info: "border-sky-500 text-sky-300",
  limited: "border-amber-400 text-amber-300",
  soldout: "border-red-500 text-red-300",
  error: "border-red-500 text-red-300",
};

const OUTCOME = { 201: "bought", 409: "sold out", 429: "refused by the rate limiter" };

const retryAfterOf = (response) => Number(response?.headers?.["retry-after"]) || 1;

// What a failed purchase means, in a shopper's words.
function explain(error) {
  const response = error.response;
  if (!response) return { kind: "error", text: `Can't reach the store (${error.message}). Is everything running?` };
  if (response.status === 409) return { kind: "soldout", text: "Sold out: someone was faster this time." };
  if (response.status === 429) {
    const wait = retryAfterOf(response);
    return { kind: "limited", text: `Too many tries. The store lets you try again in ${wait} s.`, retryAfter: wait };
  }
  return { kind: "error", text: response.data?.message || error.message };
}

const count = (n) => (n === null || n === undefined ? "∞" : n);
const time = (iso) => new Date(iso).toLocaleTimeString();

const FlashSale = () => {
  const [sale, setSale] = useState(null);
  const [saleError, setSaleError] = useState("");
  const [orders, setOrders] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [shopper, setShopper] = useState(currentShopperId());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  usePolling(async () => {
    try {
      const { data } = await axios.get(`${API}/products/sale/current`);
      setSale(data.message);
      setSaleError("");
    } catch (error) {
      // 404 means no sale is running. Anything else is a blip: keep showing
      // the last numbers, with a warning.
      if (error.response?.status === 404) setSale(null);
      setSaleError(error.response?.data?.message || "Lost contact with the store. Is everything running? (npm run dev)");
    }
  }, 1000);

  usePolling(async () => {
    const [mine, mail] = await Promise.all([
      axios.get(`${API}/orders/my-orders`),
      axios.get(`${API}/orders/my-notifications`),
    ]);
    setOrders(mine.data.message);
    setInbox(mail.data.message);
  }, 2000);

  // Ticks the "try again in N s" countdown while the rate limiter says wait.
  useEffect(() => {
    if (blockedUntil <= Date.now()) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= blockedUntil) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [blockedUntil]);

  const waitLeft = Math.max(0, Math.ceil((blockedUntil - now) / 1000));

  const block = (seconds) => {
    setNow(Date.now());
    setBlockedUntil(Date.now() + seconds * 1000);
  };

  const purchase = () =>
    axios.post(`${API}/orders/buy-now`, { productId: sale.product.id, quantity: 1, ...ADDRESS });

  async function buy() {
    setBusy(true);
    try {
      const { data } = await purchase();
      setResult({ kind: "ok", text: `Order #${data.message.id} is placed. A background job is confirming it…` });
    } catch (error) {
      const outcome = explain(error);
      if (outcome.retryAfter) block(outcome.retryAfter);
      setResult(outcome);
    } finally {
      setBusy(false);
    }
  }

  // Ten purchases at once from this shopper, the way a bot would try.
  async function actLikeABot() {
    setBusy(true);
    const tries = await Promise.allSettled(Array.from({ length: 10 }, purchase));
    const counts = {};
    let wait = 0;
    for (const attempt of tries) {
      const response = attempt.status === "fulfilled" ? attempt.value : attempt.reason.response;
      const status = response?.status ?? "no answer";
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === 429) wait = Math.max(wait, retryAfterOf(response));
    }
    if (wait) block(wait);
    const summary = Object.entries(counts).map(([status, n]) => `${n} ${OUTCOME[status] ?? `HTTP ${status}`}`).join(", ");
    setResult({ kind: "info", text: `10 tries at once: ${summary}.` });
    setBusy(false);
  }

  function becomeNewShopper() {
    setShopper(switchShopper());
    setOrders([]);
    setInbox([]);
    setResult(null);
    setBlockedUntil(0);
  }

  if (!sale) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h1 className="text-3xl font-bold mb-4">⚡ Flash Sale</h1>
        <p className="text-gray-300">{saleError || "Loading the sale…"}</p>
      </main>
    );
  }

  const { product, stock, mode } = sale;
  const soldOut = stock.live === 0;

  return (
    <main className="max-w-6xl mx-auto w-full px-6 py-8 grid gap-6 lg:grid-cols-2">
      <section className="border border-gray-700 rounded-xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">⚡ Flash Sale</h1>
          <span className="text-xs border border-gray-600 rounded-full px-3 py-1 text-gray-300">checkout mode: {mode}</span>
        </div>
        {saleError && <p className="text-xs text-amber-300">{saleError}</p>}

        <div className="flex gap-6">
          <img src={product.image} alt={product.name} className="w-40 h-52 object-cover rounded-lg border border-gray-800" />
          <div className="flex flex-col gap-2">
            <p className="text-xl">{product.name}</p>
            <p className="text-gray-300">${Number(product.price).toFixed(2)}</p>
            <p className={`text-6xl font-bold ${soldOut ? "text-red-400" : ""}`}>{count(stock.live)}</p>
            <p className="text-gray-400 -mt-2">{soldOut ? "sold out" : "left"}</p>
            <p className="text-sm text-gray-400">
              In Postgres: {count(stock.committed)} · waiting for their commit job: {stock.pending}
            </p>
            <p className="text-xs text-gray-500">
              {mode === "redis"
                ? "Redis takes the stock the moment you buy; Postgres catches up as each commit-stock job runs."
                : "Postgres takes the stock the moment you buy; the commit-stock job then marks it final."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={buy}
            disabled={busy || soldOut || waitLeft > 0}
            className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-400 px-6 py-3 rounded-lg font-semibold cursor-pointer disabled:cursor-not-allowed"
          >
            {soldOut ? "Sold out" : waitLeft > 0 ? `Try again in ${waitLeft} s` : busy ? "Buying…" : "Buy now"}
          </button>
          <button
            onClick={actLikeABot}
            disabled={busy || waitLeft > 0}
            className="border border-amber-400 text-amber-300 hover:bg-amber-400/10 disabled:border-gray-700 disabled:text-gray-500 px-4 py-3 rounded-lg cursor-pointer disabled:cursor-not-allowed"
          >
            Act like a bot: 10 tries at once
          </button>
        </div>

        {result && <p className={`border rounded-lg px-4 py-3 ${TONE[result.kind]}`}>{result.text}</p>}

        <div className="text-xs text-gray-500 flex flex-wrap items-center gap-2">
          <span>You are {shopper}</span>
          <button onClick={becomeNewShopper} className="underline cursor-pointer hover:text-gray-300">
            become a new shopper
          </button>
        </div>
      </section>

      <section className="border border-gray-700 rounded-xl p-6 flex flex-col gap-3">
        <h2 className="text-xl font-semibold">My orders</h2>
        {orders.length === 0 && <p className="text-gray-500">No orders yet.</p>}
        <ul className="flex flex-col gap-2 max-h-72 overflow-y-auto">
          {orders.map((order) => {
            const status = STATUS[order.status] ?? { label: order.status, className: "border-gray-500 text-gray-300" };
            return (
              <li key={order.id} className="flex items-center justify-between gap-3 border border-gray-800 rounded-lg px-4 py-2">
                <span>
                  #{order.id} · {order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")} · $
                  {Number(order.totalPrice).toFixed(2)}
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{time(order.createdAt)}</span>
                  <span className={`text-xs border rounded-full px-3 py-1 ${status.className}`}>{status.label}</span>
                </span>
              </li>
            );
          })}
        </ul>

        <h2 className="text-xl font-semibold mt-4">Inbox</h2>
        {inbox.length === 0 && <p className="text-gray-500">The confirmation emails land here.</p>}
        <ul className="flex flex-col gap-2 max-h-72 overflow-y-auto">
          {inbox.map((mail) => (
            <li key={mail.id} className="border border-gray-800 rounded-lg px-4 py-2">
              <p className="flex justify-between gap-3">
                <span className="font-semibold">✉ {mail.subject}</span>
                <span className="text-xs text-gray-500">{time(mail.createdAt)}</span>
              </p>
              <p className="text-sm text-gray-400">{mail.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="lg:col-span-2 border border-gray-800 rounded-xl p-6 text-sm text-gray-400 flex flex-col gap-2">
        <h2 className="text-base font-semibold text-gray-200">Behind the scenes</h2>
        <p>
          Every purchase answers as soon as the order is saved (Confirming…). Two background jobs finish it:
          <code className="text-gray-200"> commit-stock</code> makes the stock final, then
          <code className="text-gray-200"> confirm-order</code> confirms the order and sends the email.
        </p>
        <p>
          Watch the jobs in Bull Board:{" "}
          <a href={BULL_BOARD} target="_blank" rel="noreferrer" className="underline text-sky-300">{BULL_BOARD}</a>
        </p>
        <p>
          Try it: stop the inventory worker and buy. Orders stay "Confirming…" and their jobs wait in Bull Board. Start the
          worker again and they all go through.
        </p>
      </section>
    </main>
  );
};

export default FlashSale;
