import express from "express"
import { commit, release, reserve, stale } from "../controllers/inventory.controller.js"

const inventoryRouter = express.Router()

inventoryRouter.route('/reserve').post(reserve)
inventoryRouter.route('/commit').post(commit)
inventoryRouter.route('/release').post(release)
inventoryRouter.route('/stale').get(stale)

export default inventoryRouter
