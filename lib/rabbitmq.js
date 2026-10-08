require("dotenv/config");
const amqplib = require("amqplib");

const Queue_name = "click_analytics";
let connection = null;
let channel = null;
let onReady = null;
let connecting = false;
let closing = false;

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const connect = async () => {
    if (connecting || closing) return;
    connecting = true;

    while (!closing) {
        try {
            console.log("Connecting to RabbitMQ...");
            const conn = await amqplib.connect(process.env.AMQP_URL);

            conn.on("error", err => {
                console.error("RabbitMQ connection error:", err.message);
            });

            conn.on("close", () => {
                if (connection !== conn) return;
                connection = null;
                channel = null;
                if (closing) return;
                console.error("RabbitMQ connection closed. Reconnecting...");
                connect();
            });

            const ch = await conn.createChannel();

            ch.on("error", err => {
                console.error("RabbitMQ channel error:", err.message);
            });

            // a dead channel on a live connection would stop consumption, so drop the connection and reconnect
            ch.on("close", () => {
                if (channel === ch) conn.close().catch(() => {});
            });

            await ch.assertQueue(Queue_name, {
                durable: true
            });

            connection = conn;
            channel = ch;
            console.log("Connected to RabbitMQ");

            if (onReady) await onReady(ch);
            connecting = false;
            return;

        } catch (err) {
            console.error("RabbitMQ not ready. Retrying in 5 seconds...", err.message);
            if (connection) {
                const stale = connection;
                connection = null;
                channel = null;
                stale.close().catch(() => {});
            }
            await sleep(5000);
        }
    }
    connecting = false;
};

// onReady runs on every (re)connect, so the consumer is re-registered on the new channel
const connectRabbitmq = async (ready) => {
    onReady = ready;
    await connect();
};

const closeRabbitmq = async () => {
    closing = true;
    const conn = connection;
    connection = null;
    channel = null;
    if (conn) await conn.close().catch(() => {});
};

module.exports = { connectRabbitmq, closeRabbitmq, Queue_name };
