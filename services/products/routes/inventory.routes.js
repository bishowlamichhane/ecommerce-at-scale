import express from "express"
import { commit, release, reserve } from "../controllers/inventory.controller.js"

const inventoryRouter = express.Router()

inventoryRouter.route('/reserve').post(reserve)
inventoryRouter.route('/commit').post(commit)
inventoryRouter.route('/release').post(release)

export default inventoryRouter
