"use strict";

const path = require("path");
const util = require("util");

const rp = require("request-promise");
const fs = require("fs-extra");
const awsSdk = require("aws-sdk");
// This is a bananas requirement for what we use it for,
// but its already a dependency of another package,
// so we can depend on it for "free".
const lodash = require("lodash");

const crawler = require("./lib/crawl");
const db = require("./lib/db");
const utils = require("./lib/utils");
const debugLib = require("./lib/debug");

const localResourcesDir = path.join(__dirname, "resources");
const chromeDriverPath = path.join(localResourcesDir, "chromedriver");
const chromeHeadlessPath = path.join(localResourcesDir, "headless-chromium");

const existsPromise = util.promisify(fs.pathExists);
const emptyDirPromise = util.promisify(fs.emptyDir);
const rmdirPromise = util.promisify(fs.rmdir);

const possibleTempDirs = [
    "/tmp/data-path",
    "/tmp/cache-dir",
];

async function cleanTempDir () {
    debugLib.log("Cleaning up...");
    const cleanedDirs = [];
    for (const tempPath of possibleTempDirs) {
        if (await existsPromise(tempPath)) {
            debugLib.log("Removing: " + tempPath);
            await emptyDirPromise(tempPath);
            await rmdirPromise(tempPath);
            cleanedDirs.push(tempPath);
        }
    }

    return cleanedDirs;
}

const dispatch = async lambdaEvent => {
    try {
        if (lambdaEvent.Records) {
            // Check to see if we're receiving data from SQS
            for (const args of lambdaEvent.Records) {
                const processedLambdaArgs = JSON.parse(args.body);
                await crawlPromise(processedLambdaArgs);
                await cleanTempDir();
            }
        } else {
            // Otherwise, handle some other invocation style (likely
            // commanding or direct invocation)
            await crawlPromise(lambdaEvent);
            await cleanTempDir();
        }
    } catch (error) {
        console.log(error);
        await cleanTempDir();
    }
};

/**
 * Required arguments:
 *   filtersUrls {array<string>}
 *   batch {uuid string}
 *   domain {string}
 *
 * Optional arguments:
 *   region {?string} (default: null)
 *   url {?string} (default: http:// + domain)
 *   secs {?int} (default: 5)
 *   breath {?int} (default: 0)
 *   depth {?int} (default: 0)
 *   parentCrawlId {?int} (default: null)
 *   tags {?array<string>} (default: null)
 *   rank {?int} (default: null)
 */
async function crawlPromise (args) {
    const filtersUrls = args.filtersUrls;
    const batch = args.batch;
    const domain = args.domain;

    const url = args.url || `http://${domain}`;
    const secs = args.secs || 5;
    const depth = args.depth || 1;
    const breath = args.breath || 0;
    const parentCrawlId = args.parentCrawlId || null;
    const tags = args.tags || [];
    const rank = args.rank || null;
    const region = args.region || null;

    debugLib.log(args);
    utils.validateArgs(args);

    if (parentCrawlId === null) {
        try {
            await rp({
                url: url,
                timeout: 10000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.53 Safari/537.36",
                },
            });
        } catch (_) {
            debugLib.log(`URL ${url} appears to be unreachable.`);
            await db.recordUnavailableDomain(batch, domain, rank, tags, region);
            return;
        }
    }

    const filterUrlToTextMap = Object.create(null);
    debugLib.log("Found " + filtersUrls.length + " urls of filter rules to download.");
    for (const aFilterUrl of filtersUrls) {
        debugLib.log("Fetching filter rules from '" + aFilterUrl + "'");
        try {
            const fetchedFilterText = await rp.get(aFilterUrl);
            filterUrlToTextMap[aFilterUrl] = fetchedFilterText;
        } catch (e) {
            return Promise.resolve({error: "Invalid filter list at " + aFilterUrl});
        }
    }

    const shouldFetchChildLinks = depth > 1;
    const [logs, childHrefs] = await crawler.crawlPromise(
        url, filterUrlToTextMap, chromeHeadlessPath, chromeDriverPath,
        secs, shouldFetchChildLinks
    );

    debugLib.log("Finished crawl, about to record in DB.");
    const crawlId = await db.record(
        batch, domain, url, secs, filterUrlToTextMap,
        logs, depth, breath, tags, parentCrawlId, rank, region
    );
    debugLib.log(`Finished recording crawl ${crawlId} in the database, now considering recursive calls.`);

    if (depth > 1 &&
        breath > 0 &&
        childHrefs !== undefined &&
        childHrefs.length > 0) {
        const childUrlsToCrawl = lodash.sampleSize(childHrefs, breath);

        debugLib.log(`Will also crawl children ${JSON.stringify(childUrlsToCrawl)}.`);
        const lambdaClient = new awsSdk.Lambda({apiVersion: "2015-03-31"});
        for (const aUrl of childUrlsToCrawl) {
            const childArgs = Object.assign({}, args);
            childArgs.url = aUrl;
            childArgs.depth -= 1;
            childArgs.parentCrawlId = crawlId;

            const childCallParams = {
                ClientContext: {
                    url: url,
                    depth,
                    breath,
                },
                FunctionName: "brave-abp-measurer",
                InvocationType: "Event",
                Payload: childArgs,
            };
            debugLib.log(`Calling ${childCallParams.FunctionName} with args ${JSON.stringify(childCallParams)}.`);

            childCallParams.ClientContext = JSON.stringify(childCallParams.ClientContext);
            childCallParams.Payload = JSON.stringify(childCallParams.Payload);

            await lambdaClient.invoke(childCallParams).promise();
        }
    }

    debugLib.log("Finished crawl id: " + crawlId);
    return {
        logs,
        url: url,
        dwellTime: secs,
        filterUrlToTextMap,
        depth,
    };
}

module.exports.dispatch = dispatch;
