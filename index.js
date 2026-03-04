require('newrelic');
const {startConsumer} = require('./consumer/analytics.consumer');
const start = async()=>{
    try{
        await startConsumer();
    }
    catch(error){
        console.error("Failed to start consumer:", error.message);   
    }
}
start();