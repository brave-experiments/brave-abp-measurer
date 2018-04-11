"use strict";

const lambdaHandler = require("./lambda");

const args = JSON.parse(process.argv[2]);
lambdaHandler.crawl(args);
