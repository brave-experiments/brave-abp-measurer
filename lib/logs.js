"use strict";

const url = require("url");

const abp = require("ad-block");
const {AdBlockClient, FilterOptions} = abp;

const extractFetchedUrls = logEntries => {
    const networkRequestLogs = logEntries.filter(entry => {
        if (typeof entry.message !== "object" ||
            entry.message.message === undefined ||
            entry.message.message.method !== "Network.requestWillBeSent") {
            return false;
        }

        if (entry.message.message.params.documentURL === undefined) {
            return false;
        }

        return true;
    });

    return networkRequestLogs.map(entry => {
        const msg = entry.message.message;
        return {
            timestamp: msg.params.timestamp,
            requestId: msg.params.requestId,
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


const parseAbpRuleText = easyListText => {
    const ignoredLeadingChars = ["\n", " ", "!", "[", "\r", "\t"];
    return easyListText
        .split("\n")
        .map(l => l.trim())
        .filter(r => {
            const trimmedRule = r.trim();
            if (trimmedRule.length === 0) {
                return false;
            }
            // Ignore AdGuard's javascript rules
            const possiblePrefix = trimmedRule.slice(0, 4);
            if (possiblePrefix.indexOf("#%#") === 0 ||
                possiblePrefix.indexOf("#@%#") === 0) {
                return false;
            }
            if (ignoredLeadingChars.includes(r[0])) {
                return false;
            }
            return true;
        });
};


/**
 * Collection is an object with three keys, "allowed", "blocked" and "exceptions",
 * describing whether the URL request would have been allowed by the
 * given urls, blocked by the rules, or blocked and then allowed b/c
 * of an exception rule.
 */
const addLogEntryToCollection = (abpClient, collection, logEntry) => {
    let baseDomain;
    try {
        baseDomain = (new url.URL(logEntry.from)).hostname;
    } catch (_) {
        baseDomain = null;
    }

    const urlToCheck = logEntry.for;
    const requestType = devToolsTypeToABPType(logEntry.type);

    const matchQuery = abpClient.findMatchingFilters(urlToCheck, requestType, baseDomain);

    if (matchQuery.matches === false) {
        if (matchQuery.matchingExceptionFilter !== undefined) {
            collection.exceptions.push({
                filter: matchQuery.matchingOrigRule,
                exceptionFilter: matchQuery.matchingExceptionOrigRule,
                entry: logEntry,
            });
        } else {
            collection.allowed.push(logEntry);
        }
    } else {
        collection.blocked.push({
            filter: matchQuery.matchingOrigRule,
            entry: logEntry,
        });
    }
    return collection;
};


const filterUrlsWithABP = (parsedLogEntries, filterUrlsToTextMap) => {
    const combinedFilterRules = Object.values(filterUrlsToTextMap).join("\n").trim();
    const filteredRules = parseAbpRuleText(combinedFilterRules);

    const client = new AdBlockClient();
    client.parse(filteredRules.join("\n"));

    const reduceRule = addLogEntryToCollection.bind(undefined, client);
    const logCollection = {blocked: [], allowed: [], exceptions: []};
    return parsedLogEntries.reduce(reduceRule, logCollection);
};


module.exports = {
    extractFetchedUrls,
    deserializeEntries,
    urlsFromLogs,
    filterUrlsWithABP,
    parseAbpRuleText,
};
