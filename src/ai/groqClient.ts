// src/ai/groqClient.ts
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const TEMPERATURE = parseFloat(process.env.GROQ_TEMPERATURE || '0.1');
const MAX_TOKENS = parseInt(process.env.GROQ_MAX_TOKENS || '4096');

/**
 * Core LLM interface. Sends prompts to Groq API with built-in retry logic 
 * to handle rate limiting (HTTP 429) automatically via exponential backoff.
 */
export async function ai(system: string, user: string, try_ = 1): Promise<string> {
    if (!API_KEY) {
        console.error('❌ GROQ_API_KEY is not defined in the .env file');
        process.exit(1);
    }

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { 
                model: MODEL, 
                messages: [
                    { role: 'system', content: system }, 
                    { role: 'user', content: user }
                ], 
                temperature: TEMPERATURE, 
                max_tokens: MAX_TOKENS 
            },
            { headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' } }
        );
        return response.data.choices[0].message.content as string;
    } catch (e: any) {
        // Exponential backoff for rate limits (HTTP 429)
        if (e.response?.status === 429 && try_ <= 3) {
            const wait = try_ * 20;
            console.log(`   [API] Rate limited. Waiting ${wait}s before retry...`);
            await new Promise(r => setTimeout(r, wait * 1000));
            return ai(system, user, try_ + 1); // Recursive retry
        }
        throw e;
    }
}