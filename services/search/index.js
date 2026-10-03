import dotenv from "dotenv"
dotenv.config({
    path:"./.env"
})
import app from "./app.js"
import { startRabbitConsumer } from "./utils/messageQueue.js"
const port = process.env.PORT || 5004

// Search has no database of its own: Meilisearch is its store.
app.listen(port,()=>{
    console.log("App listening at port:",port)
});
startRabbitConsumer();
