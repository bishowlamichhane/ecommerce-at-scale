import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import app from "./app.js"
import connectDB from "./db/db.js"
import { getFlowProducer, getInventoryQueue, getOrdersQueue } from "./utils/queues.js"
const port = process.env.PORT || 5003

// Bull Board: a web UI for the job queues, at http://localhost:5003/admin/queues.
// It can retry and delete jobs, so it's opt-in (BULL_BOARD=true). The gateway
// never exposes /orders/admin.
async function mountBullBoard() {
    const { createBullBoard } = await import("@bull-board/api")
    const { BullMQAdapter } = await import("@bull-board/api/bullMQAdapter")
    const { ExpressAdapter } = await import("@bull-board/express")
    const serverAdapter = new ExpressAdapter()
    serverAdapter.setBasePath("/admin/queues")
    createBullBoard({
        queues: [new BullMQAdapter(getOrdersQueue()), new BullMQAdapter(getInventoryQueue())],
        serverAdapter,
    })
    app.use("/admin/queues", serverAdapter.getRouter())
}

connectDB()
.then(async ()=>{
    if (process.env.BULL_BOARD === "true") await mountBullBoard()

    // Connect to Redis now, so the first orders don't race the connection.
    // If Redis is down, orders still save; the sweeper queues their jobs later.
    getFlowProducer().waitUntilReady().catch((e) => console.error("Job queue not ready:", e.message))

    app.listen(port,()=>{
        console.log("App listening at port:",port)
        if (process.env.BULL_BOARD === "true") console.log(`Bull Board: http://localhost:${port}/admin/queues`)
    })
})
.catch((err)=>{
    console.log("Database connection FAILED !!",err)
})
