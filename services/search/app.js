import express from "express"
const app = express()
import cors from "cors"


app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))




import searchRouter from "./routes/search.routes.js"

app.use('/',searchRouter);


export default app


