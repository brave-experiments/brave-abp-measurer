"use strict";

const path = require("path");
const util = require("util");

const AdmZip = require("adm-zip");
const rp = require("request-promise");
const fs = require("fs-extra");

const crawler = require("./lib/crawl");
const db = require("./lib/db");
const utils = require("./lib/utils");

const chromeUrl = "https://s3.amazonaws.com/com.brave.research.crawls.resources/chrome-linux.zip";
const chromeDriverUrl = "https://chromedriver.storage.googleapis.com/2.37/chromedriver_linux64.zip";
const chromeHeadlessUrl = "https://github.com/adieuadieu/serverless-chrome/releases/download/v1.0.0-38/stable-headless-chromium-amazonlinux-2017-03.zip";

const zippedChromeDriverPath = path.join("/tmp", "chromedriver.zip");
const unzippedChromeDriverPath = path.join("/tmp", "chromedriver");
const chromeDriverBinaryPath = path.join(unzippedChromeDriverPath, "chromedriver");

const zippedChromeHeadlessPath = path.join("/tmp", "stable-headless-chromium-amazonlinux-2017-03.zip");
const unzippedChromeHeadlessPath = path.join("/tmp", "headless-chromium");
const chromeHeadlessBinaryPath = path.join(unzippedChromeHeadlessPath, "headless-chromium");

const braveFiltersPath = path.join("/tmp", "abp-filters.txt");

const writeFilePromise = util.promisify(fs.writeFile);
const readFilePromise = util.promisify(fs.readFile);
const existsPromise = util.promisify(fs.pathExists);
const statPromise = util.promisify(fs.stat);
const unlinkPromise = util.promisify(fs.unlink);
const emptyDirPromise = util.promisify(fs.emptyDir);
const chmodPromise = util.promisify(fs.chmod);
const rmdirPromise = util.promisify(fs.rmdir);

const possibleTempFiles = [
    zippedChromeDriverPath,
    chromeDriverBinaryPath,
    zippedChromeHeadlessPath,
    chromeHeadlessBinaryPath,
    braveFiltersPath,
];

const possibleTempDirs = [
    unzippedChromeHeadlessPath,
    unzippedChromeDriverPath,
    "/tmp/data-path",
    "/tmp/cache-dir",
];

let debugMessage;

async function cleanTempDir () {

    debugMessage("Cleaning up...");

    const cleanedDirs = [];

    for (let tempPath of possibleTempFiles) {
        if (await existsPromise(tempPath)) {
            debugMessage("Removing: " + tempPath);
            await unlinkPromise(tempPath);
            cleanedDirs.push(tempPath);
        }
    }

    for (let tempPath of possibleTempDirs) {
        if (await existsPromise(tempPath)) {
            debugMessage("Removing: " + tempPath);
            await emptyDirPromise(tempPath);
            await rmdirPromise(tempPath);
            cleanedDirs.push(tempPath);
        }
    }

    return Promise.resolve(cleanedDirs);
};

const dispatch = (event, context) => {
    let promise;
    if (event.Records !== undefined) {
        const args = utils.dynamoRecordsToArgs(event.Records);
        promise = Promise.all(args.map(crawlPromise))
    } else {
        promise = crawlPromise(event);
    }

    promise.then(cleanTempDir).catch(cleanTempDir);
};

/**
 * Required arguments:
 *   url {string}
 *
 * Optional arguments:
 *   debug {boolean} (default: false)
 *   filtersUrl {string}
 *   secs {int} (default: 5)
 *
 * Either local must be a string, or filtersUrl must be an string
 */
async function crawlPromise (args) {

    const debug = args.debug === true;
    const headless = args.headless === undefined ? true : args.headless;
    const secs = args.secs || 5;

    debugMessage = msg => {
        if (debug === true) {
            console.log("lambda handler: " + JSON.stringify(msg));
        }
    };

    debugMessage("Downloading chromedriver from: " + chromeDriverUrl);
    if (await existsPromise(zippedChromeDriverPath) !== true) {
        let zippedChromeDriverBody = await rp({url: chromeDriverUrl, encoding: null, method: "GET"});
        await writeFilePromise(zippedChromeDriverPath, zippedChromeDriverBody);
        zippedChromeDriverBody = undefined;
    }

    debugMessage("Downloading chrome-headless from: " + chromeHeadlessUrl);
    if (await existsPromise(zippedChromeHeadlessPath) !== true) {
        let zippedChromeHeadlessBody = await rp({url: chromeHeadlessUrl, encoding: null, method: "GET"});
        await writeFilePromise(zippedChromeHeadlessPath, zippedChromeHeadlessBody);
        zippedChromeHeadlessBody = undefined;
    }

    debugMessage("Unzipping chromedriver to " + unzippedChromeDriverPath);
    if (await existsPromise(chromeDriverBinaryPath) !== true) {
        const chromedriverZip = new AdmZip(zippedChromeDriverPath);
        chromedriverZip.extractAllTo(unzippedChromeDriverPath, true);
        await unlinkPromise(zippedChromeDriverPath);
    }
    await chmodPromise(chromeDriverBinaryPath, 0o777);

    debugMessage("Unzipping chrome headless to " + unzippedChromeHeadlessPath);
    if (await existsPromise(chromeHeadlessBinaryPath) === false) {
        const chromeZip = new AdmZip(zippedChromeHeadlessPath);
        chromeZip.extractAllTo(unzippedChromeHeadlessPath, true);
        await unlinkPromise(zippedChromeHeadlessPath);
    }
    await chmodPromise(chromeHeadlessBinaryPath, 0o777);

    debugMessage("Fetching filter rules from '" + args.filtersUrl + "'");
    try {
        const filtersBody = await rp.get(args.filtersUrl);
        await writeFilePromise(braveFiltersPath, filtersBody, {encoding: "utf8"});
    } catch (e) {
        return Promise.resolve({error: "Invalid filter list at " + args.filtersUrl});
    }

    const optionalArgs = {
        seconds: secs || 5,
        debug,
    };

    const braveFiltersText = await readFilePromise(braveFiltersPath, {encoding: "utf8"});
    
    debugMessage("Starting crawl with configuration: ");
    debugMessage({
        url: args.url,
        filtersTextLen: braveFiltersText.length,
        chromeHeadlessBinaryPath,
        chromeDriverBinaryPath,
        optionalArgs,
    });
    const logs = await crawler.crawlPromise(args.url, braveFiltersText, chromeHeadlessBinaryPath, chromeDriverBinaryPath, optionalArgs);

    debugMessage("Finished crawl, about to record in DB.");
    const crawlId = await db.record(args.url, secs, args.filtersUrl, braveFiltersText, logs, debug);

    debugMessage("Finished recording crawl id: " + crawlId);
    return {
        logs,
        url: args.url,
        dwellTime: secs,
        filtersUrl: args.filtersUrl,
    };
};

module.exports.dispatch = dispatch;
