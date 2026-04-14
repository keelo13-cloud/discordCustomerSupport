/**
 * Madden Academy — Discord → n8n Webhook Proxy
 * Fixed for discord.js v14: uses Events enum and ChannelType enum
 */

const { Client, GatewayIntentBits, Partials, ChannelType, Events } = require('discord.js');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const N8N_WEBHOOK_URL   = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET      = process.env.PROXY_SECRET || '';

if (!DISCORD_BOT_TOKEN) throw new Error('Missing env: DISCORD_BOT_TOKEN');
if (!N8N_WEBHOOK_URL)   throw new Error('Missing env: N8N_WEBHOOK_URL');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [
    Partials.Channel,    // REQUIRED for DMs — without this DM events are silently dropped
    Partials.Message,
    Partials.User,
  ],
});

// Use Events.ClientReady (discord.js v14 — 'ready' is deprecated)
client.once(Events.ClientReady, (readyClient) => {
  console.log(`[proxy] Logged in as ${readyClient.user.tag}`);
  console.log(`[proxy] Forwarding events to: ${N8N_WEBHOOK_URL}`);
  console.log(`[proxy] Watching for messages in ${readyClient.guilds.cache.size} server(s)`);
});

// Use Events.MessageCreate (discord.js v14)
client.on(Events.MessageCreate, async (message) => {
  // Debug: log every raw event so we can confirm receipt
  console.log(`[proxy] Raw event: author=${message.author?.username}, bot=${message.author?.bot}, channelType=${message.channel?.type}, content="${message.content?.substring(0, 50)}"`);

  // Ignore bots
  if (message.author?.bot) return;

  // Fetch partial messages/channels (required for DMs with Partials)
  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      console.error('[proxy] Failed to fetch partial message:', err.message);
      return;
    }
  }

  // Use ChannelType enum (discord.js v14)
  const isDM = message.channel.type === ChannelType.DM;

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
    channel_name: isDM ? 'DM' : (message.channel.name || 'unknown'),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (PROXY_SECRET) headers['x-proxy-secret'] = PROXY_SECRET;

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers,
        body:   JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`[proxy] Forwarded from ${message.author.username} (${isDM ? 'DM' : '#' + payload.channel_name})`);
        break;
      }

      const responseText = await response.text();
      console.error(`[proxy] Attempt ${attempt}/${MAX_ATTEMPTS} — n8n returned ${response.status}: ${responseText}`);

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[proxy] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(`[proxy] All attempts failed for message ${payload.id}. Message lost.`);
      }

    } catch (err) {
      console.error(`[proxy] Attempt ${attempt}/${MAX_ATTEMPTS} — network error: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(`[proxy] All attempts failed for message ${payload.id}. Message lost.`);
      }
    }
  }
});

client.on(Events.Error, (err) => {
  console.error('[proxy] Discord client error:', err.message);
});

client.login(DISCORD_BOT_TOKEN);
