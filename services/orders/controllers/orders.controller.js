import axios from "axios";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { createOrder, findOrderById } from "../models/Order.model.js";
import ApiResponse from "../utils/ApiResponse.js";
import breaker from "../utils/circuitBreaker.js";


const placeOrder = asyncHandler(async (req, res) => {

    const { userId, billing_address, shipping_address } = req.body

    try {
        const cartResponse = await breaker.fire(`${process.env.CART_SERVICE_URL}/get-cart-items`, { method: "GET" });
        const cart = cartResponse.message;

        console.log("Cart-retrieved", cart)

        if (!cart)
            throw new ApiError(400, "Cart is Empty");


        for (const item of cart.products) {
            const productRes = await axios.get(`${process.env.PRODUCT_SERVICE_URL}/get-product-by-id/${item.id}`);
            console.log("product-Retrieved", productRes)
            const product = productRes.data.message

            if (product.stock < item.quantity) {
                throw new ApiError(400, `Not enough stock for ${product.name}`)
            }

            await axios.patch(`${process.env.PRODUCT_SERVICE_URL}/update-product`,
                {
                    productId: product.id, stock: product.stock - item.quantity
                })
        }


        const order = await createOrder({
            userId,
            items: cart.products,
            totalPrice: cart.totalPrice,
            billing_address,
            shipping_address
        })





        await axios.delete(`${process.env.CART_SERVICE_URL}/clear-cart`);



        return res.status(201).json(new ApiResponse(201, "Order placed successfully", order))




    } catch (error) {
        throw new ApiError(error.statusCode || 500, error.message || "Order failed")
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




export { placeOrder, checkStatusById }