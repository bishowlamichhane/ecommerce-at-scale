import amqplib from "amqplib";
import client from "./meiliClient.js"; 

let index;





async function ensureIndex() {
    try {
        await client.createIndex("products", { primaryKey: "id" });
        console.log(" Products index created with primary key 'id'");
    } catch (err) {
        if (err.code === "index_already_exists") {
            console.log("Products index already exists");
        } else {
            throw err;
        }
    }
}


export async function startRabbitConsumer() {
    try {
        await ensureIndex();
        index = client.index("products"); 

        const connection = await amqplib.connect("amqp://localhost");
        const channel = await connection.createChannel();
        await channel.assertQueue("product_updates", { durable: true });

        console.log(" Listening for product updates...");

        channel.consume("product_updates", async (msg) => {
            if (!msg) return;

            const event = JSON.parse(msg.content.toString());
            console.log(" Received event:", event);

            try {
                switch (event.action) {
                    case "add":
                    case "update": {
                        const product = event.product;
                        if (!product) break;

                        const doc = {
                        
                            id: product._id?.toString() || product.id?.toString(),
                            name: product.name,
                            price: product.price,
                            stock: product.stock,
                            category: product.category,
                            description: product.description,
                        };

                  
                       await index.addDocuments([doc]);
                        
                     

                        console.log(`✅ Product ${event.action}ed and synced to search index: ${doc.id}`);
                        break;
                    }

                    case "delete": {
                        const productId = event.productId;
                        if (!productId) break;

                     await index.deleteDocument(productId.toString());
                        
                     
                        console.log(`✅ Product deleted and synced from search index: ${productId}`);
                        break;
                    }

                    default:
                        console.warn("⚠️ Unknown event type:", event.action);
                }

            } catch (err) {
                console.error("❌ Failed to process MeiliSearch event:", err.message);
            }

            channel.ack(msg);
        });
    } catch (err) {
        console.error("❌ Fatal error in RabbitMQ Consumer setup:", err.message);
    }
}