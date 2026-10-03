import express from "express"
import cors from "cors"
import { createProxyMiddleware } from "http-proxy-middleware"
import { identifyShopper } from "./ratelimit/identity.js"
import { rateLimit } from "./ratelimit/middleware.js"

// Builds the gateway. index.js starts it; the tests start it against a fake
// upstream.
export function createApp({ services, trustProxy, limiter, policies, failMode, logger = console }) {
  const app = express()

  // Lets req.ip come from X-Forwarded-For, but only when a trusted proxy sent it.
  app.set("trust proxy", trustProxy)

  // CORS goes first. It answers preflight (OPTIONS) requests itself, so those
  // are never rate limited, and it puts its headers on every response, 429s
  // included. Browsers only let the page read headers listed in
  // Access-Control-Expose-Headers.
  app.use(cors({ exposedHeaders: ["Retry-After", "RateLimit", "RateLimit-Policy"] }))

  app.use(identifyShopper)
  app.use(rateLimit({ limiter, policies, failMode, logger }))

  // /inventory/* on the products service is for the orders service only.
  // Without this, anyone could reserve or release stock through the gateway.
  app.use("/products/inventory", (req, res) => {
    res.status(404).json({ message: "Not found", success: false })
  })

  app.use("/products", createProxyMiddleware({ target: services.products, changeOrigin: true }))
  app.use("/cart", createProxyMiddleware({ target: services.cart, changeOrigin: true }))
  app.use("/orders", createProxyMiddleware({ target: services.orders, changeOrigin: true }))
  app.use("/search", createProxyMiddleware({ target: services.search, changeOrigin: true }))

  app.get("/", (req, res) => {
    res.send("Gateway is up and running ")
  })

  return app
}
