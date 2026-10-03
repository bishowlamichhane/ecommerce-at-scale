import express from "express"
const app = express()
import cors from "cors"


app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))



import cartRouter from "./routes/cart.routes.js"

app.use('/',cartRouter);



export default app


