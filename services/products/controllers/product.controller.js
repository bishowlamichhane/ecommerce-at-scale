import { Product } from "../models/Product.model.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import breaker from "../utils/circuitBreaker.js";
import { publishProductEvent } from "../utils/messageQueue.js";
import redis from "../utils/redisClient.js";
import { clearProductCache } from "../utils/cacheClear.js";
import mongoose from "mongoose";

const getProducts = asyncHandler(async (req, res) => {

  // try {
  //         const cached = cache.get("products");
  //         if(cached){
  //             console.log(cached)
  //             return res.status(200).json(new ApiResponse(200,"Products retrieved successfully from cache",cached));
  //         }
  //     const limit  = parseInt(req.query.limit) || 1000;
  //     const products = await index.search("", { limit: 1000 });;

  //     cache.set("products",products.hits);

  //     if(products.hits.length === 0)
  //         return res.status(200).json(new ApiResponse(200,"No products found",products.hits));

  //     else if(!products.hits)
  //         throw new ApiError(400,"Products failed to retrieve");

  //     return res.status(200).json(new ApiResponse(200,"Products retrieved successfully",products.hits));
  // } catch (error) {
  //     throw new ApiError(400,error?.message || "Failed to retrieve product")

  // }

  try {
    const limit = parseInt(req.query.limit)
    const skip = parseInt(req.query.skip)

    const cacheKey = `products:${skip}:${limit}`;

    // 1️⃣ Try Redis first
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      console.log("⚡ Redis cache hit");
      return res.status(200).json(
        new ApiResponse(
          200,
          "Products retrieved successfully from Redis cache",
          JSON.parse(cachedData)
        )
      );
    }

    console.log("🐢 Redis cache MISS");

    // 2️⃣ If not cached, fetch from MongoDB
    const products = await Product.find().skip(skip).limit(limit);

    if (!products) throw new ApiError(400, "Failed to retrieve products");

    // 3️⃣ Store in Redis for future requests (TTL 60 sec)
    await redis.set(cacheKey, JSON.stringify(products), "EX", 60);

    return res.status(200).json(
      new ApiResponse(200, "Products retrieved successfully", products)
    );
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

    const product = await Product.create({
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



    publishProductEvent({ action: "add", product: product.toObject() });


    await clearProductCache();








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

    const product = await Product.findById(id)

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

    const productToDelete = await Product.findByIdAndDelete(id);

    if (!productToDelete)
      throw new ApiError(404, "Product not found")


    publishProductEvent({ action: "delete", productId: id });


    await clearProductCache();

    res.status(200).json(new ApiResponse(200, "Product deleted successfully"));


  } catch (error) {
    throw new ApiError(error.statusCode || 400, error.message || "Failed to delete product")
  }
})

const updateProduct = asyncHandler(async (req, res) => {
  try {

    const { productId, image } = req.body

    const product = await Product.findByIdAndUpdate(productId, { $set: { image } },
      { new: true, runValidators: true })
    if (!product) {
      throw new ApiError(404, "Product not found");
    }
    publishProductEvent({ action: "update", product: product.toObject() });

    await clearProductCache();

    return res.json(new ApiResponse(200, "Product updated successfully", product)).status(200)




  } catch (error) {
    throw new ApiError(error.statusCode || 400, error.message || "Failed to update product");
  }
})

const removeAllProducts = asyncHandler(async (req, res) => {
  try {
    const result = await Product.deleteMany({});

    publishProductEvent({ action: "delete_all" });


    await redis.flushall();
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          `All products deleted successfully (${result.deletedCount} items removed)`
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



    const filters = {};
    let idList = [];
    // 1️ Restrict to search result IDs
    if (ids) {
      idList = Array.isArray(ids) ? ids : ids.split(",");
    }
    console.log("Parsed ID List:", idList);


    if (idList.length > 0) {
      filters._id = {
        $in: idList.map(id => new mongoose.Types.ObjectId(id.trim()))
      };
    }

    const parseValues = value => {
      if (!value) return [];
      return Array.isArray(value) ? value : value.split(",").map(v => v.trim());
    };




    // 2️ Apply all other filters normally
    if (category) filters.category = { $in: parseValues(category) };
    if (gender) filters.gender = { $in: parseValues(gender) };
    if (color) filters.color = { $in: parseValues(color) };
    if (usage) filters.usage = { $in: parseValues(usage) };
    if (subCategory) filters.subCategory = { $in: parseValues(subCategory) };

    if (priceMin || priceMax) {
      filters.price = {};
      if (priceMin) filters.price.$gte = Number(priceMin);
      if (priceMax) filters.price.$lte = Number(priceMax);
    }

    // 3️ Query MongoDB with filters
    const result = await Product.find(filters).limit(1000);
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