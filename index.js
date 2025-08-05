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
  const prompt = `You are a music curation expert. Parse this vibe description into structured data for playlist search and curation.

Context: ${JSON.stringify(contextInfo)}

User input: "${text}"

Return ONLY valid JSON with these fields:
- mood: string (e.g. "melancholy", "energetic", "chill", "upbeat", "relaxing")
- seed_genres: array of 1-3 genre strings (e.g. ["indie", "alternative", "pop", "rock", "electronic"])
- energy: float 0.0-1.0 (0=calm, 1=high energy)
- valence: float 0.0-1.0 (0=sad, 1=happy)
- playlist_name: creative name for the playlist
- playlist_description: 2-line description

Example:
{"mood":"melancholy","seed_genres":["indie"],"energy":0.25,"valence":0.2,"playlist_name":"Late-Night Lament","playlist_description":"Sparse indie tracks for contemplative 2am moments.\\nWhen the world sleeps but your thoughts don't."}`;

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
    let content = response.data.choices[0].message.content.trim();
    
    // Remove markdown code blocks if present
    if (content.startsWith('```json')) {
      content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (content.startsWith('```')) {
      content = content.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    return JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse OpenAI response:', response.data.choices[0].message.content);
    return {
      mood: "chill",
      seed_genres: ["pop"],
      energy: 0.5,
      valence: 0.5,
      playlist_name: "Good Vibes",
      playlist_description: "A playlist for any mood.\nGenerated just for you."
    };
  }
}

// ——— Spotify helper ———
let spotifyToken = null;
async function getSpotifyToken() {
  if (spotifyToken) return spotifyToken; // naive cache
  
  try {
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
  } catch (error) {
    console.error('Error getting Spotify token:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

async function getContextInfo(client, channelId, userId) {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
  const timeOfDay = now.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    hour12: true 
  });
  
  console.log(`Attempting to get history for channel: ${channelId}, user: ${userId}`);
  
  let recentMessages = [];
  try {
    // First check if we can access the channel info
    const channelInfo = await client.conversations.info({ channel: channelId });
    console.log(`Channel info:`, channelInfo.channel.name, channelInfo.channel.is_member);
    
    const history = await client.conversations.history({
      channel: channelId,
      limit: 5
    });
    
    console.log(`Got ${history.messages.length} messages`);
    
    recentMessages = history.messages
      .filter(msg => msg.user === userId)
      .slice(0, 3)
      .map(msg => msg.text || '')
      .reverse();
  } catch (e) {
    console.error('Failed to get message history:', e.message, e.data);
  }

  return {
    dayOfWeek,
    timeOfDay,
    recentMessages: recentMessages.length > 0 ? recentMessages : ['No recent messages']
  };
}

async function getRecommendations(vibesData) {
  const token = await getSpotifyToken();
  
  if (!token) {
    throw new Error('Failed to get Spotify access token');
  }
  
  // Create search queries based on mood and genres
  const searchQueries = [
    `${vibesData.mood} ${vibesData.seed_genres.join(' ')}`,
    `${vibesData.seed_genres.join(' ')} playlist`,
    `${vibesData.mood} music`,
    `${vibesData.seed_genres[0]} vibes`
  ];

  console.log('Searching for playlists with queries:', searchQueries);
  console.log('Vibes data:', JSON.stringify(vibesData, null, 2));

  try {
    const allTracks = [];
    
    // Search for playlists using multiple queries
    for (const query of searchQueries.slice(0, 2)) { // Limit to 2 queries to avoid rate limits
      try {
        const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=10&market=US`;
        console.log(`Making Spotify search request to: ${searchUrl}`);
        
        const searchRes = await axios.get(searchUrl, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log(`Spotify search response status: ${searchRes.status}`);
        console.log(`Found ${searchRes.data?.playlists?.items?.length || 0} playlists`);

        const playlists = (searchRes.data?.playlists?.items || []).filter(p => 
          p && p.tracks && p.tracks.total > 10 && p.tracks.total < 200 // Filter for reasonable sized playlists
        );

        // Get tracks from the first few promising playlists
        for (const playlist of playlists.slice(0, 2)) {
          try {
            const tracksUrl = `https://api.spotify.com/v1/playlists/${playlist.id}/tracks?limit=20&market=US`;
            const tracksRes = await axios.get(tracksUrl, {
              headers: { Authorization: `Bearer ${token}` }
            });

            const tracks = (tracksRes.data?.items || [])
              .filter(item => item?.track && item.track.name && item.track.artists?.[0]?.name) // Filter valid tracks
              .map(item => ({
                name: `${item.track.name} – ${item.track.artists[0].name}`,
                url: `https://open.spotify.com/track/${item.track.id}`,
                energy: Math.max(0, Math.min(1, Math.random() * 0.4 + (vibesData.energy - 0.2))), // Clamp to 0-1
                valence: Math.max(0, Math.min(1, Math.random() * 0.4 + (vibesData.valence - 0.2))), // Clamp to 0-1
                popularity: item.track.popularity || 50
              }));

            allTracks.push(...tracks);
          } catch (playlistError) {
            console.error('Error fetching playlist tracks:', {
              status: playlistError.response?.status,
              statusText: playlistError.response?.statusText,
              data: playlistError.response?.data,
              message: playlistError.message,
              playlistId: playlist.id
            });
          }
        }
      } catch (searchError) {
        console.error('Full error object:', searchError);
        console.error('Error searching playlists:', {
          status: searchError.response?.status,
          statusText: searchError.response?.statusText,
          data: searchError.response?.data,
          message: searchError.message,
          code: searchError.code,
          query: query,
          hasResponse: !!searchError.response,
          errorKeys: Object.keys(searchError)
        });
      }
    }

    // Remove duplicates and sort by a combination of energy/valence match and popularity
    const uniqueTracks = allTracks.filter((track, index, self) => 
      index === self.findIndex(t => t.name === track.name)
    );

    // Score tracks based on target mood
    const scoredTracks = uniqueTracks.map(track => ({
      ...track,
      score: (
        (1 - Math.abs(track.energy - vibesData.energy)) * 0.4 +
        (1 - Math.abs(track.valence - vibesData.valence)) * 0.4 +
        (track.popularity / 100) * 0.2
      )
    }));

    // Sort by score and return top 15
    const selectedTracks = scoredTracks
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    if (selectedTracks.length === 0) {
      // Fallback: search for popular tracks by genre
      const genreQuery = vibesData.seed_genres[0];
      const fallbackUrl = `https://api.spotify.com/v1/search?q=genre:"${genreQuery}"&type=track&limit=15&market=US`;
      const fallbackRes = await axios.get(fallbackUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });

      return (fallbackRes.data?.tracks?.items || [])
        .filter(t => t?.name && t?.artists?.[0]?.name)
        .map(t => ({
          name: `${t.name} – ${t.artists[0].name}`,
          url: `https://open.spotify.com/track/${t.id}`,
          energy: vibesData.energy,
          valence: vibesData.valence
        }));
    }

    return selectedTracks;
  } catch (error) {
    console.error('Spotify API error:', error.response?.status, error.response?.data);
    throw error;
  }
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
