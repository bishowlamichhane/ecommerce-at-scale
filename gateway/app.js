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

  // Routes the services expose to each other, never to the internet:
  //   /products/inventory/*  reserve, commit and release stock (for the orders service)
  //   /orders/admin/*        Bull Board, which can retry and delete jobs
  // Express matches these case-insensitively, so /ORDERS/ADMIN is refused too.
  for (const internal of ["/products/inventory", "/orders/admin"]) {
    app.use(internal, (req, res) => {
      res.status(404).json({ message: "Not found", success: false })
    })
  }

  app.use("/products", createProxyMiddleware({ target: services.products, changeOrigin: true }))
  app.use("/cart", createProxyMiddleware({ target: services.cart, changeOrigin: true }))
  app.use("/orders", createProxyMiddleware({ target: services.orders, changeOrigin: true }))
  app.use("/search", createProxyMiddleware({ target: services.search, changeOrigin: true }))

  app.get("/", (req, res) => {
    res.send("Gateway is up and running ")
  })

  return app
}
