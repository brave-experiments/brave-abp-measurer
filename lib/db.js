"use strict";

const crypto = require("crypto");

const pg = require("pg");

const logs = require("./logs");
const utils = require("./utils");

let config;
try {
    config = require("../config");
} catch (_) {
    config = {
        "pg": {
            "username": process.env.PG_USERNAME,
            "host": process.env.PG_HOSTNAME,
            "password": process.env.PG_PASSWORD,
            "port": process.env.PG_PORT,
        },
    };
}

let DEBUG_MESSAGE;


const getClient = () => {
    const client = new pg.Client({
        user: config.pg.username,
        host: config.pg.host,
        database: "abp_crawls",
        password: config.pg.password,
        port: config.pg.port,
    });
    client.connect();
    if (DEBUG_MESSAGE !== undefined) {
        DEBUG_MESSAGE("Connected to database");
    }
    return client;
};


async function recordUnavailabeDomain (batchUuid, domain, rank, tags, region, debug) {
    const client = getClient();
    if (DEBUG_MESSAGE === undefined) {
        DEBUG_MESSAGE = msg => {
            if (debug === true) {
                console.log("db: " + msg);
            }
        };
    }
    const [batchId, domainId] = await registerBatchAndDomain(
        client, batchUuid,
        domain, rank, tags, region
    );
    await recordDomainNotReachable(client, batchId, domainId);
    await client.end();
}


// Returns the primary key for the created crawl record.
async function record (
    batchUuid, domain, url, dwellTime, filterUrlToTextMap, records, depth,
    breath, tags, parentCrawlId = null, rank = null, region = null,
    debug = false
) {
    if (DEBUG_MESSAGE === undefined) {
        DEBUG_MESSAGE = msg => {
            if (debug === true) {
                console.log("db: " + msg);
            }
        };
    }
    const client = getClient();

    const [batchId, domainId] = await registerBatchAndDomain(
        client, batchUuid,
        domain, rank, tags, region
    );

    await client.query("BEGIN");
    const rulesToIdMaps = [];
    const allListIds = [];
    for (const [filterListUrl, filterListText] of Object.entries(filterUrlToTextMap)) {
        const insertRs = await idsForRulesInFilterList(client, filterListUrl, filterListText);
        const [aListId, aRulesToIdMap] = insertRs;
        allListIds.push(aListId);
        rulesToIdMaps.push(aRulesToIdMap);
    }
    const allRulesToIds = Object.assign(...rulesToIdMaps);
    await client.query("COMMIT");

    const crawlId = await idForCrawl(
        client, batchId, domainId, allListIds, dwellTime, url,
        depth, breath, parentCrawlId
    );

    if (records.blocked.length > 0) {
        await recordBlocks(client, crawlId, allRulesToIds, records.blocked);
    }
    if (records.exceptions.length > 0) {
        await recordBlocks(client, crawlId, allRulesToIds, records.exceptions);
    }
    if (records.allowed.length > 0) {
        const allowedRecordsChunks = utils.chunkArray(records.allowed, 1000);
        for (const allowedRecordChunk of allowedRecordsChunks) {
            await recordAllowed(client, crawlId, allowedRecordChunk);
        }
    }

    await client.end();
    return crawlId;
}


async function registerBatchAndDomain (client, batchUuid, domain, rank, tags, region) {
    await client.query("BEGIN");

    const batchId = await idForBatch(client, batchUuid);

    if (Array.isArray(tags) && tags.length > 0) {
        await assignTagsToBatch(client, batchId, tags);
    }

    const domainId = await idForDomain(client, domain);

    if (rank !== null) {
        await recordDomainAlexaRank(client, batchId, domainId, rank, region);
    }

    await client.query("COMMIT");
    return [batchId, domainId];
}


