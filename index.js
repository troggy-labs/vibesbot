import 'dotenv/config';
import axios from 'axios';
import { App, ExpressReceiver } from '@slack/bolt';

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events' // matches the URL you gave Slack
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

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

async function getTracks(query) {
  const token = await getSpotifyToken();
  const res = await axios.get(
    'https://api.spotify.com/v1/search',
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: query, type: 'track', limit: 10, market: 'US' }
    }
  );
  return res.data.tracks.items.map(t => ({
    name: `${t.name} – ${t.artists[0].name}`,
    url: `https://open.spotify.com/track/${t.id}`
  }));
}

// ——— Slash command handler ———
app.command('/vibes', async ({ command, ack, say, client }) => {
  await ack({ text: 'Cooking up a playlist… check your DMs!' });

  const tracks = await getTracks(command.text || 'happy hits');
  const blocks = tracks.flatMap(t => [
    { type: 'section', text: { type: 'mrkdwn', text: `<${t.url}|${t.name}>` } },
    { type: 'divider' }
  ]);

  // DM user
  const im = await client.conversations.open({ users: command.user_id });
  await client.chat.postMessage({
    channel: im.channel.id,
    text: 'Here are your vibes! 🎧',
    blocks
  });
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Vibes bot is running!');
})();
