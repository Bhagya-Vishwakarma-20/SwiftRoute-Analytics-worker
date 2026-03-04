const newrelic = require('newrelic');
const { prisma } = require('../lib/primaClient');
const { connectRabbitmq, Queue_name } = require('../lib/rabbitmq');

const handleMessage = async (message) => {
    console.log(message.content.toString())
    const parsedMessage = JSON.parse(message.content.toString());

    await prisma.click.create({
        data: {
            linkId: parsedMessage.linkId,
            ip: parsedMessage.ip,
            userAgent: parsedMessage.userAgent,
            referrer: parsedMessage.referrer,
            timestamp: new Date(parsedMessage.timestamp)
        }
    })
}



const startConsumer = async () => {
    const channel = await connectRabbitmq();
    channel.prefetch(20);
    channel.consume(
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
                        channel.nack(msg, false, false);
                    }
                })
        },
        { noAck: false }
    
    )

}
module.exports = { startConsumer }