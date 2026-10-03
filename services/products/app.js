import express from "express"
const app = express()
import compression from "compression"

app.use(compression());
import cors from "cors"

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))



import productRouter from "./routes/products.routes.js"
import inventoryRouter from "./routes/inventory.routes.js"

app.use('/inventory',inventoryRouter)
app.use('/',productRouter)


export default app


