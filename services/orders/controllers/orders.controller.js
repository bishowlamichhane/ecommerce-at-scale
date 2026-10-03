import axios from "axios";
import { randomUUID } from "node:crypto";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { createOrder, findNotificationsByUser, findOrderById, findOrdersByUser } from "../models/Order.model.js";
import ApiResponse from "../utils/ApiResponse.js";
import breaker from "../utils/circuitBreaker.js";
import { releaseStock, reserveStock, toApiError } from "../utils/inventory.js";
import { enqueueOrderFlow } from "../utils/queues.js";

// There's no login yet: the shopper is whoever the X-User-Id header says.
const shopperId = (req) => req.get("X-User-Id") || "guest";

// Shared by checkout and buy-now. Take the stock, then save the order. If
// saving fails, the stock goes back right away.
//
// The buyer gets an answer as soon as the order is saved (status Pending).
// The rest happens in the background: commit-stock makes the stock final,
// then confirm-order confirms the order and emails the buyer. If Redis can't
// take those jobs right now, the order stays Pending and the sweeper
// (jobs/reconcile.js) queues them within a minute.
//
// items: [{ id, name, price, quantity }], where id is the product id
const reserveAndCreateOrder = async ({ userId, items, totalPrice, billing_address, shipping_address }) => {
    if (!billing_address || !shipping_address)
        throw new ApiError(400, "Billing and shipping address are required");

    const reservationId = randomUUID();
    await reserveStock(reservationId, items.map((item) => ({ productId: item.id, quantity: item.quantity })));

    let order;
    try {
        order = await createOrder({
            user_id: userId,
            reservation_id: reservationId,
            items,
            totalPrice,
            billing_address,
            shipping_address,
        });
    } catch (error) {
        // If this release fails too, the sweeper releases the stock later:
        // no order will ever claim this reservation.
        await releaseStock(reservationId).catch((e) =>
            console.error(`Release failed for reservation ${reservationId}:`, e.message));
        throw error;
    }

    await enqueueOrderFlow({ orderId: order.id, reservationId }).catch((e) =>
        console.error(`Couldn't queue order ${order.id} (the sweeper will):`, e.message));

    return order;
}


const placeOrder = asyncHandler(async (req, res) => {

    const userId = shopperId(req)
    const { billing_address, shipping_address } = req.body
    const asShopper = { headers: { "X-User-Id": userId } }

    try {
        const cartResponse = await breaker.fire(`${process.env.CART_SERVICE_URL}/get-cart-items`, { method: "GET", ...asShopper });
        const cart = cartResponse.message;

        if (!cart || cart.products.length === 0)
            throw new ApiError(400, "Cart is Empty");

        const order = await reserveAndCreateOrder({
            userId,
            items: cart.products,
            totalPrice: cart.totalPrice,
            billing_address,
            shipping_address
        })

        await axios.delete(`${process.env.CART_SERVICE_URL}/clear-cart`, asShopper);

        return res.status(201).json(new ApiResponse(201, "Order placed successfully", order))

    } catch (error) {
        throw toApiError(error, "Order failed")
    }

})


// The flash-sale path: one request buys one product, no cart involved.
const buyNow = asyncHandler(async (req, res) => {

    const userId = shopperId(req)
    const { productId, billing_address, shipping_address } = req.body
    const quantity = Number(req.body.quantity)

    try {
        if (!productId || !Number.isInteger(quantity) || quantity <= 0)
            throw new ApiError(400, "Missing product id or quantity");

        const productRes = await axios.get(`${process.env.PRODUCT_SERVICE_URL}/get-product-by-id/${productId}`, { timeout: 5000 });
        const product = productRes.data.message

        const order = await reserveAndCreateOrder({
            userId,
            items: [{ id: product.id, name: product.name, price: product.price, quantity }],
            totalPrice: Math.round(product.price * quantity * 100) / 100,
            billing_address,
            shipping_address
        })

        return res.status(201).json(new ApiResponse(201, "Order placed successfully", order))

    } catch (error) {
        throw toApiError(error, "Order failed")
    }

})


const checkStatusById = asyncHandler(async (req, res) => {

    const { orderId } = req.params

    if (!orderId)
        throw new ApiError(400, "Order Id required");

    try {

        const order = await findOrderById(orderId);
        if (!order)
            throw new ApiError(400, "Order not found");

        return res.status(200).json(new ApiResponse(200, "Order status received", order.status));



    } catch (error) {
        throw new ApiError(error.statusCode || 400, error.message || "Failed to receive order status")
    }

})


// The shopper's latest orders with their status; the sale page polls this to
// show Pending turning into Processing (confirmed) or Cancelled.
const myOrders = asyncHandler(async (req, res) => {
    const orders = await findOrdersByUser(shopperId(req));
    return res.status(200).json(new ApiResponse(200, "Your orders", orders));
})

// The shopper's simulated inbox: the emails the confirmation job "sent".
const myNotifications = asyncHandler(async (req, res) => {
    const notifications = await findNotificationsByUser(shopperId(req));
    return res.status(200).json(new ApiResponse(200, "Your notifications", notifications));
})


export { placeOrder, buyNow, checkStatusById, myOrders, myNotifications }
