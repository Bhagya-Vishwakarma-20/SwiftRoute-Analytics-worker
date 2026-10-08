const newrelic = require('newrelic');
const { prisma } = require('../lib/primaClient');
const { connectRabbitmq, Queue_name } = require('../lib/rabbitmq');
const { lookupIp } = require('../lib/ipinfo');

const toStr = (v) => (typeof v === 'string' && v !== '' ? v : null);
const toFloat = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toInt = (v) => (Number.isInteger(v) ? v : null);

const handleMessage = async (message) => {
    console.log(message.content.toString())
    const parsedMessage = JSON.parse(message.content.toString());

    // prefer ipinfo; fall back to the geoip-lite fields the redirect API put in the message
    const geo = await lookupIp(parsedMessage.ip);
    let location;
    if (geo) {
        location = {
            country: geo.country ?? parsedMessage.country,
            region: geo.region,
            city: geo.city,
            latitude: geo.latitude,
            longitude: geo.longitude,
            timezone: geo.timezone,
            postal: geo.postal,
            isp: geo.isp,
            accuracyRadius: null,
            geoSource: 'ipinfo'
        };
    } else {
        const latitude = toFloat(parsedMessage.latitude);
        const city = toStr(parsedMessage.city);
        location = {
            country: parsedMessage.country,
            region: toStr(parsedMessage.region),
            city,
            latitude,
            longitude: toFloat(parsedMessage.longitude),
            timezone: toStr(parsedMessage.timezone),
            postal: null,
            isp: null,
            accuracyRadius: toInt(parsedMessage.accuracyRadius),
            geoSource: city !== null || latitude !== null ? 'geoip-lite' : null
        };
    }

    await prisma.click.create({
        data: {
            linkId: parsedMessage.linkId,
            ip: parsedMessage.ip,
            userAgent: parsedMessage.userAgent,
            referrer: parsedMessage.referrer,
            ...location,
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
