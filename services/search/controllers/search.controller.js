import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import breaker from "../utils/circuitBreaker.js";
import client from "../utils/meiliClient.js";
const index = client.index("products"); 

const syncProducts = asyncHandler(async (req, res) => {
  try {
    const response = await breaker.fire("http://localhost:5001/get-products?query=1000");
    const products = response.message;

    if (!Array.isArray(products))
      throw new ApiError(400, "Invalid response from products service");

    // 1. Clear index
    await index.deleteAllDocuments();

    // 2. Insert all products fresh
    await index.addDocuments(products);

    return res.status(200).json(
      new ApiResponse(
        200,
        "Sync successful",
        { count: products.length },
        "Reindexed without waitForTask"
      )
    );
  } catch (error) {
    throw new ApiError(500, error.message || "Sync failed");
  }
});


const searchProducts = asyncHandler(async(req,res)=>{
  try {

    const {q} = req.query

    if(!q) throw new ApiError(400,"Search query (q) is required");

    const results = await index.search(q,{
      limit:1000,
      attributesToHighlight:["name","category"],

    })

    console.log(results)

    return res.status(200).json(new ApiResponse(200,"Search results fetched",results.hits,{ count: results.hits.length }))

  } catch (error) {
      throw new ApiError(500,error.message || "Search failed");
  }
})

export {syncProducts,searchProducts}