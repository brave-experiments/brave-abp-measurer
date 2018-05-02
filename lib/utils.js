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
    // Make sure that if metadata has been specified, its JSON-able
    if (args.tags !== undefined) {
        if (Array.isArray(args.tags) === false) {
            throw "tags argument, if provided, must be an array of strings.";
        }
        const isAllStrings = args.tags.every(tag => typeof tag === "string");
        if (isAllStrings !== true) {
            throw "tags argument, if provided, must be an array of strings.";
        }
    }

    const optionalInts = ["parentCrawlId", "depth", "breath"];
    optionalInts.forEach(optionalInt => {
        const currentValue = args[optionalInt];
        if (currentValue === undefined) {
            return;
        }
        if (Number.isInteger(currentValue) === true) {
            return;
        }
        throw `Expected integer for "${optionalInt}" argument, received ${currentValue}.`;
    });

    if (Array.isArray(args.filtersUrls) === false) {
        throw `Expected an array for "filtersUrls" argument, received ${args.filtersUrls}.`;
    }

    if (args.filtersUrls.length === 0) {
        throw `Expected at least one url in the for "filtersUrls" argument, received empty array.`;
    }

    for (const aUrl of args.filtersUrls) {
        if (typeof aUrl !== "string") {
            throw `Expected only strings in "filtersUrls", received ${aUrl}`;
        }

        try {
            new urlLib.URL(aUrl);
        } catch (_) {
            throw `Expected valid URL stringfs in "filtersUrls" argument, received ${aUrl}.`;
        }
    }

    if (typeof args.batch !== "string") {
        throw `Expected uuid string for "batch" argument, received ${args.batch}.`;
    }

    if (args.domain === undefined || args.domain.indexOf(".") === -1) {
        throw `Expected domain for "domain" argument, received ${args.domain}.`;
    }

    return true;
};
