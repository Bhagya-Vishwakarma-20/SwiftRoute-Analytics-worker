require('newrelic');
const { startConsumer } = require('./consumer/analytics.consumer');
const { startServer, stopServer } = require('./server');
const { closeRabbitmq } = require('./lib/rabbitmq');
const { prisma } = require('./lib/primaClient');

const start = async()=>{
    startServer();
    try{
        await startConsumer();
    }
    catch(error){
        console.error("Failed to start consumer:", error.message);   
    }
}

const shutdown = async (signal) => {
    console.log(`${signal} received. Shutting down...`);
    await stopServer().catch(() => {});
    await closeRabbitmq();
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
