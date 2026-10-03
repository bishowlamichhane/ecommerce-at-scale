import express from "express"
import { addToCart, clearCart, getCartItems, removeFromCart } from "../controllers/cart.controller.js"
const cartRouter = express.Router()


cartRouter.route('/add-to-cart').post(addToCart)
cartRouter.route('/get-cart-items').get(getCartItems)
cartRouter.route('/remove-item').delete(removeFromCart)
cartRouter.route('/clear-cart').delete(clearCart)

export default cartRouter