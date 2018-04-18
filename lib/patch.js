async function patchDriver (driver) {
    const executor = await driver.getExecutor();
    executor.defineCommand(
        "sendDevToolsCommandAndGetResult",
        "POST",
        "/session/:sessionId/chromium/send_command_and_get_result"
    );
}

module.exports.patchDriver = patchDriver;
