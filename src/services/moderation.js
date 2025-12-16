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
    if (!config.CLARIFAI_API_KEY) {
        // If no key is configured, bypass moderation (Fail Open)
        return true;
    }

    // Helper to attempt request with specific auth header
    const attemptRequest = async (authHeader) => {
        // Remove data:image/...;base64, prefix if present
        const base64Content = base64Data.replace(/^data:image\/(.*);base64,/, '');

        return axios.post(
            'https://api.clarifai.com/v2/models/d16f390eb32cad478c7ae150069bd2c6/versions/aa8be956dbaa4b7a858826a84253cab9/outputs',
            {
                inputs: [{
                    data: {
                        image: { base64: base64Content }
                    }
                }]
            },
            {
                headers: {
                    "Authorization": authHeader,
                    "Content-Type": "application/json"
                }
            }
        );
    };

    try {
        let response;
        
        // Strategy 1: Try as "Key {api_key}" (Standard API Key)
        try {
            response = await attemptRequest(`Key ${config.CLARIFAI_API_KEY}`);
        } catch (err1) {
            // Strategy 2: If 401, try as "Bearer {pat}" (Personal Access Token)
            if (err1.response && err1.response.status === 401) {
                logger.debug("Clarifai: Key auth failed, retrying with Bearer auth...");
                response = await attemptRequest(`Bearer ${config.CLARIFAI_API_KEY}`);
            } else {
                throw err1; // Re-throw if it's not a 401
            }
        }

        const concepts = response.data.outputs[0].data.concepts;
        // Only check for explicit (pornographic) content
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
        logger.warn("Content safety check failed (Bypassing)", { error: e.message });
        return true;
    }
}

module.exports = {
    checkContentSafety,
};
