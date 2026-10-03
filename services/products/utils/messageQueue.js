import amqplib from "amqplib";

let channel;

export async function connectRabbitMQ() {
  const connection = await amqplib.connect("amqp://localhost");
  channel = await connection.createChannel();
  await channel.assertQueue("product_updates", { durable: true });
  console.log("✅ RabbitMQ connected (Product Service)");
}

export function publishProductEvent(event) {
  if (!channel) throw new Error("RabbitMQ channel not initialized");
  channel.sendToQueue("product_updates", Buffer.from(JSON.stringify(event)));
  console.log(" Published event:", event);
}
