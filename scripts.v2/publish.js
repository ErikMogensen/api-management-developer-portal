/**
 * This script publishes the developer portal.
 * In order to run it, you need to:
 * 
 * 1) Clone the api-management-developer-portal repository
 * 2) `npm install` in the root of the project
 * 3) Run this script with a valid combination of arguments
 * 
 * Managed portal command example:
 * node publish --sourceEndpoint from.management.azure-api.net --destEndpoint to.management.azure-api.net --publishEndpoint to.developer.azure-api.net --sourceToken "SharedAccessSignature integration&2020..." --destToken "SharedAccessSignature integration&2020..."
 * 
 * publishing is not supported for self-hosted versions.
 * 
 * You can specify the SAS tokens directly (via sourceToken and destToken), or you can supply an identifier and key,
 * and the script will generate tokens that expire in 1 hour. (via sourceId, sourceKey, destId, destKey)
 */

const { getTokenOrThrow, publish } = require('./utils.js');

const yargs = require('yargs')
    .example('$0 \
        --publishEndpoint <name.developer.azure-api.net> \
        --destToken <token>\n', 'Managed')
    .example('$0 \
        --publishEndpoint <name.developer.azure-api.net> \
        --destKey <key>  \
        --destKey <token>\n', 'Managed')

    .option('publishEndpoint', {
        alias: 'p',
        type: 'string',
        description: 'Endpoint of the destination managed developer portal; if empty, destination portal will not be published; unsupported in self-hosted scenario',
        example: '<name.developer.azure-api.net>'
    })
    .option('destId', {
        type: 'string',
        description: 'The management API identifier, usually integration',
        implies: 'destKey',
        conflicts: 'destToken'
    })
    .option('destKey', {
        type: 'string',
        description: 'The management API key (primary or secondary)',
        implies: 'destId',
        conflicts: 'destToken'
    })
    .option('destToken', {
        type: 'string',
        example: 'SharedAccessSignature …',
        description: 'A SAS token for the destination portal',
        conflicts: ['destId, destKey']
    })
    .argv;

async function run() {
    try {
        const destManagementApiAccessToken = await getTokenOrThrow(yargs.destToken, yargs.destId, yargs.destKey);
        const publishEndpoint = yargs.publishEndpoint;

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
        await publish(publishEndpoint, destManagementApiAccessToken);
    }
    catch (error) {
        throw new Error(`Unable to complete migration. ${error.message}`);
    }
}

run()
    .then(() => {
        console.log("DONE");
    })
    .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
