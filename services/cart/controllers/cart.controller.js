import { deleteCart, findCart, saveCart } from "../models/Cart.model.js"
import ApiError from "../utils/ApiError.js"
import ApiResponse from "../utils/ApiResponse.js"
import asyncHandler from "../utils/asyncHandler.js"
import axios from "axios"
import breaker from "../utils/circuitBreaker.js"

// There's no login yet: the shopper is whoever the X-User-Id header says.
const shopperId = (req) => req.get("X-User-Id") || "guest"



const addToCart = asyncHandler(async (req, res) => {

    const { productId, quantity } = req.body
    console.log(quantity)
    try {

        if (!productId || !quantity || quantity <= 0)
            throw new ApiError(400, "Missing product id or quantity");

        const productResponse = await breaker.fire(`${process.env.PRODUCT_SERVICE_URL}/get-product-by-id/${productId}`, {
            method: "GET",
        });
        const productData = productResponse.message;
        const product = productData;




        if (!product || !product.name || !product.price)
            throw new ApiError(404, "Product not found or invalid product data")

        else if (quantity > product.stock)
            throw new ApiError(404, "Quantity more then stock amount")

        let cart = await findCart(shopperId(req));
        if (!cart) {
            cart = { items: [], totalPrice: 0 }
        }

        // Ids are numbers now, but may arrive as strings: compare as strings.
        const existingItem = cart.items.find(
            (item) => String(item.productId) === String(productId)
        );

        if (existingItem) {
            if (existingItem.quantity + quantity > product.stock)
                throw new ApiError(404, "Quantity more then stock amount")
            else
                existingItem.quantity += quantity;
        }



        else {
            cart.items.push({
                productId: product.id,
                name: product.name,
                price: product.price,
                quantity,

                image: product.image || ''
            })
        }

        cart.totalPrice = cart.items.reduce((sum, item) => {
            const itemTotal = (item.price || 0) * (item.quantity || 0);
            return sum + itemTotal;
        }, 0)

        cart = await saveCart(cart, shopperId(req))

        return res.status(200).json(new ApiResponse(200, "Item added to cart", cart))

    } catch (error) {
        if (error.code === "EOPENBREAKER") {
            throw new ApiError(503, "Product service unavailable, please try later");
        }
        throw new ApiError(error.statusCode || 400, error.message || "Failed to add item to cart");
    }

})


const getCartItems = asyncHandler(async (req, res) => {

    try {

        const cart = await findCart(shopperId(req));
        console.log(cart)

        if (!cart) {
            throw new ApiError(404, "Cart cannot be retrieved")
        }
        if (cart.items.length === 0) {
            return res.status(200).json(new ApiResponse(200, "No items in cart", { products: [], totalPrice: 0 }))
        }
        const productIds = cart?.items?.map((p) =>
            p.productId.toString()
        )

        const productResponses = await Promise.all(
            productIds.map(async (id) => {
                try {
                    // Each call goes through the breaker
                    return await breaker.fire(`${process.env.PRODUCT_SERVICE_URL}/get-product-by-id/${id}`);
                } catch (err) {
                    console.log(`Product ${id} fetch failed. Returning fallback.`);
                    return { id, name: "Unknown product", price: 0 }; // fallback data
                }
            })
        );

        const products = productResponses.map((res, i) => {
            const { name, price, id, image } = res.message;
            return {
                name, image, price, id, quantity: cart.items[i].quantity
            }
        });


        const totalPrice = cart?.totalPrice || 0

        return res
            .status(200)
            .json(new ApiResponse(200, "Cart items retrieved successfully", { products, totalPrice }));


    } catch (error) {
        throw new ApiError(error.statusCode || 400, error.message || "Failed to get cart items")
    }



})

const removeFromCart = asyncHandler(async (req, res) => {

    const { productId, quantity } = req.body;

    try {

        let cart = await findCart(shopperId(req));

        if (!cart || !cart.items.length) {
            throw new ApiError(404, "No items in cart")
        }

        const existingItem = cart.items.find(
            (p) => String(p.productId) === String(productId)
        )
        if (!existingItem)
            throw new ApiError(404, "Item not found in cart")

        if (quantity) {
            if (existingItem.quantity > quantity) {
                existingItem.quantity -= quantity;
            }
            else if (existingItem.quantity == quantity) {
                cart.items = cart.items.filter((p) => String(p.productId) !== String(productId));
            }
            else {
                throw new ApiError(400, `Cart only has ${existingItem.quantity} items.`)
            }
        }

        let totalPrice = cart.items.reduce((sum, item) => {
            const itemTotal = (item.price || 0) * (item.quantity || 0);
            return sum + itemTotal
        }, 0);
        cart.totalPrice = totalPrice;
        cart = await saveCart(cart, shopperId(req));
        return res.status(200).json(new ApiResponse(200, "Items removed", { cart }))

    }
    catch (error) {
        throw new ApiError(error.statusCode || 400, error.message || "Failed to remove from cart");

    }
})

const clearCart = asyncHandler(async (req, res) => {

    try {
        const cart = await deleteCart(shopperId(req));

        return res.status(200).json(new ApiResponse(200, "Cart cleared successfully", cart))


    } catch (error) {
        throw new ApiError(error.statusCode || 400, error.message || "Failed to clear cart")
    }

})


export { addToCart, getCartItems, removeFromCart, clearCart }

