"use strict";
require("dotenv/config");
exports.config = {
  app_name: ["Analytics-worker"],
  license_key: process.env.NEWRELIC_LICENSE,
};