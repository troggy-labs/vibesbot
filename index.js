import 'dotenv/config';
import axios from 'axios';
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events' // matches the URL you gave Slack
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// ——— OpenAI helper ———
async function parseVibesText(text, contextInfo = {}) {
  const prompt = `You are a music curation expert. Parse this vibe description into structured data for Spotify's recommendations API.

Context: ${JSON.stringify(contextInfo)}

User input: "${text}"

Return ONLY valid JSON with these fields:
- mood: string (e.g. "melancholy", "energetic", "chill")
- seed_genres: array of 1-3 genre strings (e.g. ["indie", "alternative"])
- energy: float 0.0-1.0 (0=calm, 1=high energy)
- acousticness: float 0.0-1.0 (0=electronic, 1=acoustic)
- danceability: float 0.0-1.0 (0=not danceable, 1=very danceable)
- valence: float 0.0-1.0 (0=sad, 1=happy)
- tempo: integer 60-200 (BPM)
- playlist_name: creative name for the playlist
- playlist_description: 2-line description

Example:
{"mood":"melancholy","seed_genres":["indie"],"energy":0.25,"acousticness":0.8,"danceability":0.3,"valence":0.2,"tempo":90,"playlist_name":"Late-Night Lament","playlist_description":"Sparse indie tracks for contemplative 2am moments.\\nWhen the world sleeps but your thoughts don't."}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  try {
    return JSON.parse(response.data.choices[0].message.content.trim());
  } catch (e) {
    console.error('Failed to parse OpenAI response:', response.data.choices[0].message.content);
    return {
      mood: "chill",
      seed_genres: ["pop"],
      energy: 0.5,
      acousticness: 0.5,
      danceability: 0.5,
      valence: 0.5,
      tempo: 120,
      playlist_name: "Good Vibes",
      playlist_description: "A playlist for any mood.\nGenerated just for you."
    };
  }
}

// ——— Spotify helper ———
let spotifyToken = null;
async function getSpotifyToken() {
  if (spotifyToken) return spotifyToken; // naive cache
  const rsp = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64')
      }
    }
  );
  spotifyToken = rsp.data.access_token;
  // auto-expire after 50 min
  setTimeout(() => (spotifyToken = null), 50 * 60 * 1000);
  return spotifyToken;
}

async function getContextInfo(client, channelId, userId) {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
  const timeOfDay = now.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    hour12: true 
  });
  
  let recentMessages = [];
  try {
    const history = await client.conversations.history({
      channel: channelId,
      limit: 5
    });
    recentMessages = history.messages
      .filter(msg => msg.user === userId)
      .slice(0, 3)
      .map(msg => msg.text || '')
      .reverse();
  } catch (e) {
    console.error('Failed to get message history:', e);
  }

  return {
    dayOfWeek,
    timeOfDay,
    recentMessages: recentMessages.length > 0 ? recentMessages : ['No recent messages']
  };
}

async function getRecommendations(vibesData) {
  const token = await getSpotifyToken();
  
  const params = new URLSearchParams({
    seed_genres: vibesData.seed_genres.join(','),
    target_energy: vibesData.energy,
    target_acousticness: vibesData.acousticness,
    target_danceability: vibesData.danceability,
    target_valence: vibesData.valence,
    target_tempo: vibesData.tempo,
    limit: 15,
    market: 'US'
  });

  const res = await axios.get(
    `https://api.spotify.com/v1/recommendations?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  return res.data.tracks.map(t => ({
    name: `${t.name} – ${t.artists[0].name}`,
    url: `https://open.spotify.com/track/${t.id}`,
    energy: t.energy || 0.5,
    valence: t.valence || 0.5
  }));
}

async function generateCoverArt(playlistName, mood) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt: `Abstract album cover art for a "${mood}" playlist called "${playlistName}". Minimalist, artistic, suitable for music streaming. No text.`,
        size: '1024x1024',
        quality: 'standard',
        n: 1
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.data[0].url;
  } catch (e) {
    console.error('Failed to generate cover art:', e);
    return null;
  }
}

// ——— Slash command handler ———
app.command('/vibes', async ({ command, ack, say, client }) => {
  await ack({ text: 'Cooking up a playlist… check your DMs!' });

  try {
    const contextInfo = await getContextInfo(client, command.channel_id, command.user_id);
    const vibesData = await parseVibesText(command.text || 'chill vibes', contextInfo);
    const tracks = await getRecommendations(vibesData);
    
    const sortedTracks = tracks.sort((a, b) => {
      const aScore = (a.energy || 0.5) + (a.valence || 0.5);
      const bScore = (b.energy || 0.5) + (b.valence || 0.5);
      return aScore - bScore;
    });

    const coverArtUrl = await generateCoverArt(vibesData.playlist_name, vibesData.mood);

    const headerBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🎵 *${vibesData.playlist_name}*\n\n${vibesData.playlist_description}`
        }
      }
    ];

    if (coverArtUrl) {
      headerBlocks.push({
        type: 'image',
        image_url: coverArtUrl,
        alt_text: `Cover art for ${vibesData.playlist_name}`
      });
    }

    headerBlocks.push({ type: 'divider' });

    const trackBlocks = sortedTracks.flatMap(t => [
      { type: 'section', text: { type: 'mrkdwn', text: `<${t.url}|${t.name}>` } },
      { type: 'divider' }
    ]);

    const im = await client.conversations.open({ users: command.user_id });
    await client.chat.postMessage({
      channel: im.channel.id,
      text: `Here's your ${vibesData.playlist_name} playlist! 🎧`,
      blocks: [...headerBlocks, ...trackBlocks]
    });
  } catch (error) {
    console.error('Error generating playlist:', error);
    const im = await client.conversations.open({ users: command.user_id });
    await client.chat.postMessage({
      channel: im.channel.id,
      text: 'Sorry, I had trouble generating your playlist. Please try again! 🎧'
    });
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Vibes bot is running!');
})();
