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
const debugLib = require("./debug");

async function hashForRequest (driver, logsHandle, requestId) {
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
    debugLib.log(`Collected ${entries.length} performance log entries.`);
    return logsLib.urlsFromLogs(entries);
}


async function crawlPromise (
    url, filterUrlToTextMap, chromePath, chromeDriverPath, dwellTime,
    fetchChildLinks = false
) {
    let driver;
    try {
        logging.installConsoleHandler();

        debugLib.log("Using chrome driver binary: " + chromeDriverPath);
        const service = new chrome.ServiceBuilder(chromeDriverPath)
            .build();

        const loggingPrefs = new webdriver.logging.Preferences();
        loggingPrefs.setLevel(webdriver.logging.Type.PERFORMANCE, webdriver.logging.Level.ALL);

        debugLib.log("Using chrome binary: " + chromePath);
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
        await driver.manage().setTimeouts({
            pageLoad: 45000,
        });

        await patchLib.patchDriver(driver);
        const logsHandle = driver.manage().logs();

        debugLib.log("opening browser");
        await driver.sleep(3 * 1000);

        debugLib.log("fetching " + url);
        await driver.get(url);

        let hrefs;
        if (fetchChildLinks === true) {
            debugLib.log("Fetching anchor elements on the page");
            const anchorElements = await driver.findElements(By.css("a"));
            const anchorHrefs = new Set();
            for (const anchor of anchorElements) {
                try {
                    anchorHrefs.add(await anchor.getAttribute("href"));
                } catch (_) {
                    debugLib.log("Caught stale reference error, but chugging on.");
                }
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
            debugLib.log(`Found ${hrefs.length} unique a[href]'s.`);
        }

        await driver.sleep(dwellTime * 1000);
        const collectedRequests = await collectLogs(logsHandle);
        debugLib.log(`Found ${collectedRequests.length} requests to fetch info for.`);
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
                // debugLib.log(`Error requesting resource for id ${recordRequestId}`);
            }
        }

        debugLib.log("Closing driver connection.");
        driver.quit();

        debugLib.log("Removing console handler.");
        logging.removeConsoleHandler();

        const processedLogs = logsLib.filterUrlsWithABP(collectedRequests, filterUrlToTextMap);
        return [processedLogs, hrefs];
    } catch (e) {
        debugLib.log("! Error, attempting to clean up.");
        debugLib.log(e);
        if (driver !== undefined) {
            try {
                driver.quit();
                debugLib.log("! Successfully cleaned up driver connection");
            } catch (error) {
                debugLib.log("! Tried to cleaned up driver connection, but received error");
                debugLib.log(error);
            }
        }

        try {
            logging.removeConsoleHandler();
            debugLib.log("! Successfully cleaned up console handler");
        } catch (error) {
            debugLib.log("! Tried to cleaned up console handler, but received error");
            debugLib.log(error);
        }
        throw e;
    }
}

module.exports.crawlPromise = crawlPromise;
