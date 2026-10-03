import express from "express"
import { checkStatusById, placeOrder } from "../controllers/orders.controller.js"

const orderRouter = express.Router()

orderRouter.route('/place-order').post(placeOrder)
orderRouter.route('/check-order-status-by-id/:orderId').get(checkStatusById)

export default orderRouter