"use strict";

const path = require("path");
const util = require("util");
const urlLib = require("url");

const chrome = require("selenium-webdriver/chrome");
const logging = require("selenium-webdriver/lib/logging");
const webdriver = require("selenium-webdriver");
const {Capabilities} = webdriver;

const logsLib = require("./logs");
const consts = require("./consts");

let debugMessage;

async function crawlPromise (url, filterListText, chromePath, chromeDriverPath, optionalArgs) {
    debugMessage = msg => {
        if (optionalArgs.debug === true) {
            console.log("crawl: " + msg);
        }
    };
    const dwellTime = optionalArgs.seconds || 5;

    let driver;

    try {
        logging.installConsoleHandler();

        debugMessage("Using chrome driver binary: " + chromeDriverPath);
        const service = new chrome.ServiceBuilder(chromeDriverPath)
            .build();

        const loggingPrefs = new webdriver.logging.Preferences();
        loggingPrefs.setLevel(webdriver.logging.Type.PERFORMANCE, webdriver.logging.Level.ALL);

        debugMessage("Using chrome binary: " + chromePath);
        const chromeOptions = new chrome.Options()
            .addArguments([
                'homedir=/tmp',
                'data-path=/tmp/data-path',
                'disk-cache-dir=/tmp/cache-dir',
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
        await driver.sleep(3 * 1000);

        debugMessage("fetching " + url);
        await driver.get(url);

        await driver.sleep(dwellTime * 1000);
        await collectLogsPromise();

        debugMessage("Closing driver connection.");
        driver.quit();

        debugMessage("Removing console handler.");
        logging.removeConsoleHandler();

        const processedLogs = logsLib.filterUrlsWithABP(collectedRequests, filterListText);
        return processedLogs;

    } catch (e) {

        debugMessage("! Error, attempting to clean up.");

        if (driver !== undefined) {
            try {
                driver.quit();
                debugMessage("! Successfully cleaned up driver connection");
            } catch (error) {
                debugMessage("! Tried to cleaned up driver connection, but received error");
                debugMessage(error);
            }
        }

        try {
            logging.removeConsoleHandler();
            debugMessage("! Successfully cleaned up console handler");
        } catch (error) {
            debugMessage("! Tried to cleaned up console handler, but received error");
            debugMessage(error);
        }

        throw e;
    }
};

module.exports.crawlPromise = crawlPromise;
