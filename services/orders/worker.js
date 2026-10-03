import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import { UnrecoverableError, Worker } from "bullmq"
import connectDB, { closeDB } from "./db/db.js"
import { closeQueues, getOrdersQueue, ORDERS_QUEUE, redisConnection } from "./utils/queues.js"
import { processConfirmOrder } from "./jobs/confirmOrder.js"
import { reconcile, settingsFromEnv } from "./jobs/reconcile.js"

// Processes the orders queue:
//   confirm-order  after its commit-stock child: confirm or cancel the order
//   reconcile      the safety net, added every RECONCILE_EVERY_MS by a job scheduler
// It runs as its own process (npm run worker); while it's down, jobs wait in Redis.

const settings = settingsFromEnv()
const reconcileEveryMs = Number(process.env.RECONCILE_EVERY_MS || 30_000)

const handlers = {
    "confirm-order": processConfirmOrder,
    reconcile: async () => {
        const summary = await reconcile(settings)
        const acted = summary.flowsQueued + summary.jobsRetried + summary.reservationsReleased
        if (acted > 0 || summary.anomalies.length > 0) console.log("🧹 Reconcile:", JSON.stringify(summary))
        return summary
    },
}

await connectDB({ handleSignals: false })

const worker = new Worker(
    ORDERS_QUEUE,
    async (job) => {
        const handler = handlers[job.name]
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
worker.on("error", (error) => console.error("Orders worker error:", error.message))

// "Upsert": starting the worker again updates the schedule instead of adding
// a second one, however many times it restarts.
const queue = getOrdersQueue()
await queue.waitUntilReady()
await queue.upsertJobScheduler(
    "reconcile",
    { every: reconcileEveryMs },
    { name: "reconcile", opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } }
)
console.log(`👷 Orders worker ready (reconcile every ${reconcileEveryMs / 1000} s, ` +
    `pending grace ${settings.pendingGraceMs / 1000} s, stale reservations after ${settings.staleReservationMs / 1000} s)`)

// On Ctrl+C, finish the jobs in hand, then exit.
let stopping = false
const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log("Stopping orders worker: finishing jobs in progress...")
    await worker.close()
    await closeQueues()
    await closeDB()
    process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
