const crypto = require('crypto');
const fs = require("fs");
const moment = require('moment');
const path = require("path");
const https = require("https");
const { BlobServiceClient } = require("@azure/storage-blob");
const blobStorageContainer = "content";
const mime = require("mime-types");

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

function listFilesInDirectory(dir) {
    const results = [];

    fs.readdirSync(dir).forEach((file) => {
        file = dir + "/" + file;
        const stat = fs.statSync(file);

        if (stat && stat.isDirectory()) {
            results.push(...listFilesInDirectory(file));
        } else {
            results.push(file);
        }
    });

    return results;
}

/**
 * Attempts to get a develoer portal storage connection string in two ways:
 * 1) if the connection string is explicitly set by the user, use it.
 * 2) retrieving the connection string from the management API using the instance endpoint and SAS token
 * @param {string} managementApiEndpoint the management endpoint of service instance
 * @param {string} managementApiAccessToken the SAS token
 */
async function getStorageSasTokenOrThrow(managementApiEndpoint, managementApiAccessToken) {
    if (managementApiAccessToken) {
        // token should always be available, because we call
        // getTokenOrThrow before this
        return await getStorageSasToken(managementApiEndpoint, managementApiAccessToken);
    }
    throw Error('Storage connection could not be retrieved');
}

/**
 * Gets a storage connection string from the management API for the specified APIM instance and
 * SAS token.
 * @param {string} managementApiEndpoint the management endpoint of service instance
 * @param {string} managementApiAccessToken the SAS token
 */
async function getStorageSasToken(managementApiEndpoint, managementApiAccessToken) {
    const response = await request("POST", `https://${managementApiEndpoint}/subscriptions/00000/resourceGroups/00000/providers/Microsoft.ApiManagement/service/00000/portalSettings/mediaContent/listSecrets?api-version=2019-12-01`, managementApiAccessToken);
    return response.containerSasUrl;
}

/**
 * Attempts to get a SAS token in two ways:
 * 1) if the token is explicitly set by the user, use that token.
 * 2) if the id and key are specified, manually generate a SAS token.
 * @param {string} token an optionally specified token
 * @param {string} id the Management API identifier
 * @param {string} key the Management API key
 */
 async function getTokenOrThrow(token, id, key) {
    if (token) {
        return token;
    }
    if (id && key) {
        return await generateSASToken(id, key);
    }
    throw Error('You need to specify either: token or id AND key');
}

/**
 * Generates a SAS token from the specified Management API id and key.  Optionally
 * specify the expiry time, in seconds.
 * 
 * See https://docs.microsoft.com/en-us/rest/api/apimanagement/apimanagementrest/azure-api-management-rest-api-authentication#ManuallyCreateToken
 * @param {string} id The Management API identifier.
 * @param {string} key The Management API key (primary or secondary)
 * @param {number} expiresIn The number of seconds in which the token should expire.
 */
async function generateSASToken(id, key, expiresIn = 3600) {
    const now = moment.utc(moment());
    const expiry = now.clone().add(expiresIn, 'seconds');
    const expiryString = expiry.format(`YYYY-MM-DD[T]HH:mm:ss.SSSSSSS[Z]`);

    const dataToSign = `${id}\n${expiryString}`;
    const signedData = crypto.createHmac('sha512', key).update(dataToSign).digest('base64');
    return `SharedAccessSignature uid=${id}&ex=${expiryString}&sn=${signedData}`;
}

/**
 * Publishes the content of the specified APIM instance using a SAS token.
 * @param {string} endpoint the publishing endpoint of the destination developer portal instance
 * @param {string} token the SAS token
 */
async function publish(endpoint, token) {
    try {
        const url = `https://${endpoint}/publish`; // ?api-version=2019-12-01

        // returns with literal OK (missing quotes), which is invalid json.
        await request("POST", url, token);
    }
    catch (error) {
        throw new Error(`Unable to schedule website publishing. ${error.message}`);
    }
}

