import mongoose, { Schema } from "mongoose";

const orderSchema = new mongoose.Schema({

        user_id:{
            type:String,
            default:"user123"
        },
        billing_address:{
            type:String,
            required:true,
        },
        shipping_address:{
            type:String,
            required:true
        },
        items:[
            {
                productId:{type:Schema.Types.ObjectId,ref:"Product"},
                name:String,
                price:Number,
                quantity:Number
            }
        ],
        totalPrice:Number,
        status:{
            type:String,
            enum:["Pending","Processing","Shipped","Delivered","Cancelled"],
            default:"Pending"
        
        }
        
        




},{timestamps:true})


export const Order = mongoose.model("Order",orderSchema)