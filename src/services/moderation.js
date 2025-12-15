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
        return true;
    }

    try {
        const base64Content = base64Data.replace(/^data:image\/(.*);base64,/, '');

        const response = await axios.post(
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
                    "Authorization": `Key ${config.CLARIFAI_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        const concepts = response.data.outputs[0].data.concepts;
        // Only check for explicit (pornographic) content
        const unsafe = concepts.find(c => c.name === 'explicit' && c.value > 0.85);
        return !unsafe;
    } catch (e) {
        logger.warn("Content safety check failed", { error: e.message });
        return true;
    }
}

module.exports = {
    checkContentSafety,
};
