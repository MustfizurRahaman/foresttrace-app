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

// Drawing protocol handed to the model.
//
// The prohibition is the load-bearing part. A model asked to outline "the
// clearcuts" will produce coordinates -- fluent, specific, and invented, since
// it has never seen the raster. On a map that is indistinguishable from a
// measurement, so the only safe design is one where the model may compute
// geometry from numbers it was given, or name a region we hold the boundary
// for, but may never recall a location. The client validates all of this again;
// these instructions exist so the model rarely produces something to reject.
const MAP_ACTION_INSTRUCTIONS = `

You can draw on the map by ending your reply with a fenced block:

\`\`\`map-action
{"shapes": [{"action": "draw_bbox", "center": [49.80, -92.81], "sizeKm": 5, "label": "area of interest"}]}
\`\`\`

Available actions:
- draw_bbox: a box of sizeKm around center [lat, lon]
- draw_polygon: {"coordinates": [[lon, lat], ...]} -- ONLY coordinates the user
  gave you in this conversation
- highlight_region: {"region": "wabigoon"} -- outlines an FMU from the app's own
  boundary data
- highlight_patches: {"region": "wabigoon", "year": 2025, "count": 5} -- outlines
  the N largest detected clearcut patches, largest first, from published patch
  vectors. Use this whenever asked to show, find or highlight the biggest,
  largest or most significant clearcuts. You are choosing the query, not the
  locations: the coordinates come from the data, so this is not guessing.

NEVER invent coordinates to show where clearcuts, fires, forest stands or any
other mapped feature are. (highlight_patches is not an exception to this -- it
names a query the app resolves against real vectors, and no coordinate in it
comes from you.) You have not seen the imagery and cannot know their
locations; a drawn shape looks like a measurement to the user, so guessing one
is a factual error, not a helpful illustration. If asked to outline something
whose location you were not given, say that you cannot locate it and suggest the
user draw the area themselves, or use highlight_region for a whole FMU.

Only include the block when drawing genuinely helps, at most 5 shapes. Explain
in prose what you drew and where it came from.`;

/**
 * Renders the user's drawn shapes into the system prompt.
 *
 * Written as prose with the derived facts first -- area, which FMU, where --
 * because that is what the model can actually reason about. The sampled outline
 * comes last and is labelled as such, so the model doesn't present a 12-vertex
 * approximation of a 400-vertex polygon as the exact boundary.
 *
 * Untrusted input: coordinates and region ids originate in the browser, so this
 * only ever interpolates numbers and short identifiers, never free text.
 */
function describeDrawing(drawing) {
  if (!drawing || !Array.isArray(drawing.shapes) || drawing.shapes.length === 0) return '';

  const pins = drawing.shapes.filter((s) => s.kind === 'point');
  const areas = drawing.shapes.filter((s) => s.kind !== 'point');

  // Pins and areas are described separately because they support different
  // claims. An area can carry a quantity; a pin can only say "here", and
  // inviting the model to treat one as a region is how it starts inventing
  // extents around a marker.
  const parts = [];
  if (areas.length) {
    parts.push(`${areas.length} area${areas.length === 1 ? '' : 's'} `
      + `covering ${Number(drawing.totalAreaHa).toLocaleString('en-US')} ha in total`);
  }
  if (pins.length) {
    parts.push(`${pins.length} location pin${pins.length === 1 ? '' : 's'}`);
  }

  const lines = [
    `\n\nThe user has marked ${parts.join(' and ')} on the map. `
    + 'Treat this as the area of interest for the question, and prefer it over '
    + 'the whole selected region when the two disagree. A pin marks a location '
    + 'only -- it has no extent, so do not attribute an area or a quantity to it.',
  ];

  if (drawing.regionsContaining?.length) {
    lines.push(`Falls within FMU(s): ${drawing.regionsContaining.join(', ')}. ` +
      'Clearcut rasters are published per FMU, so these are the ones whose data applies.');
  }
  if (drawing.regionsNearby?.length) {
    lines.push(`Possibly also touching: ${drawing.regionsNearby.join(', ')} ` +
      '(bounding boxes overlap, but the shape\'s centre is not inside them -- FMU ' +
      'polygons are irregular, so treat this as uncertain).');
  }
  if (!drawing.regionsContaining?.length && !drawing.regionsNearby?.length) {
    lines.push('The shape does not fall inside any currently selected FMU boundary, ' +
      'so no clearcut statistics cover it. Say so rather than answering from the ' +
      'region-level numbers above.');
  }

  drawing.shapes.forEach((sh) => {
    if (sh.kind === 'point') {
      lines.push(`Pin ${sh.id}: ${sh.centroid[1]}, ${sh.centroid[0]} (lat, lon).`);
      return;
    }
    const outline = sh.outline.map(([x, y]) => `[${x}, ${y}]`).join(', ');
    lines.push(
      `Shape ${sh.id} (${sh.kind}): ${Number(sh.areaHa).toLocaleString('en-US')} ha, ` +
      `centred near ${sh.centroid[1]}, ${sh.centroid[0]} (lat, lon). ` +
      `Outline [lon, lat]${sh.sampled ? `, sampled to ${sh.outline.length} of ${sh.vertexCount} vertices` : ''}: ${outline}`,
    );
  });

  return lines.join('\n');
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

    if (Array.isArray(context.activeLayers) && context.activeLayers.length) {
      prompt += '\n\nLayers the user currently has switched on:\n- '
        + context.activeLayers
          .map((l) => `${l.module} / ${l.layer}${l.year ? ` (${l.year})` : ''}`)
          .join('\n- ')
        + '\nCover every one of these when asked what is in an area. Say plainly '
        + 'when a layer has no numbers behind it yet rather than inventing them.';
    }

    if (Array.isArray(context.biomass) && context.biomass.length) {
      prompt += '\n\nAbove-ground biomass distribution in view (t/ha : hectares):\n- '
        + context.biomass.map((b) => `${b.range}: ${Number(b.areaHa).toLocaleString('en-US')} ha`).join('\n- ');
    }

    if (Array.isArray(context.availableRegions) && context.availableRegions.length) {
      // Naming them stops the model reaching for FMUs whose boundaries aren't
      // loaded, which is the most common way a legitimate request gets refused.
      prompt += `\n\nRegions you can outline with highlight_region (use these ids exactly): `
        + context.availableRegions.join(', ')
        + '. No other boundary is loaded; say so rather than guessing coordinates.';
    }

    prompt += describeDrawing(context.drawing);
  }

  prompt += MAP_ACTION_INSTRUCTIONS;

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
      // Groq enforces an output-tokens-per-minute ceiling per org, and rejects
      // the request up front if max_tokens exceeds it -- nothing is generated,
      // so the cost of asking for too much is a hard 429 rather than a truncated
      // answer. The on-demand tier allows 1000; 1024 failed every call.
      max_tokens: Number(process.env.GROQ_MAX_TOKENS) || 900,
    });

    const text = response.choices[0].message.content;
    return res.json({ content: text });
  } catch (err) {
    console.error('Groq API error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get response from AI' });
  }
};
