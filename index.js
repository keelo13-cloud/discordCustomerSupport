/**
 * Madden Academy — Discord → n8n Webhook Proxy
 * 
 * Connects to Discord via WebSocket (using discord.js),
 * listens for all message events (DMs + guild channels),
 * and forwards them to your n8n webhook URL.
 * 
 * Deploy on Railway. Set environment variables in Railway dashboard.
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');

// ── Config ──────────────────────────────────────────────────────────────────
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const N8N_WEBHOOK_URL   = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET      = process.env.PROXY_SECRET || '';   // optional shared secret

if (!DISCORD_BOT_TOKEN) throw new Error('Missing env: DISCORD_BOT_TOKEN');
if (!N8N_WEBHOOK_URL)   throw new Error('Missing env: N8N_WEBHOOK_URL');
// ────────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // requires privileged intent in Dev Portal
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel,   // required to receive DMs
    Partials.Message,
  ],
});

client.once('ready', () => {
  console.log(`[proxy] Logged in as ${client.user.tag}`);
  console.log(`[proxy] Forwarding events to: ${N8N_WEBHOOK_URL}`);
});

client.on('messageCreate', async (message) => {
  // Ignore other bots
  if (message.author.bot) return;

  const isDM = message.channel.type === 1; // ChannelType.DM = 1

  const payload = {
    id:           message.id,
    content:      message.content,
    channel_id:   message.channelId,
    channel_type: message.channel.type,
    guild_id:     message.guildId || null,
    author: {
      id:            message.author.id,
      username:      message.author.username,
      discriminator: message.author.discriminator,
      bot:           message.author.bot,
    },
    timestamp:    message.createdAt.toISOString(),
    is_dm:        isDM,
    surface:      isDM ? 'dm' : 'channel',
    // Include channel name for guild messages (helpful for EOD reports)
    channel_name: isDM ? 'DM' : (message.channel.name || 'unknown'),
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (PROXY_SECRET) {
    headers['x-proxy-secret'] = PROXY_SECRET;
  }

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method:  'POST',
        headers,
        body:    JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`[proxy] Forwarded message from ${message.author.username} (${isDM ? 'DM' : '#' + payload.channel_name})`);
        break; // success — stop retrying
      }

      const responseText = await response.text();
      console.error(`[proxy] Attempt ${attempt}/${MAX_ATTEMPTS} — n8n returned ${response.status}: ${responseText}`);

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[proxy] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error(`[proxy] All ${MAX_ATTEMPTS} attempts failed for message ${payload.id} from ${message.author.username}. Message lost.`);
      }

    } catch (err) {
      console.error(`[proxy] Attempt ${attempt}/${MAX_ATTEMPTS} — network error: ${err.message}`);

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[proxy] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        console.error(`[proxy] All ${MAX_ATTEMPTS} attempts failed for message ${payload.id}. Message lost.`);
      }
    }
  }
});

client.on('error', (err) => {
  console.error('[proxy] Discord client error:', err.message);
});

client.login(DISCORD_BOT_TOKEN);
