import express from "express"
const app = express()
import compression from "compression"
import NodeCache from "node-cache";

app.use(compression());
import cors from "cors"

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
export const cache = new NodeCache({stdTTL:60});



import productRouter from "./routes/products.routes.js"

app.use('/',productRouter)


export default app


