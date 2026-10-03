import mongoose, { Schema } from "mongoose";

const cartItemSchema = new mongoose.Schema({
    productId:
       { type:Schema.Types.ObjectId,
        ref:"Product"
       },
    
    name:{
        type:String,required:true
    },
    price:{
        type:Number
    },
    quantity: { type: Number, required: true },
   
    description: { type: String },
    image: { type: String },
},{timestamps:true})



const cartSchema = new mongoose.Schema({

    items:[cartItemSchema],
    totalPrice:{
        type:Number,
        required:true,
        default:0
    },
},{timestamps:true})

export const Cart = mongoose.model("Cart",cartSchema)