import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
    name:{
        type:String,
        required:true
    },
    price:{
        type:Number,required:true
    },
    stock: { type: Number },
    category: { type: String },
    gender: { type: String },
    subcategory: { type: String },
    color: { type: String },
    usage: { type: String },
    description: { type: String },
    image: { type: String },
},{timestamps:true})


productSchema.index({ category: 1 });
productSchema.index({ gender: 1 });
productSchema.index({ color: 1 });
productSchema.index({ usage: 1 });
productSchema.index({ subcategory: 1 });
productSchema.index({ price: 1 });

productSchema.index({ category: 1, gender: 1, color: 1 });

export const Product = mongoose.model("Product",productSchema)
