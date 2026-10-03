import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { findProductById } from "../models/Product.model.js";
import { currentSaleProductId } from "../models/Sale.model.js";
import { checkoutMode, stockView } from "../utils/inventoryActions.js";

// The flash sale running right now, for the storefront's sale page: the
// product, and its stock as each part of the system sees it. `npm run
// sale:reset` decides which product is on sale.
export const getCurrentSale = asyncHandler(async (req, res) => {
  const productId = await currentSaleProductId();
  const product = productId ? await findProductById(productId) : null;
  if (!product)
    throw new ApiError(404, "No flash sale is running. Start one: npm run sale -- 10");

  const stock = await stockView(product);
  return res.status(200).json(new ApiResponse(200, "Current sale", { product, stock, mode: checkoutMode() }));
});
