/**
 * Twitter Service
 * Twitter API v2 integration for posting tweets
 * v25.22 FIX: Cache authenticated username for proper tweet URLs
 * v25.46: Added KOTH announcements with rate limiting
 */
const { TwitterApi } = require('twitter-api-v2');
const logger = require('./logger');

let twitterClient = null;
let authenticatedUsername = null; // v25.22: Cache the bot's Twitter username

// v25.46: KOTH tweet rate limiting (Twitter free tier: 1500 tweets/month = ~50/day)
const KOTH_TWEET_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes minimum between KOTH tweets
let lastKothTweetTime = 0;

/**
 * Initialize Twitter client and fetch authenticated user's username
 */
async function init() {
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

        // v25.22 FIX: Fetch and cache the authenticated user's username
        // This is used to construct proper tweet URLs
        try {
            const me = await twitterClient.v2.me();
            authenticatedUsername = me.data.username;
            logger.info(`Twitter client initialized for @${authenticatedUsername}`);
        } catch (meErr) {
            // Fallback to env var if API call fails
            authenticatedUsername = process.env.TWITTER_USERNAME || null;
            logger.warn("Could not fetch Twitter username from API, using fallback", {
                fallback: authenticatedUsername,
                error: meErr.message
            });
        }

        return true;
    } catch (e) {
        logger.error("Twitter init failed", { error: e.message });
        return false;
    }
}

/**
 * v25.46: Post a tweet for KOTH (King of the Hill) selection
 * Announces the new KOTH token with AI reasoning
 * Includes rate limiting to avoid Twitter 429 errors
 */
async function postKothTweet(name, ticker, mint, reasoning) {
    if (!twitterClient) {
        logger.warn("Skipping KOTH Tweet: Missing Credentials");
        return null;
    }

    // Rate limiting check
    const now = Date.now();
    const timeSinceLastTweet = now - lastKothTweetTime;
    if (timeSinceLastTweet < KOTH_TWEET_COOLDOWN_MS) {
        const waitMinutes = Math.ceil((KOTH_TWEET_COOLDOWN_MS - timeSinceLastTweet) / 60000);
        logger.info(`[KOTH Tweet] Rate limited - wait ${waitMinutes} min before next tweet`);
        return null;
    }

    try {
        const rwClient = twitterClient.readWrite;

        // Truncate reasoning if too long (Twitter 280 char limit)
        const maxReasoningLength = 120;
        let shortReasoning = reasoning || 'Top performer by volume and market metrics';
        if (shortReasoning.length > maxReasoningLength) {
            shortReasoning = shortReasoning.slice(0, maxReasoningLength - 3) + '...';
        }

        const tweetText = `👑 NEW KING OF THE PILL

$${ticker} (${name})

🤖 AI Analysis: ${shortReasoning}

Trade now:
https://pump.fun/coin/${mint}

#Solana #KOTH #Ignition`;

        const { data } = await rwClient.v2.tweet(tweetText);

        const tweetUrl = authenticatedUsername
            ? `https://x.com/${authenticatedUsername}/status/${data.id}`
            : `https://x.com/i/status/${data.id}`;

        // Update rate limit timestamp on success
        lastKothTweetTime = Date.now();

        logger.info(`KOTH Tweet Posted: ${tweetUrl}`);
        return tweetUrl;
    } catch (e) {
        if (e.code === 403) {
            logger.error("KOTH Tweet Permission Error (403)", {
                error: "Check App Permissions (Read/Write) in Developer Portal."
            });
        } else if (e.code === 401) {
            logger.error("KOTH Tweet Auth Error (401)", {
                error: "Regenerate Keys & Tokens."
            });
        } else if (e.code === 429) {
            // Rate limited by Twitter - set cooldown to prevent immediate retries
            lastKothTweetTime = Date.now();
            logger.warn("KOTH Tweet Rate Limited (429) - cooldown activated");
        } else {
            logger.error("KOTH Tweet Failed", { error: e.message, code: e.code });
        }
        // Don't throw - KOTH tweeting failure shouldn't break the flow
        return null;
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

        // v25.22 FIX: Use cached username instead of literal "user"
        // Falls back to generic x.com/i/status URL if username not available
        const tweetUrl = authenticatedUsername
            ? `https://x.com/${authenticatedUsername}/status/${data.id}`
            : `https://x.com/i/status/${data.id}`;

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
    postKothTweet,
    getClient: () => twitterClient,
};
