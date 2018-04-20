"use strict";

const urlLib = require("url");
const crypto = require("crypto");

const chrome = require("selenium-webdriver/chrome");
const logging = require("selenium-webdriver/lib/logging");
const command = require("selenium-webdriver/lib/command");
const webdriver = require("selenium-webdriver");
const {By} = webdriver;

const logsLib = require("./logs");
const consts = require("./consts");
const patchLib = require("./patch");

let DEBUG_MESSAGE;

async function hashForRequest (driver, logsHandle, requestId) {
    DEBUG_MESSAGE(`Requesting resource with id ${requestId}.`);
    const response = await driver.execute(new command.Command("sendDevToolsCommandAndGetResult")
        .setParameter("cmd", "Network.getResponseBody")
        .setParameter("params", {requestId}));

    const bufferToHash = response.base64Encoded
        ? new Buffer(response.body, "base64")
        : new Buffer(response.body);
    const hashHex = crypto.createHash("sha256").update(bufferToHash).digest("hex");
    const resourceLen = bufferToHash.length;
    return [hashHex, resourceLen];
}


async function collectLogs (logsHandle) {
    const entries = await logsHandle.get("performance");
    DEBUG_MESSAGE(`Collected ${entries.length} performance log entries.`);
    return logsLib.urlsFromLogs(entries);
}


async function crawlPromise (url, filtersText, chromePath, chromeDriverPath, additionalArgs) {
    DEBUG_MESSAGE = msg => {
        if (additionalArgs.debug === true) {
            console.log("crawl: " + msg);
        }
    };
    const dwellTime = additionalArgs.seconds || 5;
    const fetchChildLinks = additionalArgs.fetchChildLinks;

    let driver;

    try {
        logging.installConsoleHandler();

        DEBUG_MESSAGE("Using chrome driver binary: " + chromeDriverPath);
        const service = new chrome.ServiceBuilder(chromeDriverPath)
            .build();

        const loggingPrefs = new webdriver.logging.Preferences();
        loggingPrefs.setLevel(webdriver.logging.Type.PERFORMANCE, webdriver.logging.Level.ALL);

        DEBUG_MESSAGE("Using chrome binary: " + chromePath);
        const chromeOptions = new chrome.Options()
            .addArguments([
                "homedir=/tmp",
                "data-path=/tmp/data-path",
                "disk-cache-dir=/tmp/cache-dir",
                "disable-gpu",
                "no-sandbox",
                "single-process",
                "ignore-certificate-errors",
                "no-zygote",
                "enable-logging",
                "log-level=0",
                "v=99",
            ])
            .windowSize({height: consts.browserHeight, width: consts.browserWidth})
            .setChromeBinaryPath(chromePath)
            .setLoggingPrefs(loggingPrefs)
            .setPerfLoggingPrefs({
                enableNetwork: true,
            });

        driver = chrome.Driver.createSession(chromeOptions, service);
        await patchLib.patchDriver(driver);
        const logsHandle = driver.manage().logs();

        DEBUG_MESSAGE("opening browser");
        await driver.sleep(3 * 1000);

        DEBUG_MESSAGE("fetching " + url);
        await driver.get(url);

        let hrefs;
        if (fetchChildLinks === true) {
            DEBUG_MESSAGE("Fetching anchor elements on the page");
            const anchorElements = await driver.findElements(By.css("a"));
            const anchorHrefs = new Set();
            for (const anchor of anchorElements) {
                anchorHrefs.add(await anchor.getAttribute("href"));
            }
            const currentUrl = await driver.getCurrentUrl();
            const currentHost = (new urlLib.URL(currentUrl)).hostname;
            hrefs = Array.from(anchorHrefs).filter(href => {
                try {
                    const anchorHost = (new urlLib.URL(href, currentUrl)).hostname;
                    return anchorHost === currentHost;
                } catch (_) {
                    return false;
                }
            });
            DEBUG_MESSAGE(`Found ${hrefs.length} unique a[href]'s.`);
        }

        await driver.sleep(dwellTime * 1000);
        const collectedRequests = await collectLogs(logsHandle);
        for (const recordEntry of collectedRequests) {
            const recordRequestId = recordEntry.requestId;
            try {
                const [requestHash, requestLen] = await hashForRequest(
                    driver,
                    logsHandle, recordRequestId
                );
                recordEntry.hash = requestHash;
                recordEntry.size = requestLen;
            } catch (e) {
                DEBUG_MESSAGE(e);
            }
        }

        DEBUG_MESSAGE("Closing driver connection.");
        driver.quit();

        DEBUG_MESSAGE("Removing console handler.");
        logging.removeConsoleHandler();

        const processedLogs = logsLib.filterUrlsWithABP(collectedRequests, filtersText);
        return [processedLogs, hrefs];
    } catch (e) {
        DEBUG_MESSAGE("! Error, attempting to clean up.");
        DEBUG_MESSAGE(e);
        if (driver !== undefined) {
            try {
                driver.quit();
                DEBUG_MESSAGE("! Successfully cleaned up driver connection");
            } catch (error) {
                DEBUG_MESSAGE("! Tried to cleaned up driver connection, but received error");
                DEBUG_MESSAGE(error);
            }
        }

        try {
            logging.removeConsoleHandler();
            DEBUG_MESSAGE("! Successfully cleaned up console handler");
        } catch (error) {
            DEBUG_MESSAGE("! Tried to cleaned up console handler, but received error");
            DEBUG_MESSAGE(error);
        }
        throw e;
    }
}

module.exports.crawlPromise = crawlPromise;
