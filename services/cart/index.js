import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import app from "./app.js"
import connectDB from "./db/db.js"
const port = process.env.PORT || 5002

connectDB()
.then(()=>{
    app.listen(port,()=>{
        console.log("App listening at port:",port)
    })
})
.catch((err)=>{
    console.log("MongoDB connection FAILED !!",err)
})