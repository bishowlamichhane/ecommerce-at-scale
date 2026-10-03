import express from "express"
const app = express()
import cors from "cors"


app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))




import orderRouter from "./routes/orders.routes.js"

app.use('/',orderRouter);

export default app


