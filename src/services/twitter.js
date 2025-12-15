/**
 * Twitter Service
 * Twitter API v2 integration for posting tweets
 */
const { TwitterApi } = require('twitter-api-v2');
const logger = require('./logger');

let twitterClient = null;

/**
 * Initialize Twitter client
 */
function init() {
    if (!process.env.TWITTER_APP_KEY) {
        logger.warn("Twitter credentials not configured");
        return false;
    }

    try {
        twitterClient = new TwitterApi({
            appKey: process.env.TWITTER_APP_KEY,
            appSecret: process.env.TWITTER_APP_SECRET,
            accessToken: process.env.TWITTER_ACCESS_TOKEN,
            accessSecret: process.env.TWITTER_ACCESS_SECRET,
        });
        logger.info("Twitter client initialized");
        return true;
    } catch (e) {
        logger.error("Twitter init failed", { error: e.message });
        return false;
    }
}

/**
 * Post a tweet for a new token launch
 */
async function postLaunchTweet(name, ticker, mint) {
    if (!twitterClient) {
        logger.warn("Skipping Tweet: Missing Credentials");
        return null;
    }

    try {
        const rwClient = twitterClient.readWrite;

        const tweetText = `NEW LAUNCH ALERT

NAME: ${name} ( $${ticker} )
CA: ${mint}

Trade now on PumpFun:
https://pump.fun/coin/${mint}

#Solana #Memecoin #Ignition`;

        const { data } = await rwClient.v2.tweet(tweetText);
        const tweetUrl = `https://x.com/user/status/${data.id}`;

        logger.info(`Tweet Posted: ${tweetUrl}`);
        return tweetUrl;
    } catch (e) {
        if (e.code === 403) {
            logger.error("Tweet Permission Error (403)", {
                error: "Check App Permissions (Read/Write) in Developer Portal."
            });
        } else if (e.code === 401) {
            logger.error("Tweet Auth Error (401)", {
                error: "Regenerate Keys & Tokens."
            });
        } else {
            logger.error("Tweet Failed", { error: e.message, code: e.code });
        }
        throw e;
    }
}

module.exports = {
    init,
    postLaunchTweet,
    getClient: () => twitterClient,
};
