import dotenv from "dotenv"
import { loadConfig } from "./config.js"
import { createApp } from "./app.js"
import { createRedisClient } from "./redisClient.js"
import { createRateLimiter } from "./ratelimit/limiter.js"
import { POLICIES, compilePolicies } from "./ratelimit/policies.js"

dotenv.config({ path: "./.env" })
const config = loadConfig()
const { algorithm, failMode } = config.rateLimit

// With rate limiting off there's nothing to connect to.
const redis = algorithm === "off" ? null : createRedisClient(config.redis)
const limiter = createRateLimiter({ redis, algorithm })

const app = createApp({
  services: config.services,
  trustProxy: config.trustProxy,
  limiter,
  policies: compilePolicies(POLICIES),
  failMode,
})

app.listen(config.port, () => {
  console.log(`Gateway listening on port ${config.port}`)
  console.log(`Rate limiting: ${algorithm}${algorithm === "off" ? "" : ` (fails ${failMode})`}, trust proxy: ${config.trustProxy || "none"}`)
})
