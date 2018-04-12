"use strict";

const urlLib = require("url");

module.exports.chunkArray = (array, chunkSize) => {
    const chunks = [];
    while (array.length > 0) {
        chunks.push(array.splice(0, chunkSize));
    }
    return chunks;
};

const imageKeyToValue = obj => {
    const [type, value] = Object.entries(obj)[0];

    switch (type) {
        case "N":
            return parseInt(value, 10);
        
        case "B":
            return !!value;

        case "S":
        default:
            return value;
    }
};

module.exports.dynamoRecordsToArgs = records => {
    return records.filter(rec => {
            if (rec.eventName !== "INSERT") {
                return false;
            }

            if (rec.dynamodb === undefined ||
                rec.dynamodb.NewImage === undefined) {
                return false;
            }

            return true;
        })
        .map(rec => {
            return Object.entries(rec.dynamodb.NewImage)
                .reduce((collection, item) => {
                    const [keyName, val] = item;
                    collection[keyName] = imageKeyToValue(val);
                    return collection;
                }, {});
        });
};

module.exports.validateArgs = args => {

    try {
        const filtersUrlParse = new urlLib.URL(args.filtersUrl);
    } catch (e) {
        throw `Expected URL for "filtersUrl" argument, received ${args.filtersUrl}.`;
    }

    try {
        const filtersUrlParse = new urlLib.URL(args.url);
    } catch (e) {
        throw `Expected URL for "url" argument, received ${args.url}.`;
    }

    return true;
};