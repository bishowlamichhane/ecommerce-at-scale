import express from "express"
import { addProduct, filterProducts, getProductById, getProducts, removeAllProducts, removeProduct, updateProduct } from "../controllers/product.controller.js"
import { getCurrentSale } from "../controllers/sale.controller.js"



const productRouter = express.Router()


productRouter.route('/get-products').get(getProducts)
productRouter.route('/add-product').post(addProduct)
productRouter.route('/get-product-by-id/:id').get(getProductById)
productRouter.route('/remove-product/:id').delete(removeProduct)
productRouter.route('/update-product').patch(updateProduct)
productRouter.route('/remove-all-products').delete(removeAllProducts)
productRouter.route('/filter-products').post(filterProducts)
productRouter.route('/sale/current').get(getCurrentSale)

export default productRouter
