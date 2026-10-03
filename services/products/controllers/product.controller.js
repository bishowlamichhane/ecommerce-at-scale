import {
  createProduct,
  deleteAllProducts,
  deleteProductById,
  filterProducts as findFilteredProducts,
  findProductById,
  findProducts,
  updateProductImage,
} from "../models/Product.model.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import breaker from "../utils/circuitBreaker.js";
import { publishProductEvent } from "../utils/messageQueue.js";
import { cacheStatusHeader } from "../utils/cache.js";
import { catalogCache, ITEM_TTL_SECONDS, itemKey, LIST_TTL_SECONDS, listKey } from "../utils/catalogCache.js";

// Reads through the catalog cache when the request is cacheable, otherwise
// straight from Postgres, and tells the client which it was (Cache-Status).
async function readCatalog(res, { cacheable, key, load, ttlSeconds }) {
  if (!cacheable) {
    // Set before reading, so a request Postgres rejects still says why it
    // skipped the cache.
    const status = { fwd: "bypass", detail: "not-cacheable" };
    res.set("Cache-Status", cacheStatusHeader("catalog", status));
    return { value: await load(), status };
  }
  const { value, status } = await catalogCache().read(key, load, { ttlSeconds });
  res.set("Cache-Status", cacheStatusHeader("catalog", status));
  return { value, status };
}

// A page of the product list. Only ordinary pages are cached: a request
// without limit/skip (which returns every product, as search's /sync asks)
// or with a huge one goes straight to Postgres, so nobody can fill Redis with
// one-off pages.
const getProducts = asyncHandler(async (req, res) => {
  try {
    const limit = parseInt(req.query.limit)
    const skip = parseInt(req.query.skip)
    const cacheable = Number.isInteger(limit) && Number.isInteger(skip)
      && limit >= 1 && limit <= 100 && skip >= 0 && skip <= 10_000;

    const { value: products, status } = await readCatalog(res, {
      cacheable,
      key: listKey(skip, limit),
      load: () => findProducts({ skip, limit }),
      ttlSeconds: LIST_TTL_SECONDS,
    });

    const message = status.hit ? "Products retrieved successfully from Redis cache" : "Products retrieved successfully";
    return res.status(200).json(new ApiResponse(200, message, products));
  } catch (error) {
    throw new ApiError(
      error.statusCode || 400,
      error.message || "Failed to retrieve products"
    );
  }


})


const addProduct = asyncHandler(async (req, res) => {

  try {

    let { name } = req.body
    let { price } = req.body
    let { stock } = req.body
    let { category } = req.body
    let { gender } = req.body
    let { color } = req.body
    let { image } = req.body
    let { subcategory } = req.body
    let { usage } = req.body
    let { description } = req.body

    if (!name || !price)
      throw new ApiError(400, "Name, price, and stock are required")

    const product = await createProduct({
      name,
      price,
      stock,
      subcategory,
      color,
      usage,
      image,
      gender,
      category,
      description,
    });



    // Invalidate first: it never throws, while publishing can (RabbitMQ down).
    await catalogCache().invalidate();
    publishProductEvent({ action: "add", product });








    return res.status(201).json(new ApiResponse(201, "Product added successfully", product))




  } catch (error) {

    throw new ApiError(400, error?.message || "Failed to add product")

  }



})


const getProductById = asyncHandler(async (req, res) => {
  const { id } = req.params


  try {
    if (!id)
      throw new ApiError(400, "Product ID is required");

    // Only plain digits within Postgres' integer range are cached, under the
    // canonical id, so /7 and /007 share one entry. Anything else goes to
    // Postgres untouched and gets the answer it always got: Number() would
    // read "1e3" as 1000, where Postgres rejects it.
    // "Not found" is cached as well (negative caching), so random ids can't
    // hammer the database; a product created later bumps the cache version,
    // so it still shows up at once.
    const numericId = /^\d{1,10}$/.test(id) ? Number(id) : NaN
    const cacheable = numericId >= 1 && numericId <= 2_147_483_647
    const { value: product } = await readCatalog(res, {
      cacheable,
      key: itemKey(numericId),
      load: () => findProductById(cacheable ? numericId : id),
      ttlSeconds: ITEM_TTL_SECONDS,
    })

    if (!product)
      throw new ApiError(404, "Product not found");

    return res.status(200).json(new ApiResponse(200, "Product retrieved successfully", product));

  } catch (error) {
    throw new ApiError(error.statusCode || 400, error.message || "Failed to retrieve product");
  }
})


const removeProduct = asyncHandler(async (req, res) => {
  try {

    const { id } = req.params

    if (!id)
      throw new ApiError(400, "Product id is required")

    const productToDelete = await deleteProductById(id);

    if (!productToDelete)
      throw new ApiError(404, "Product not found")


    await catalogCache().invalidate();
    publishProductEvent({ action: "delete", productId: id });

    res.status(200).json(new ApiResponse(200, "Product deleted successfully"));


  } catch (error) {
    throw new ApiError(error.statusCode || 400, error.message || "Failed to delete product")
  }
})

const updateProduct = asyncHandler(async (req, res) => {
  try {

    const { productId, image } = req.body

    const product = await updateProductImage(productId, image)
    if (!product) {
      throw new ApiError(404, "Product not found");
    }
    await catalogCache().invalidate();
    publishProductEvent({ action: "update", product });

    return res.json(new ApiResponse(200, "Product updated successfully", product)).status(200)




  } catch (error) {
    throw new ApiError(error.statusCode || 400, error.message || "Failed to update product");
  }
})

const removeAllProducts = asyncHandler(async (req, res) => {
  try {
    const deletedCount = await deleteAllProducts();

    // This used to be `flushall`, which also wiped the rate limits, a running
    // sale's stock counters and reservations, and the job queues. Only the
    // catalog cache needs to go, and bumping its version does that in O(1).
    await catalogCache().invalidate();
    publishProductEvent({ action: "delete_all" });
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          `All products deleted successfully (${deletedCount} items removed)`
        )
      );
  } catch (error) {
    throw new ApiError(
      error.statusCode || 400,
      error.message || "Failed to delete all products"
    );
  }

})


const filterProducts = asyncHandler(async (req, res) => {
  const {

    category,
    gender,
    color,
    usage,
    subCategory,
    priceMin,
    priceMax
  } = req.query;
  const { ids } = req.body;
  console.log("Raw ids:", ids);

  try {



    let idList = [];
    // 1️ Restrict to search result IDs
    if (ids) {
      idList = Array.isArray(ids) ? ids : ids.split(",");
    }
    idList = idList.map(id => String(id).trim());
    console.log("Parsed ID List:", idList);

    const parseValues = value => {
      if (!value) return [];
      return Array.isArray(value) ? value : value.split(",").map(v => v.trim());
    };

    // 2️ Apply all other filters normally.
    // Still reads `subCategory` while the frontend sends `subcategory`, so the
    // subcategory filter stays off until project 2 fixes it.
    // 3️ Query Postgres with filters
    const result = await findFilteredProducts({
      ids: idList,
      category: parseValues(category),
      gender: parseValues(gender),
      color: parseValues(color),
      usage: parseValues(usage),
      subcategory: parseValues(subCategory),
      priceMin,
      priceMax,
    });
    console.log(result)
    return res.status(200).json(
      new ApiResponse(200, "Filtered products retrieved successfully", result)
    );
  } catch (error) {
    console.error("Product filtering error:", error);
    throw new ApiError(400, error.message || "Product filtering failed");
  }
});


export {
  getProducts,
  addProduct,
  getProductById,
  removeProduct,
  updateProduct,
  removeAllProducts,
  filterProducts

}