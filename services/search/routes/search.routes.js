import express from 'express'
import {searchProducts, syncProducts} from '../controllers/search.controller.js'

const searchRouter = express.Router()



searchRouter.route('/sync').get(syncProducts)
searchRouter.route('/search-products').get(searchProducts)

export default searchRouter