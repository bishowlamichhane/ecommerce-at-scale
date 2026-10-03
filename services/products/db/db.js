import mongoose from "mongoose";
import { dbName } from "../constants.js";

const connectDB = async () => {
  try {
    const connectionInstance = await mongoose.connect(
      `${process.env.MONGODB_URI}`,
      {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }
    );

    console.log(`✅ MongoDB connected: ${connectionInstance.connection.host}`);

 
    process.on("SIGINT", async () => {
      await mongoose.connection.close();
      console.log("🔒 MongoDB connection closed due to app termination");
      process.exit(0);
    });

  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

export default connectDB;
