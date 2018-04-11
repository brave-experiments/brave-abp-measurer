module.exports = {
    serializeScript: "let x = new XMLSerializer(); return x.serializeToString(document);",
    scrollBottomScript: "window.scrollTo(0, document.body.scrollHeight);",
    scrollTopScript: "window.scrollTo(0, 0);",
    browserWidth: 1080,
    // browserHeight: ((1920 * 5) + 200),
    browserHeight: (1920 * 2),
    queryElmsScript: `
        const filter = arguments[0];
    `,
};