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

const localResourcesDir = path.join(__dirname, "resources");
const chromeDriverPath = path.join(localResourcesDir, "chromedriver");
const chromeHeadlessPath = path.join(localResourcesDir, "headless-chromium");

const filtersPath = path.join("/tmp", "abp-filters.txt");

const writeFilePromise = util.promisify(fs.writeFile);
const readFilePromise = util.promisify(fs.readFile);
const existsPromise = util.promisify(fs.pathExists);
const unlinkPromise = util.promisify(fs.unlink);
const emptyDirPromise = util.promisify(fs.emptyDir);
const rmdirPromise = util.promisify(fs.rmdir);

const possibleTempFiles = [
    filtersPath,
];

const possibleTempDirs = [
    "/tmp/data-path",
    "/tmp/cache-dir",
];

let DEBUG_MESSAGE;

async function cleanTempDir () {
    DEBUG_MESSAGE("Cleaning up...");
    const cleanedDirs = [];
    for (const tempPath of possibleTempFiles) {
        if (await existsPromise(tempPath)) {
            DEBUG_MESSAGE("Removing: " + tempPath);
            await unlinkPromise(tempPath);
            cleanedDirs.push(tempPath);
        }
    }

    for (const tempPath of possibleTempDirs) {
        if (await existsPromise(tempPath)) {
            DEBUG_MESSAGE("Removing: " + tempPath);
            await emptyDirPromise(tempPath);
            await rmdirPromise(tempPath);
            cleanedDirs.push(tempPath);
        }
    }

    return Promise.resolve(cleanedDirs);
}

const dispatch = (event, _) => {
    let promise;
    if (event.Records !== undefined) {
        const args = utils.dynamoRecordsToArgs(event.Records);
        promise = Promise.all(args.map(crawlPromise));
    } else {
        promise = crawlPromise(event);
    }

    return promise
        .then(cleanTempDir)
        .catch(error => {
            console.log(error);
            return cleanTempDir();
        });
};

/**
 * Required arguments:
 *   filtersUrl {string}
 *   batch {uuid string}
 *   domain {string}
 *
 * Optional arguments:
 *   url {?string} (default: http:// + domain)
 *   debug {?boolean} (default: false)
 *   secs {?int} (default: 5)
 *   breath {?int} (default: 0)
 *   depth {?int} (default: 0)
 *   parentCrawlId {?int} (default: null)
 *   tags {?array<string>} (default: null)
 *   rank {?int} (default: null)
 */
async function crawlPromise (args) {
    utils.validateArgs(args);

    const filtersUrl = args.filtersUrl;
    const batch = args.batch;
    const domain = args.domain;

    const url = args.url || `http://${domain}`;
    const debug = args.debug === true;
    const secs = args.secs || 5;
    const depth = args.depth || 1;
    const breath = args.breath || 0;
    const parentCrawlId = args.parentCrawlId || null;
    const tags = args.tags || [];
    const rank = args.rank || null;

    DEBUG_MESSAGE = msg => {
        if (debug === true) {
            console.log("lambda handler: " + JSON.stringify(msg));
        }
    };

    if (parentCrawlId === null) {
        try {
            await rp(url);
        } catch (_) {
            await db.recordUnavailabeDomain(batch, domain, rank, tags);
            DEBUG_MESSAGE(`URL ${url} appears to be unreachable.`);
            return;
        }
    }

    DEBUG_MESSAGE("Fetching filter rules from '" + filtersUrl + "'");
    try {
        const filtersBody = await rp.get(filtersUrl);
        await writeFilePromise(filtersPath, filtersBody, {encoding: "utf8"});
    } catch (e) {
        return Promise.resolve({error: "Invalid filter list at " + filtersUrl});
    }

    const optionalArgs = {
        seconds: secs || 5,
        debug,
        fetchChildLinks: depth > 1,
    };

    const filtersText = await readFilePromise(filtersPath, {encoding: "utf8"});

    DEBUG_MESSAGE("Starting crawl with configuration: ");
    DEBUG_MESSAGE({
        batch,
        url,
        domain,
        filtersTextLen: filtersText.length,
        chromeHeadlessPath,
        chromeDriverPath,
        optionalArgs,
        rank,
        depth,
        breath,
    });
    const [logs, childHrefs] = await crawler.crawlPromise(
        url, filtersText,
        chromeHeadlessPath, chromeDriverPath, optionalArgs
    );

    DEBUG_MESSAGE("Finished crawl, about to record in DB.");
    const crawlId = await db.record(
        batch, domain, url, secs, filtersUrl, filtersText,
        logs, depth, breath, tags, parentCrawlId, rank, debug
    );
    DEBUG_MESSAGE(`Finished recording crawl ${crawlId} in the database, now considering recursive calls.`);

    if (depth > 1 &&
        breath > 0 &&
        childHrefs !== undefined &&
        childHrefs.length > 0) {
        const childUrlsToCrawl = lodash.sampleSize(childHrefs, breath);

        DEBUG_MESSAGE(`Will also crawl children ${JSON.stringify(childUrlsToCrawl)}.`);
        const lambdaClient = new awsSdk.Lambda({apiVersion: "2015-03-31"});
        childUrlsToCrawl.forEach(aUrl => {
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
            DEBUG_MESSAGE(`Calling ${childCallParams.FunctionName} with args ${JSON.stringify(childCallParams)}.`);

            childCallParams.ClientContext = JSON.stringify(childCallParams.ClientContext);
            childCallParams.Payload = JSON.stringify(childCallParams.Payload);

            lambdaClient.invoke(childCallParams, (invokeErr, invokeData) => {
                DEBUG_MESSAGE(invokeErr || invokeData);
            });
        });
    }

    DEBUG_MESSAGE("Finished crawl id: " + crawlId);
    return {
        logs,
        url: url,
        dwellTime: secs,
        filtersUrl: filtersUrl,
        depth,
    };
}

module.exports.dispatch = dispatch;
