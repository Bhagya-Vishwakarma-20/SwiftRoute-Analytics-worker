require("dotenv/config");
const amqplib = require("amqplib");

const Queue_name = "click_analytics";
let channel = null;

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const connectRabbitmq = async () => {
    if (channel) return channel;

    while (true) {
        try {
            console.log("Connecting to RabbitMQ...");
            const connection = await amqplib.connect(process.env.AMQP_URL);

            connection.on("error", err => {
                console.error("RabbitMQ connection error:", err.message);
            });

            connection.on("close", () => {
                console.error("RabbitMQ connection closed. Reconnecting...");
                channel = null;
            });

            channel = await connection.createChannel();

            await channel.assertQueue(Queue_name, {
                durable: true
            });

            console.log("Connected to RabbitMQ");
            return channel;

        } catch (err) {
            console.error("RabbitMQ not ready. Retrying in 5 seconds...");
            await sleep(5000);
        }
    }
};

module.exports = { connectRabbitmq, Queue_name };