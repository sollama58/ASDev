/**
 * Content Moderation Service
 * Clarifai integration for image safety checks
 */
const axios = require('axios');
const config = require('../config/env');
const logger = require('./logger');

/**
 * Check image content safety using Clarifai
 * Returns true if safe, false if unsafe
 */
async function checkContentSafety(base64Data) {
    // 1. Check if key exists
    if (!config.CLARIFAI_API_KEY) {
        return true; // Fail open if no key
    }

    // 2. Clean the key
    const cleanKey = config.CLARIFAI_API_KEY.trim();

    // Helper to attempt request with specific auth header
    const attemptRequest = async (authPrefix) => {
        // Remove data:image/...;base64, prefix if present
        const base64Content = base64Data.replace(/^data:image\/(.*);base64,/, '');

        // Use the standard 'moderation-recognition' model
        // Model ID: d16f390eb32cad478c7ae150069bd2c6
        return axios.post(
            'https://api.clarifai.com/v2/models/d16f390eb32cad478c7ae150069bd2c6/outputs',
            {
                inputs: [{
                    data: {
                        image: { base64: base64Content }
                    }
                }]
            },
            {
                headers: {
                    "Authorization": `${authPrefix} ${cleanKey}`,
                    "Content-Type": "application/json"
                }
            }
        );
    };

    try {
        let response;
        
        // Strategy 1: Try as "Key {api_key}" (Standard API Key)
        try {
            response = await attemptRequest('Key');
        } catch (err1) {
            // Strategy 2: If 401, try as "Bearer {pat}" (Personal Access Token)
            if (err1.response && err1.response.status === 401) {
                logger.debug("Clarifai: Key auth failed (401), retrying with Bearer auth...");
                response = await attemptRequest('Bearer');
            } else {
                throw err1; // Re-throw if it's not a 401 (e.g. 500 or network error)
            }
        }

        if (!response.data || !response.data.outputs || !response.data.outputs[0]) {
            logger.warn("Clarifai response malformed", { data: response.data });
            return true; // Fail open on bad response format
        }

        const concepts = response.data.outputs[0].data.concepts;
        // unsafe is true if 'explicit' score is > 0.85
        const unsafe = concepts.find(c => c.name === 'explicit' && c.value > 0.85);
        
        if (unsafe) {
            logger.warn("Content blocked by moderation", { score: unsafe.value });
            return false;
        }
        
        return true;

    } catch (e) {
        // FAIL OPEN: If the moderation service fails (e.g. Auth Error, Rate Limit, Network Error),
        // we log the warning but ALLOW the content to proceed so the app doesn't break.
        const status = e.response ? e.response.status : 'Unknown';
        logger.warn(`Content safety check failed (${status}) - Bypassing`, { error: e.message });
        return true;
    }
}

module.exports = {
    checkContentSafety,
};
