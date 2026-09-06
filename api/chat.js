const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* not available in production */ }
const Groq = require('groq-sdk');
const { MongoClient } = require('mongodb');

// Reuse the connection across warm invocations
let _mongoClient = null;
async function getCollection() {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(process.env.MONGODB_URI);
    await _mongoClient.connect();
  }
  return _mongoClient.db('foresttrace').collection('chat_messages');
}

function buildSystemPrompt(context) {
  let prompt =
    'You are a Forestry AI Agent specializing in clearcut detection and forest cover change analysis. ' +
    'You help users interpret satellite imagery data to understand deforestation patterns, forest health, and their ecological implications.';

  if (context) {
    const parts = [];
    if (context.module) parts.push(`Module: ${context.module}`);
    if (context.region) parts.push(`Region: ${context.region}`);
    if (context.year) parts.push(`Year: ${context.year}`);
    if (context.sensor) parts.push(`Satellite sensor: ${context.sensor}`);
    if (context.clearcut !== null && context.clearcut !== undefined) {
      parts.push(`Clearcut coverage: ${Number(context.clearcut).toFixed(2)}% of the selected area`);
    }
    if (parts.length) {
      prompt += '\n\nCurrent visualization context:\n- ' + parts.join('\n- ');
    }
  }

  prompt +=
    '\n\nProvide concise, expert analysis. Focus on ecological impacts, trends visible in the data, ' +
    'and actionable insights for forest managers or policy analysts. Keep responses clear and practical.';

  return prompt;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, context } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' });
  }

  // Log the latest user message — fire and forget, never blocks the response
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMessage && process.env.MONGODB_URI) {
    getCollection()
      .then(col => col.insertOne({
        message: lastUserMessage.content,
        context: context || null,
        timestamp: new Date(),
      }))
      .catch(err => console.error('MongoDB log error:', err));
  }

  const client = new Groq({ apiKey });

  const groqMessages = [
    { role: 'system', content: buildSystemPrompt(context) },
    ...messages,
  ];

  try {
    const response = await client.chat.completions.create({
      model: 'qwen/qwen3.8-27b',
      messages: groqMessages,
      max_tokens: 1024,
    });

    const text = response.choices[0].message.content;
    return res.json({ content: text });
  } catch (err) {
    console.error('Groq API error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get response from AI' });
  }
};
