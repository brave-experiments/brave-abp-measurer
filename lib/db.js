"use strict";

const crypto = require("crypto");
const urlLib = require("url");

const pg = require("pg");

const logs = require("./logs");
const utils = require("./utils");
const config = require("../config");

let debugMessage;

// Returns the primary key for the created crawl record.
async function record (url, dwellTime, filterListUrl, filterListText, records, debug = false, parentCrawlId = null, metadata = null) {

    debugMessage = msg => {
        if (debug === true) {
            console.log("db: " + msg);
        }
    };

    const client = new pg.Client({
        user: config.pg.username,
        host: config.pg.host,
        database: 'abp_crawls',
        password: config.pg.password,
        port: config.pg.port,
    });
    client.connect();

    debugMessage("Connected to database");
    await client.query('BEGIN');
    const allRulesToIds = await idsForRulesInFilterList(client, filterListUrl, filterListText);
    const siteId = await idForSite(client, url);

    const crawlId = await idForCrawl(client, siteId, dwellTime, url, parentCrawlId, metadata);
    if (records.blocked.length > 0) {
        await recordBlocks(client, crawlId, allRulesToIds, records.blocked);
    }
    if (records.exceptions.length > 0) {
        await recordBlocks(client, crawlId, allRulesToIds, records.exceptions);
    }
    await client.query('COMMIT');

    await client.end();
    return crawlId;
};


async function idsForChunkOfRules (client, listId, rules) {
    const insertParams = [];
    const insertTerms = [];

    debugMessage("About to record " + rules.length + " filter rules for this list");
    let index = 0
    rules.forEach(rule => {
        const isCSSRule = rule.indexOf("##") !== -1;
        const isExceptionRule = rule.indexOf("@@") === 0;
        insertParams.push(rule);
        insertParams.push(isCSSRule);
        insertParams.push(isExceptionRule);
        insertParams.push(crypto.createHash("sha256").update(rule).digest("hex"));

        let offset = 4 * index;
        insertTerms.push("(CAST($" + (++offset) + " AS text), CAST($" + (++offset) + " AS boolean), CAST($" + (++offset) + " AS boolean), CAST($" + (++offset) + " AS text))");
        index += 1;
    });

    const insertQuery = `
        WITH input_rows(text, is_style_rule, is_exception, text_hash) AS (
            VALUES
                ${insertTerms.join(",")}    
        )
        , ins AS (
            INSERT INTO rules (text, is_style_rule, is_exception, text_hash) 
            SELECT * FROM input_rows
            ON CONFLICT (text_hash) DO NOTHING
            RETURNING id
            )
        SELECT 'i' AS source
            , id
        FROM   ins
        UNION  ALL
        SELECT 's' AS source
            , r.id
        FROM   input_rows
        JOIN   rules r USING (text_hash);
    `;

    const insertRs = await client.query(insertQuery, insertParams);

    const ruleToIdMapping = {};
    let rowIndex = 0;
    for (let row of insertRs.rows) {
        const id = row.id;
        const rule = rules[rowIndex];
        ruleToIdMapping[rule] = id;
        rowIndex += 1;
    }

    const joinQueryValues = Object.values(ruleToIdMapping).map(ruleId => {
        return `(${listId}, ${ruleId})`;
    });

    const insertJoinQuery = "INSERT INTO lists_rules(list_id, rule_id) VALUES " + joinQueryValues.join(",") + " ON CONFLICT (list_id, rule_id) DO NOTHING;";
    await client.query(insertJoinQuery, []);
    return ruleToIdMapping;
};


async function idsForRulesInSeenList (client, listId) {
    const selectQuery = `
        SELECT
            r.text,
            r.id
        FROM
            lists_rules AS lr
        JOIN
            rules AS r ON (lr.rule_id = r.id)
        WHERE
            lr.list_id = $1;
    `;

    const rulesToIdMap = {};
    const selectRs = await client.query(selectQuery, [listId]);
    for (let row of selectRs.rows) {
        rulesToIdMap[row.text] = row.id;
    }

    return rulesToIdMap;
};


async function idsForRulesInFilterList (client, filterListUrl, filterListText) {
    const filterHash = crypto.createHash("sha256")
        .update(filterListText)
        .digest("hex");

    let listId;
    const selectQuery = "SELECT id FROM lists WHERE hash = $1 LIMIT 1";
    const selectRs = await client.query(selectQuery, [filterHash]);
    if (selectRs.rows && selectRs.rows.length === 1) {
        listId = selectRs.rows[0].id;
        debugMessage(`Already seen list as id "${listId}", so returning already existing rule ids.`);
        return await idsForRulesInSeenList(client, listId);
    }

    const insertQuery = "INSERT INTO lists(url, hash) VALUES ($1, $2) RETURNING id;";
    const insertRs = await client.query(insertQuery, [filterListUrl, filterHash]);
    listId = insertRs.rows[0].id;

    debugMessage(`Recorded "${filterListUrl}" as list id "${listId}"`);
    const abpRules = logs.parseAbpRuleText(filterListText);
    const ruleChunks = utils.chunkArray(abpRules, 4000);

    const ruleToIdMap = {};
    for (let aChunk of ruleChunks) {
        const chunkRuleToIdMap = await idsForChunkOfRules(client, listId, aChunk);
        Object.entries(chunkRuleToIdMap).forEach(item => {
            const [aRule, aId] = item;
            ruleToIdMap[aRule] = aId;
        })
    }
    return ruleToIdMap;
};


