"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");
const urlLib = require("url");

const chrome = require("selenium-webdriver/chrome");
const logging = require("selenium-webdriver/lib/logging");
const webdriver = require("selenium-webdriver");
const {Capabilities} = webdriver;

const logsLib = require("./logs");
const consts = require("./consts");

const crawlPromise = (url, filterListPath, chromePath, chromeDriverPath, optionalArgs) => {

    const debugMessage = msg => {
        if (optionalArgs.debug === true) {
            console.log("crawl: " + msg);
        }
    };

    const dwellTime = optionalArgs.seconds || 5;

    logging.installConsoleHandler();

    debugMessage("Using chrome driver binary: " + chromeDriverPath);
    const service = new chrome.ServiceBuilder(chromeDriverPath)
        .enableVerboseLogging()
        .build();

    const loggingPrefs = new webdriver.logging.Preferences();
    loggingPrefs.setLevel(webdriver.logging.Type.PERFORMANCE, webdriver.logging.Level.ALL);

    debugMessage("Using chrome binary: " + chromePath);
    const chromeOptions = new chrome.Options()
        .addArguments([
            "disable-gpu",
            "no-sandbox",
        ])
        .windowSize({height: consts.browserHeight, width: consts.browserWidth})
        .setChromeBinaryPath(chromePath)
        .setLoggingPrefs(loggingPrefs)
        .setPerfLoggingPrefs({
             enableNetwork: true,
        });

    const driver = chrome.Driver.createSession(chromeOptions, service)
    const logs = driver.manage().logs();

    let collectedRequests = [];
    const collectLogsPromise = _ => {
        return logs.get("performance")
            .then(entries => {
                debugMessage(`Collected ${entries.length} performance log entries.`);
                collectedRequests = collectedRequests.concat(logsLib.urlsFromLogs(entries));
                return Promise.resolve();
            });
    };

    debugMessage("opening browser");
    return driver.sleep(3 * 1000)
        .then(_ => {
            debugMessage("fetching " + url);
            return driver.get(url);
        })
        .then(_ => driver.sleep(dwellTime * 1000))
        .then(_ => collectLogsPromise())
        .then(_ => {
            driver.quit();
            const easyListRules = fs.readFileSync(filterListPath, {encoding: "utf8"});
            return Promise.resolve(logsLib.filterUrlsWithABP(collectedRequests, easyListRules));
        });
};

module.exports.crawlPromise = crawlPromise;
