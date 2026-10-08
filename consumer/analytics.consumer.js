const newrelic = require('newrelic');
const { prisma } = require('../lib/primaClient');
const { connectRabbitmq, Queue_name } = require('../lib/rabbitmq');

const toStr = (v) => (typeof v === 'string' && v !== '' ? v : null);
const toFloat = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toInt = (v) => (Number.isInteger(v) ? v : null);

const handleMessage = async (message) => {
    console.log(message.content.toString())
    const parsedMessage = JSON.parse(message.content.toString());

    await prisma.click.create({
        data: {
            linkId: parsedMessage.linkId,
            country : parsedMessage.country,
            ip: parsedMessage.ip,
            userAgent: parsedMessage.userAgent,
            referrer: parsedMessage.referrer,
            region: toStr(parsedMessage.region),
            city: toStr(parsedMessage.city),
            latitude: toFloat(parsedMessage.latitude),
            longitude: toFloat(parsedMessage.longitude),
            timezone: toStr(parsedMessage.timezone),
            accuracyRadius: toInt(parsedMessage.accuracyRadius),
            timestamp: new Date(parsedMessage.timestamp)
        }
    })
}



const registerConsumer = async (channel) => {
    channel.prefetch(20);
    await channel.consume(
        Queue_name,
        async (msg) => {
            if (!msg) return;
            newrelic.startBackgroundTransaction('AnalyticsMessageProcessing',
                async () => {
                    try {
                        const transaction = newrelic.getTransaction();
                        await handleMessage(msg);
                        channel.ack(msg);
                        transaction.end();
                    } catch (error) {
                        console.error("Failed to process message:", error.message);
                        newrelic.noticeError(error);
                        try {
                            channel.nack(msg, false, false);
                        } catch (nackError) {
                            console.error("Failed to nack message:", nackError.message);
                        }
                    }
                })
        },
        { noAck: false }
    )
}

const startConsumer = async () => {
    await connectRabbitmq(registerConsumer);
}
module.exports = { startConsumer, handleMessage }
