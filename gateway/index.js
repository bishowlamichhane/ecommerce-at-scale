import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import { createProxyMiddleware } from "http-proxy-middleware"

dotenv.config({ path: "./.env" }); 
const app = express(); 
app.use(cors());  

const port = process.env.PORT || 5000


app.use("/products", createProxyMiddleware({
  target: process.env.PRODUCT_SERVICE_URL,
  changeOrigin: true,
}))

app.use("/cart", createProxyMiddleware({
  target: process.env.CART_SERVICE_URL,
  changeOrigin: true,
}))

app.use("/orders", createProxyMiddleware({
  target: process.env.ORDERS_SERVICE_URL,
  changeOrigin: true,
}))

app.use("/search", createProxyMiddleware({
  target: process.env.SEARCH_SERVICE_URL,
  changeOrigin: true,
}))

app.get("/", (req, res) => {
  res.send("Gateway is up and running ")
})

app.listen(port, () => {
  console.log(`Gateway listening on port ${port}`)
})
