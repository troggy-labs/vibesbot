# VibesBot 🎵

A Slack bot that transforms fuzzy feelings into curated playlists using AI-powered text parsing and Spotify's music catalog.

## What it does

VibesBot takes free-form descriptions of moods and moments and creates personalized playlists:

- **"sad indie coffee-shop at 2 a.m."** → A melancholy playlist with sparse indie tracks
- **"Friday wind-down after a long week"** → Chill, relaxing tunes perfect for unwinding
- **"Monday morning motivation"** → Upbeat tracks to power through the day

## Features

### 🧠 Smart Text Parsing
Uses OpenAI to convert vague descriptions into precise music parameters:
- Mood analysis (melancholy, energetic, chill)
- Genre identification (indie, rock, electronic, etc.)
- Energy levels, tempo, and emotional valence

### 🎯 Context Awareness
Enriches recommendations with:
- Current day of week and time
- User's recent Slack messages for additional context
- Makes playlists feel "psychic" without extra input

### 🎨 Visual Enhancement
- Generates custom DALL-E cover art for each playlist
- Creative playlist names and descriptions
- Professional presentation in Slack

### 🎵 Intelligent Curation
- Sources music from Spotify's vast catalog
- Orders tracks to tell a "story" (slow → upbeat)
- Filters and scores tracks based on mood matching

## Setup

### Prerequisites
- Node.js 18+
- Slack workspace admin access
- Spotify Developer account
- OpenAI API access

### Environment Variables
```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
OPENAI_API_KEY=your-openai-api-key
PORT=3000
```

### Slack App Configuration
1. Create a new Slack app at [api.slack.com](https://api.slack.com/apps)
2. Add these OAuth scopes:
   - `chat:write`
   - `im:write`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `commands`
3. Create a slash command `/vibes`
4. Set request URL to your deployment endpoint + `/slack/events`
5. Install the app to your workspace

### Spotify App Setup
1. Create an app at [developer.spotify.com](https://developer.spotify.com/dashboard)
2. Note your Client ID and Client Secret
3. No redirect URIs needed (using Client Credentials flow)

### Deployment
The bot includes Express.js server setup and can be deployed to:
- Render, Railway, or Heroku
- Docker containers
- VPS with PM2

## Usage

In any Slack channel where the bot is present:

```
/vibes melancholy rainy Sunday afternoon
/vibes pump-up gym playlist
/vibes late night coding session
/vibes roadtrip with friends
```

The bot will:
1. Analyze your text and current context
2. Generate a custom playlist with AI-powered curation
3. Create cover art and send results via DM
4. Present tracks with Spotify links for easy listening

## Technical Architecture

- **Text Processing**: OpenAI GPT-4o-mini for natural language understanding
- **Music Discovery**: Spotify Web API for playlist and track search
- **Image Generation**: DALL-E 3 for custom cover art
- **Context Gathering**: Slack API for temporal and conversational context
- **Hosting**: Express.js server with Slack Bolt framework

## Contributing

Pull requests welcome! Areas for improvement:
- Additional streaming service integrations
- More sophisticated music analysis
- Playlist export to streaming services
- Enhanced context awareness

## License

MIT License - see LICENSE file for details