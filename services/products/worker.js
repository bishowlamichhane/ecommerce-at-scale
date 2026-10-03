import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import { UnrecoverableError, Worker } from "bullmq"
import connectDB, { closeDB } from "./db/db.js"
import redis, { cacheRedis } from "./utils/redisClient.js"
import { INVENTORY_QUEUE, redisConnection } from "./utils/queue.js"
import { checkoutMode, commitReservation } from "./utils/inventoryActions.js"

// Processes the inventory queue: once an order exists, make its reserved
// stock final. It runs as its own process (npm run worker), so it can be
// stopped, restarted or scaled without touching the API. While it's down,
// jobs simply wait in Redis.

const handlers = {
    // Returns what the parent job (confirm-order, in the orders service)
    // needs to decide between confirming and cancelling the order.
    "commit-stock": async (job) => ({
        reservationId: job.data.reservationId,
        status: await commitReservation(job.data.reservationId),
    }),
}

await connectDB({ handleSignals: false })

const worker = new Worker(
    INVENTORY_QUEUE,
    async (job) => {
        const handler = handlers[job.name]
        // Retrying can't fix a job nobody knows how to run.
        if (!handler) throw new UnrecoverableError(`No handler for job "${job.name}"`)
        return handler(job)
    },
    {
        // Workers wait on Redis with blocking commands, which is why BullMQ
        // requires maxRetriesPerRequest: null on their connection.
        connection: { ...redisConnection(), maxRetriesPerRequest: null },
        concurrency: 10,
    }
)

worker.on("failed", (job, error) =>
    console.error(`❌ ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}): ${error.message}`))
worker.on("error", (error) => console.error("Inventory worker error:", error.message))
console.log(`👷 Inventory worker ready (checkout mode: ${checkoutMode()})`)

// On Ctrl+C, finish the jobs in hand, then exit. A job cut off midway would
// be retried anyway once its lock expires, but there's no need to make it.
let stopping = false
const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log("Stopping inventory worker: finishing jobs in progress...")
    await worker.close()
    await closeDB()
    redis.disconnect()
    cacheRedis.disconnect()
    process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
