"use strict";

const fs = require("fs");
const url = require("url");

const abp = require("ad-block");
const {AdBlockClient, FilterOptions} = abp;

const extractFetchedUrls = logEntries => {
    return logEntries.filter(entry => {
            if (typeof entry.message !== "object" ||
                entry.message.message === undefined ||
                entry.message.message.method !== "Network.requestWillBeSent") {
                return false;
            }

            if (entry.message.message.params.documentURL === undefined) {
                return false;
            }

            return true;
        })
        .map(entry => {
            const msg = entry.message.message;
            return {
                from: msg.params.documentURL,
                for: msg.params.request.url,
                type: msg.params.type,
                initiator: {
                    type: msg.params.initiator.type,
                    url: msg.params.initiator.url,
                },
            };
        });
};


const deserializeEntries = entries => {
    return entries.map(entry => {
        try {
            entry.message = JSON.parse(entry.message);
        } catch (e) {
            console.error(e);
        }
        return entry;
    });
};


const urlsFromLogs = entries => {
    return extractFetchedUrls(deserializeEntries(entries));
};

const devToolsTypeToABPType = devToolsType => {
    switch (devToolsType) {
        case "Document":
            return FilterOptions.subdocument | FilterOptions.document;

        case "Image":
            return FilterOptions.image;

        case "Font":
            return FilterOptions.other;

        case "Script":
            return FilterOptions.script;

        case "Stylesheet":
            return FilterOptions.stylesheet;

        case "XHR":
            return FilterOptions.xmlHttpRequest;

        default:
            return FilterOptions.other | FilterOptions.object | FilterOptions.objectSubrequest;
    }
};

const filterUrlsWithABP = (parsedLogEntries, easyListRules) => {
    const ignoredLeadingChars = ["\n", " ", "!", "[", "\r", "\t"];

    const filteredRules = easyListRules
        .split("\n")
        .filter(r => {
            if (r.trim().length === 0 ||
                ignoredLeadingChars.includes(r[0])) {
                return false;
            }
            return true;
        })
        .join("\n");

    const filterData = {}
    const client = new AdBlockClient();
    client.parse(filteredRules);

    return parsedLogEntries.reduce((collection, entry) => {
        let baseDomain;
        try {
            baseDomain = (new url.URL(entry.from)).hostname;
        } catch (_) {
            baseDomain = null;
        }

        const urlToCheck = entry.for;
        const requestType = devToolsTypeToABPType(entry.type);

        const matchQuery = client.findMatchingFilters(urlToCheck, requestType, baseDomain);

        if (matchQuery.matches === false) {
            if (matchQuery.matchingExceptionFilter !== undefined) {
                collection.whitelisted.push({
                    filter: matchQuery.matchingOrigRule,
                    exceptionFilter: matchQuery.matchingExceptionOrigRule,
                    entry,
                });
            } else {
                collection.allowed.push(entry);
            }
        } else {
            collection.blocked.push({
                filter: matchQuery.matchingOrigRule,
                entry,
            });
        }
        return collection;
    }, {blocked: [], allowed: [], whitelisted: []});
}


module.exports.extractFetchedUrls = extractFetchedUrls;
module.exports.deserializeEntries = deserializeEntries;
module.exports.urlsFromLogs = urlsFromLogs;
module.exports.filterUrlsWithABP = filterUrlsWithABP;