/**
 * A wrapper for making a request and returning its response body.
 * @param {Object} options https options
 */
async function request(method, url, accessToken, body) {
    const headers = {
        "If-Match": "*",
        "Content-Type": "application/json",
        "Authorization": accessToken
    };

    if (body) {
        headers["Content-Length"] = Buffer.byteLength(body);
    }

    const options = {
        port: 443,
        method: method,
        headers: headers
    };

    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (resp) => {
            let data = '';

            resp.on('data', (chunk) => {
                data += chunk;
            });

            resp.on('end', () => {
                switch (resp.statusCode) {
                    case 200:
                    case 201:
                        data.startsWith("{") ? resolve(JSON.parse(data)) : resolve(data);
                        break;
                    case 404:
                        reject({ code: "NotFound", message: `Resource not found: ${url}` });
                        break;
                    case 401:
                        reject({ code: "Unauthorized", message: `Unauthorized. Make sure you correctly specified management API access token before running the script.` });
                        break;
                    case 403:
                        reject({ code: "Forbidden", message: `Looks like you are not allowed to perform this operation. Please check with your administrator.` });
                        break;
                    default:
                        reject({ code: "UnhandledError", message: `Could not complete request to ${url}. Status: ${resp.statusCode} ${resp.statusMessage}` });
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

async function downloadBlobs(blobStorageUrl, snapshotMediaFolder) {
    try {
        const blobServiceClient = new BlobServiceClient(blobStorageUrl.replace(`/${blobStorageContainer}`, ""));
        const containerClient = blobServiceClient.getContainerClient(blobStorageContainer);

        await fs.promises.mkdir(path.resolve(snapshotMediaFolder), { recursive: true });

        let blobs = containerClient.listBlobsFlat();

        for await (const blob of blobs) {
            const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
            const extension = mime.extension(blob.properties.contentType);
            let pathToFile;

            if (extension != null) {
                pathToFile = `${snapshotMediaFolder}/${blob.name}.${extension}`;
            }
            else {
                pathToFile = `${snapshotMediaFolder}/${blob.name}`;
            }

            const folderPath = pathToFile.substring(0, pathToFile.lastIndexOf("/"));
            await fs.promises.mkdir(path.resolve(folderPath), { recursive: true });
            await blockBlobClient.downloadToFile(pathToFile);
        }
    }
    catch (error) {
        throw new Error(`Unable to download media files. ${error.message}`);
    }
}

async function uploadBlobs(blobStorageUrl, localMediaFolder) {
    try {
        const blobServiceClient = new BlobServiceClient(blobStorageUrl.replace(`/${blobStorageContainer}`, ""));
        const containerClient = blobServiceClient.getContainerClient(blobStorageContainer);
        const fileNames = listFilesInDirectory(localMediaFolder);

        for (const fileName of fileNames) {
            const blobKey = fileName.replace(localMediaFolder + "/", "").split(".")[0];
            const contentType = mime.lookup(fileName) || "application/octet-stream";
            const blockBlobClient = containerClient.getBlockBlobClient(blobKey);

            await blockBlobClient.uploadFile(fileName, {
                blobHTTPHeaders: {
                    blobContentType: contentType
                }
            });
        }
    }
    catch (error) {
        throw new Error(`Unable to upload media files. ${error.message}`);
    }
}

async function deleteBlobs(blobStorageUrl) {
    try {
        const blobServiceClient = new BlobServiceClient(blobStorageUrl.replace(`/${blobStorageContainer}`, ""));
        const containerClient = blobServiceClient.getContainerClient(blobStorageContainer);

        let blobs = containerClient.listBlobsFlat();

        for await (const blob of blobs) {
            const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
            await blockBlobClient.delete();
        }
    }
    catch (error) {
        throw new Error(`Unable to delete media files. ${error.message}`);
    }
}

module.exports = {
    request,
    downloadBlobs,
    uploadBlobs,
    deleteBlobs,
    getStorageSasTokenOrThrow,
    getTokenOrThrow,
    publish
};
