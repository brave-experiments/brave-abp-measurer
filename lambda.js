"use strict";

const path = require("path");
const fs = require("fs");
const urlLib = require("url");

const AdmZip = require("adm-zip");
const request = require("sync-request");
const AWS = require("aws-sdk");

const crawler = require("./lib/crawl");

const zippedChromeDriverPath = path.join("/tmp", "chromedriver.zip");
const unzippedChromeDriverPath = path.join("/tmp", "chromedriver");

const zippedChromeHeadlessPath = path.join("/tmp", "stable-headless-chromium-amazonlinux-2017-03.zip");
const unzippedChromeHeadlessPath = path.join("/tmp", "headless-chromium");

const zippedChromePath = path.join("/tmp", "chrome-linux.zip");
const unzippedChromePath = path.join("/tmp", "chrome-linux");

const crawl = (event, context) => {

    const contextArgs = event || {};
    const debug = contextArgs.debug === true;

    const debugMessage = msg => {
        if (debug === true) {
            console.log("lambda handler: " + JSON.stringify(msg));
        }
    };

    if (contextArgs.local === undefined) {
        debugMessage("Fetching chromedriver");
        let chromeDriverRequest = request("GET", "https://chromedriver.storage.googleapis.com/2.37/chromedriver_linux64.zip");
        fs.writeFileSync(zippedChromeDriverPath, chromeDriverRequest.getBody());
        chromeDriverRequest = undefined;

        if (contextArgs.headless === true) {
            debugMessage("Fetching chrome headless");
            let chromeHeadlessRequest = request("GET", "https://github.com/adieuadieu/serverless-chrome/releases/download/v1.0.0-41/stable-headless-chromium-amazonlinux-2017-03.zip")
            fs.writeFileSync(zippedChromeHeadlessPath, chromeHeadlessRequest.getBody());
            chromeHeadlessRequestRequest = undefined;
        } else {
            debugMessage("Fetching chrome");
            let chromeRequest = request("GET", "https://s3.amazonaws.com/com.brave.research.crawls.resources/chrome-linux.zip")
            fs.writeFileSync(zippedChromePath, chromeRequest.getBody());
            chromeRequest = undefined;
        }
    } else {
        debugMessage("Using local resources from '" + contextArgs.local + "'");
        fs.copyFileSync(contextArgs.local + "/chromedriver.zip", zippedChromeDriverPath);

        if (contextArgs.headless === true) {
            fs.copyFileSync(contextArgs.local + "/stable-headless-chromium-amazonlinux-2017-03.zip", zippedChromeHeadlessPath);
        } else {
            fs.copyFileSync(contextArgs.local + "/chrome-linux.zip", zippedChromePath);
        }
    }

    debugMessage("Unzipping chromedriver to " + unzippedChromeDriverPath);
    const chromedriverZip = new AdmZip(zippedChromeDriverPath);
    chromedriverZip.extractAllTo(unzippedChromeDriverPath, true);
    fs.unlinkSync(zippedChromeDriverPath);
    const chromeDriverBinaryPath = path.join(unzippedChromeDriverPath, "chromedriver");
    fs.chmodSync(chromeDriverBinaryPath, 0o777);

    let chromeZip;
    let chromeBinaryPath;
    if (contextArgs.headless === true) {
        debugMessage("Unzipping chrome headless to " + unzippedChromeHeadlessPath);
        chromeZip = new AdmZip(zippedChromeHeadlessPath);
        chromeZip.extractAllTo(unzippedChromeHeadlessPath, true);
        fs.unlinkSync(zippedChromeHeadlessPath);
        chromeBinaryPath = path.join(unzippedChromeHeadlessPath, "headless-chromium");
    } else {
        debugMessage("Unzipping chrome to " + unzippedChromePath);
        chromeZip = new AdmZip(zippedChromePath);
        chromeZip.extractAllTo(unzippedChromePath, true);
        fs.unlinkSync(zippedChromePath);
        chromeBinaryPath = path.join(unzippedChromePath, "chrome-linux", "chrome");
    }

    fs.chmodSync(chromeBinaryPath, 0o777);

    let braveFiltersPath = path.join(__dirname, "resources", "easylist.txt");
    const customFiltersUrl = contextArgs.filters_url;
    if (customFiltersUrl !== undefined) {
        braveFiltersPath = path.join("/tmp", "abp-filters.txt");
        debugMessage("Fetching filter rules from '" + customFiltersUrl + "'");
        let filtersRequest = request("GET", customFiltersUrl);
        fs.writeFileSync(braveFiltersPath, filtersRequest.getBody());
        filtersRequest = undefined;
    }

    const args = {
        url: contextArgs.url,
        filters: braveFiltersPath,
        seconds: contextArgs.secs || 5,
        chromedriver: chromeDriverBinaryPath,
        chromium: chromeBinaryPath,
    };

    const optionalCrawlArgs = {
        seconds: args.seconds,
        debug,
    };

    debugMessage({args, optionalCrawlArgs});

    const hostname = (new urlLib.URL(args.url)).hostname;

    crawler.crawlPromise(args.url, args.filters, args.chromium, args.chromedriver, optionalCrawlArgs)
        .then(logs => {
            const summary = {
                date: Date.now
            };
            fs.writeFileSync("/tmp-output/log.json", JSON.stringify(logs));
        });
};

module.exports.crawl = crawl;
