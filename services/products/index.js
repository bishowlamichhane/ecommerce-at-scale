import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import app from "./app.js"
import connectDB from "./db/db.js"
import { connectRabbitMQ } from "./utils/messageQueue.js"
import { checkoutMode } from "./utils/inventoryActions.js"
import { catalogCache } from "./utils/catalogCache.js"
import redis, { cacheRedis, waitForRedis } from "./utils/redisClient.js"
const port = process.env.PORT || 5001

connectDB()
.then(async ()=>{
    // Give Redis a moment to connect, so the first requests don't miss it.
    // Without it the service still starts: the cache reads Postgres instead.
    const ready = await Promise.all([waitForRedis(redis), waitForRedis(cacheRedis)])
    if (!ready.every(Boolean)) console.warn("Redis isn't reachable yet; the cache falls back to Postgres until it is")

    app.listen(port,()=>{
        console.log("App listening at port:",port)
        console.log("Checkout mode:", checkoutMode(), "| cache mode:", catalogCache().mode)
    });
    connectRabbitMQ();
})
.catch((err)=>{
    console.log("Database connection FAILED !!",err)
})