async function idForBatch (client, batchUuid) {
    let batchId;
    const selectQuery = "SELECT id FROM batches WHERE uuid = $1 LIMIT 1;";
    const queryTerms = [batchUuid];
    const selectRs = await client.query(selectQuery, queryTerms);
    if (selectRs.rows && selectRs.rows.length === 1) {
        batchId = selectRs.rows[0].id;
        DEBUG_MESSAGE(`Found ${batchUuid} has batches.id = ${batchId}.`);
        return batchId;
    }


    const insertQuery = "INSERT INTO batches(uuid) VALUES ($1) RETURNING id;";
    try {
        const insertRs = await client.query(insertQuery, queryTerms);
        batchId = insertRs.rows[0].id;
        DEBUG_MESSAGE(`Inserted ${batchUuid} into batches with id = ${batchId}.`);
        return batchId;
    } catch (error) {
        DEBUG_MESSAGE(`A batch with UUID ${batchUuid} was inserted underneath us.  Re-fetching.`);
        return await idForBatch(client, batchUuid);
    }
}


async function idsForChunkOfRules (client, listId, rules) {
    const insertParams = [];
    const insertTerms = [];

    DEBUG_MESSAGE("About to record " + rules.length + " filter rules for this list");
    let index = 0;
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
            RETURNING id, text
        )
        SELECT 'i' AS source, id, text
        FROM   ins
        UNION  ALL
        SELECT 's' AS source, r.id, r.text
        FROM   input_rows
        JOIN   rules r USING (text_hash);
    `;
    const insertRs = await client.query(insertQuery, insertParams);

    const ruleToIdMapping = {};
    for (const row of insertRs.rows) {
        ruleToIdMapping[row.text] = row.id;
    }

    const joinQueryValues = Object.values(ruleToIdMapping).map(ruleId => {
        return `(${listId}, ${ruleId})`;
    });

    const insertJoinQuery = "INSERT INTO lists_rules(list_id, rule_id) VALUES " + joinQueryValues.join(",") + " ON CONFLICT (list_id, rule_id) DO NOTHING;";
    await client.query(insertJoinQuery, []);
    return ruleToIdMapping;
}


async function assignTagsToBatch (client, batchId, tags) {
    const insertParams = [];
    const insertTerms = [];

    let offset = 0;
    DEBUG_MESSAGE(`About to insert/fetch ids for tags: ${tags.join(", ")}.`);
    tags.forEach(tag => {
        insertParams.push(tag);
        insertTerms.push("(CAST($" + (++offset) + " AS text))");
    });

    const insertQuery = `
        WITH input_rows(name) AS (
            VALUES
                ${insertTerms.join(",")}
        )
        , ins AS (
            INSERT INTO tags (name)
            SELECT * FROM input_rows
            ON CONFLICT (name) DO NOTHING
            RETURNING id
        )
        SELECT 'i' AS source, id
        FROM   ins
        UNION  ALL
        SELECT 's' AS source, t.id
        FROM   input_rows
        JOIN   tags t USING (name);
    `;
    const insertRs = await client.query(insertQuery, insertParams);
    const tagIds = insertRs.rows.map(row => row.id);

    const joinQueryValues = tagIds.map(tagId => {
        return `(${batchId}, ${tagId})`;
    });
    const insertJoinQuery = "INSERT INTO batches_tags(batch_id, tag_id) VALUES " + joinQueryValues.join(",") + " ON CONFLICT (batch_id, tag_id) DO NOTHING;";
    await client.query(insertJoinQuery, []);
    return tagIds;
}


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
    for (const row of selectRs.rows) {
        rulesToIdMap[row.text] = row.id;
    }

    return rulesToIdMap;
}


async function idsForRulesInFilterList (client, filterListUrl, filterListText) {
    const filterHash = crypto.createHash("sha256")
        .update(filterListText)
        .digest("hex");

    let listId;
    const selectQuery = "SELECT id FROM lists WHERE hash = $1 LIMIT 1";
    const selectRs = await client.query(selectQuery, [filterHash]);
    if (selectRs.rows && selectRs.rows.length === 1) {
        listId = selectRs.rows[0].id;
        DEBUG_MESSAGE(`Already seen list as id "${listId}", so returning already existing rule ids.`);
        return [listId, await idsForRulesInSeenList(client, listId)];
    }

    const insertQuery = "INSERT INTO lists(url, hash) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING RETURNING id;";
    const insertRs = await client.query(insertQuery, [filterListUrl, filterHash]);

    // If there is no row ID returned, then there was a conflict in the hash insert, so just
    // re-query
    if (insertRs.rows.length === 0 || insertRs.rows[0].id === undefined) {
        const reSelectRs = await client.query(selectQuery, [filterHash]);
        listId = reSelectRs.rows[0].id;
        return [listId, await idsForRulesInSeenList(client, listId)];
    }

    listId = insertRs.rows[0].id;

    DEBUG_MESSAGE(`Recorded "${filterListUrl}" as list id "${listId}"`);
    const abpRules = logs.parseAbpRuleText(filterListText);
    const ruleChunks = utils.chunkArray(abpRules, 4000);

    const ruleToIdMap = {};
    for (const aChunk of ruleChunks) {
        const chunkRuleToIdMap = await idsForChunkOfRules(client, listId, aChunk);
        Object.entries(chunkRuleToIdMap).forEach(item => {
            const [aRule, aId] = item;
            ruleToIdMap[aRule] = aId;
        });
    }
    return [listId, ruleToIdMap];
}


async function recordDomainNotReachable (client, batchId, domainOrDomainId) {
    let domainId;
    if (typeof domainOrDomainId === "number") {
        domainId = domainOrDomainId;
    } else {
        domainId = await idForDomain(client, domainOrDomainId);
    }

    const insertQuery = "INSERT INTO domains_unreachable(domain_id, batch_id) VALUES ($1, $2) RETURNING id;";
    const insertRs = await client.query(insertQuery, [domainId, batchId]);
    const resultId = insertRs.rows[0].id;
    DEBUG_MESSAGE(`Inserted domains_unreachable record with id ${resultId}`);
    return resultId;
}


async function recordDomainAlexaRank (client, batchId, domainOrDomainId, rank, region) {
    let domainId;
    if (typeof domainOrDomainId === "number") {
        domainId = domainOrDomainId;
    } else {
        domainId = await idForDomain(client, domainOrDomainId);
    }

    const selectQuery = `
        SELECT
            id
        FROM
            batches_domains_ranks
        WHERE
            batch_id = $1 AND
            domain_id = $2
    `;
    const selectRs = await client.query(selectQuery, [batchId, domainId]);
    if (selectRs.rows.length > 0) {
        const resultId = selectRs.rows[0].id;
        DEBUG_MESSAGE(`Found existing batches_domains_ranks record (batch_id = ${batchId}, domain_id = ${domainId}) with id ${resultId}`);
        return selectRs.rows[0].id;
    }

    const insertQuery = `
        INSERT INTO
            batches_domains_ranks(domain_id, batch_id, rank, region)
        VALUES
            ($1, $2, $3, $4)
        RETURNING
            id;`;
    const insertValues = [domainId, batchId, rank, region];
    const insertRs = await client.query(insertQuery, insertValues);
    const resultId = insertRs.rows[0].id;
    DEBUG_MESSAGE(`Inserted batches_domains_ranks record with id ${resultId}`);
    return resultId;
}


async function idForDomain (client, domain) {
    let domainId;

    const selectQuery = "SELECT id FROM domains WHERE domain = $1;";
    const selectRs = await client.query(selectQuery, [domain]);
    if (selectRs.rows && selectRs.rows.length === 1) {
        domainId = selectRs.rows[0].id;
        DEBUG_MESSAGE(`Found ${domain} has domain.id = ${domainId}.`);
        return domainId;
    }

    const insertQuery = "INSERT INTO domains(domain) VALUES ($1) RETURNING id;";
    const insertRs = await client.query(insertQuery, [domain]);
    domainId = insertRs.rows[0].id;
    DEBUG_MESSAGE(`Inserted ${domain} into domains with id = ${domainId}.`);
    return domainId;
}


async function idForCrawl (
    client, batchId, domainId, listIds, dwellTime, url, depth, breath,
    parentCrawlId = null
) {
    await client.query("BEGIN");

    const insertQuery = `
        INSERT INTO
            crawls(batch_id, domain_id, dwell_time, url, depth, breath, parent_crawl_id)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7)
        RETURNING
            id;`;
    const insertArgs = [batchId, domainId, dwellTime, url, depth, breath, parentCrawlId];
    const insertRs = await client.query(insertQuery, insertArgs);

    const crawlId = insertRs.rows[0].id;
    DEBUG_MESSAGE(`Inserted crawl for ${url} into crawls with id ${crawlId}.`);

    // Now that we've inserted the crawl ID into the DB, associate the crawl
    // with the lists that were used during the crawl.
    const insertCrawlListQuery = `
        INSERT INTO
            crawls_lists(crawl_id, list_id)
        VALUES
            ($1, $2);`;
    for (const aListId of listIds) {
        await client.query(insertCrawlListQuery, [crawlId, aListId]);
    }
    await client.query("COMMIT");

    return crawlId;
}


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

    const insertQuery = "INSERT INTO resource_types(name) VALUES ($1) RETURNING id;";
    const insertRs = await client.query(insertQuery, [resourceType]);
    resourceTypeId = insertRs.rows[0].id;
    _idForResourceTypeCache[resourceType] = resourceTypeId;
    return resourceTypeId;
}


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

    const insertQuery = "INSERT INTO initiator_types(name) VALUES ($1) RETURNING id;";
    const insertRs = await client.query(insertQuery, [initiatorType]);
    initiatorTypeId = insertRs.rows[0].id;
    _idForInitiatorTypeCache[initiatorType] = initiatorTypeId;
    return initiatorTypeId;
}


async function recordAllowed (client, crawlId, allowedEntries) {
    const insertParams = [];
    const insertTerms = [];
    let index = 0;
    for (const record of allowedEntries) {
        const insertRow = [];
        insertParams.push(crawlId);
        insertRow.push("$" + (++index));

        insertParams.push(record.for);
        insertRow.push("$" + (++index));

        insertParams.push(record.initiator.url || null);
        insertRow.push("$" + (++index));

        insertParams.push(record.from || null);
        insertRow.push("$" + (++index));

        insertParams.push(await idForResourceType(client, record.type));
        insertRow.push("$" + (++index));

        insertParams.push(await idForInitiatorType(client, record.initiator.type));
        insertRow.push("$" + (++index));

        insertParams.push(record.requestId);
        insertRow.push("$" + (++index));

        insertParams.push(record.hash);
        insertRow.push("$" + (++index));

        insertParams.push(record.timestamp);
        insertRow.push("$" + (++index));

        insertParams.push(record.size);
        insertRow.push("$" + (++index));
        insertTerms.push("(" + insertRow.join(", ") + ")");
    }

    DEBUG_MESSAGE(`Inserting ${insertTerms.length} allow records.`);
    const insertQuery = `
        INSERT INTO
            allowed_requests(crawl_id, url, base_url, initiator_url, resource_type_id, initiator_type_id, request_id, hash, timestamp, size)
        VALUES
            ${insertTerms.join(",")};
    `;
    await client.query(insertQuery, insertParams);
}


async function recordBlocks (client, crawlId, ruleToIdMap, logEntries) {
    const insertParams = [];
    const insertTerms = [];
    let index = 0;
    for (const record of logEntries) {
        const blockingRule = record.filter;
        const ruleId = ruleToIdMap[blockingRule];
        const insertRow = [];

        insertParams.push(ruleId);
        insertRow.push("$" + (++index));

        insertParams.push(record.exceptionFilter ? ruleToIdMap[record.exceptionFilter] : null);
        insertRow.push("$" + (++index));

        insertParams.push(crawlId);
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.for);
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.initiator.url || null);
        insertRow.push("$" + (++index));

        insertParams.push(await idForResourceType(client, record.entry.type));
        insertRow.push("$" + (++index));

        insertParams.push(await idForInitiatorType(client, record.entry.initiator.type));
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.from || null);
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.requestId);
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.hash);
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.timestamp);
        insertRow.push("$" + (++index));

        insertParams.push(record.entry.size);
        insertRow.push("$" + (++index));
        insertTerms.push("(" + insertRow.join(", ") + ")");
    }

    DEBUG_MESSAGE(`Inserting ${insertTerms.length} block records.`);
    const insertQuery = `
        INSERT INTO
            blocked_requests(rule_id, exception_rule_id, crawl_id, url, base_url, resource_type_id, initiator_type_id, initiator_url, request_id, hash, timestamp, size)
        VALUES
            ${insertTerms.join(",")};
    `;
    await client.query(insertQuery, insertParams);
}

module.exports = {
    record,
    recordUnavailabeDomain,
};