async function idForSite (client, url) {
    let siteId;
    const domain = (new urlLib.URL(url)).hostname;

    const selectQuery = "SELECT id FROM sites WHERE domain = $1;";
    const selectRs = await client.query(selectQuery, [domain]);
    if (selectRs.rows && selectRs.rows.length === 1) {
        siteId = selectRs.rows[0].id;
        debugMessage(`Found ${url} has sites.id = ${siteId}.`);
        return siteId;
    }

    const insertQuery = "INSERT INTO sites(domain) VALUES ($1) RETURNING id;";
    const insertRs = await client.query(insertQuery, [domain]);
    siteId = insertRs.rows[0].id;
    debugMessage(`Inserted ${url} into sites with id = ${siteId}.`);
    return siteId;
};


async function idForCrawl (client, siteId, dwellTime, url, parentCrawlId = null, metadata = null) {
    const metadataValue = (metadata === null) ? null : JSON.stringify(metadata);
    const insertQuery = `
        INSERT INTO
            crawls(site_id, dwell_time, url, parent_crawl_id, metadata)
        VALUES
            ($1, $2, $3, $4, $5)
        RETURNING
            id;`;
    const insertRs = await client.query(insertQuery, [siteId, dwellTime, url, parentCrawlId, metadataValue]);
    
    const crawlId = insertRs.rows[0].id;
    debugMessage(`Inserted crawl for ${url} into crawls with id ${crawlId}.`);
    return crawlId;
};


const _idForResourceTypeCache = {};
async function idForResourceType (client, resourceType) {
    if (_idForResourceTypeCache[resourceType] !== undefined) {
        return _idForResourceTypeCache[resourceType];
    }

    let resourceTypeId;
    const selectQuery = "SELECT id FROM resource_types WHERE name = $1 LIMIT 1";
    const selectRs = await client.query(selectQuery, [resourceType]);
    if (selectRs.rows && selectRs.rows.length === 1) {
        resourceTypeId = selectRs.rows[0].id;
        _idForResourceTypeCache[resourceType] = resourceTypeId;
        return resourceTypeId;
    }

    const insertQuery = 'INSERT INTO resource_types(name) VALUES ($1) RETURNING id;';
    const insertRs = await client.query(insertQuery, [resourceType]);
    resourceTypeId = insertRs.rows[0].id;
    _idForResourceTypeCache[resourceType] = resourceTypeId;
    return resourceTypeId;
};


const _idForInitiatorTypeCache = {};
async function idForInitiatorType (client, initiatorType) {
    if (_idForInitiatorTypeCache[initiatorType] !== undefined) {
        return _idForInitiatorTypeCache[initiatorType];
    }

    let initiatorTypeId;
    const selectQuery = "SELECT id FROM initiator_types WHERE name = $1 LIMIT 1";
    const selectRs = await client.query(selectQuery, [initiatorType]);
    if (selectRs.rows && selectRs.rows.length === 1) {
        initiatorTypeId = selectRs.rows[0].id;
        _idForInitiatorTypeCache[initiatorType] = initiatorTypeId;
        return initiatorTypeId;
    }

    const insertQuery = 'INSERT INTO initiator_types(name) VALUES ($1) RETURNING id;';
    const insertRs = await client.query(insertQuery, [initiatorType]);
    initiatorTypeId = insertRs.rows[0].id;
    _idForInitiatorTypeCache[initiatorType] = initiatorTypeId;
    return initiatorTypeId;
};


async function recordBlocks (client, crawlId, ruleToIdMap, logEntries) {
    const insertParams = [];
    const insertTerms = [];
    let index = 0;
    for (let record of logEntries) {
        let offset = 8 * index;

        const blockingRule = record.filter;
        const ruleId = ruleToIdMap[blockingRule];

        insertParams.push(ruleId);
        insertParams.push(record.exceptionFilter ? ruleToIdMap[record.exceptionFilter] : null);
        insertParams.push(crawlId);
        insertParams.push(record.entry.for);
        insertParams.push(record.entry.initiator.url || null);
        insertParams.push(await idForResourceType(client, record.entry.type));
        insertParams.push(await idForInitiatorType(client, record.entry.initiator.type));
        insertParams.push(record.entry.from || null);
        insertTerms.push("($" + (++offset) + ", $" + (++offset) + ", $" + (++offset) + ", $" + (++offset) + ", $" + (++offset) + ", $" + (++offset) + ", $" + (++offset) + ", $" + (++offset) + ")");
        index += 1;
    }

    debugMessage(`Inserting ${insertTerms.length} block records.`);
    const insertQuery = `
        INSERT INTO
            blocks(rule_id, exception_rule_id, crawl_id, url, base_url, resource_type_id, initiator_type_id, initiator_url)
        VALUES
            ${insertTerms.join(",")};
    `;
    await client.query(insertQuery, insertParams);
};

module.exports = {
    record,
};