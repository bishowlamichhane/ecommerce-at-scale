import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import app from "./app.js"
import connectDB from "./db/db.js"
import { connectRabbitMQ } from "./utils/messageQueue.js"
import { checkoutMode } from "./utils/inventoryActions.js"
const port = process.env.PORT || 5001

connectDB()
.then(()=>{
    app.listen(port,()=>{
        console.log("App listening at port:",port)
        console.log("Checkout mode:", checkoutMode())
    });
    connectRabbitMQ();
})
.catch((err)=>{
    console.log("Database connection FAILED !!",err)
})
