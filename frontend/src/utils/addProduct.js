import  {items} from "../../clothing_items.js";

import axios from "axios";

const addProduct = async () => {
  try {
    // Create an array of promises
    const requests = items.map((item) =>
      axios.post("http://localhost:5000/products/add-product", item)
    );

    // Wait for all requests to finish
    const responses = await Promise.all(requests);

    console.log(`✅ Added ${responses.length} products successfully.`);
  } catch (error) {
    console.error("❌ Error adding data:", error.message);
  }
};

addProduct();
