/**
 * Madden Academy — Discord → n8n Webhook Proxy
 * DM-based support: deletes channel message, moves convo to DMs
 */

const { Client, GatewayIntentBits, Partials, ChannelType, Events } = require('discord.js');

const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const N8N_WEBHOOK_URL    = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET       = process.env.PROXY_SECRET || '';
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID || '';

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
    Partials.Channel,
    Partials.Message,
    Partials.User,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[proxy] Logged in as ${readyClient.user.tag}`);
  console.log(`[proxy] Forwarding events to: ${N8N_WEBHOOK_URL}`);
  console.log(`[proxy] Watching for messages in ${readyClient.guilds.cache.size} server(s)`);
  console.log(`[proxy] Support channel ID: ${SUPPORT_CHANNEL_ID || '(not set)'}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots
  if (message.author?.bot) return;

  const isDM = message.channel.type === ChannelType.DM;

  // Handle DM messages — forward directly to n8n
  if (isDM) {
    console.log(`[proxy] DM from ${message.author.username}`);
    await forwardToN8n(message, message.channelId, true);
    return;
  }

  // Handle support channel messages
  if (SUPPORT_CHANNEL_ID && message.channelId !== SUPPORT_CHANNEL_ID) {
    console.log(`[proxy] Ignoring message in non-support channel #${message.channel?.name}`);
    return;
  }

  console.log(`[proxy] Support message from ${message.author.username} in #${message.channel?.name}`);

  // Step 1 — Delete the original message from the channel
  try {
    await message.delete();
    console.log(`[proxy] Deleted original message from #${message.channel?.name}`);
  } catch (err) {
    console.error(`[proxy] Could not delete message: ${err.message}`);
  }

  // Step 2 — Open a DM channel with the user
  try {
    const dmChannel = await message.author.createDM();

    // Step 3 — Send an intro message in the DM
    await dmChannel.send(
      `Hey ${message.author.username}! 👋 Thanks for reaching out to **The Madden Academy** support.\n\nI got your message and I'm here to help. What's going on?`
    );

    console.log(`[proxy] Opened DM with ${message.author.username}`);

    // Step 4 — Forward to n8n using the DM channel ID
    await forwardToN8n(message, dmChannel.id, true);

  } catch (err) {
    console.error(`[proxy] Could not open DM with ${message.author.username}: ${err.message}`);
    // Fallback — if DMs are closed, reply in channel briefly then delete
    try {
      const fallback = await message.channel.send(
        `Hey ${message.author.username}, I tried to DM you but your DMs appear to be closed. Please enable DMs from server members in your Privacy Settings and try again!`
      );
      // Auto-delete the fallback message after 10 seconds
      setTimeout(() => fallback.delete().catch(() => {}), 10000);
    } catch (e) {
      console.error(`[proxy] Could not send fallback message: ${e.message}`);
    }
  }
});

async function forwardToN8n(message, replyChannelId, isDM) {
  if (message.partial) {
    try { await message.fetch(); } catch (e) {
      console.error('[proxy] Failed to fetch partial:', e.message);
      return;
    }
  }

  const payload = {
    id:                  message.id,
    content:             message.content,
    channel_id:          replyChannelId,
    original_channel_id: message.channelId,
    channel_type:        message.channel.type,
    guild_id:            message.guildId || null,
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
        console.log(`[proxy] Forwarded from ${message.author.username} → reply channel: ${replyChannelId}`);
        break;
      }

      const responseText = await response.text();
      console.error(`[proxy] Attempt ${attempt}/${MAX_ATTEMPTS} — n8n returned ${response.status}: ${responseText}`);

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[proxy] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(`[proxy] All attempts failed. Message lost.`);
      }

    } catch (err) {
      console.error(`[proxy] Attempt ${attempt}/${MAX_ATTEMPTS} — network error: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error(`[proxy] All attempts failed. Message lost.`);
      }
    }
  }
}

client.on(Events.Error, (err) => {
  console.error('[proxy] Discord client error:', err.message);
});

client.login(DISCORD_BOT_TOKEN);
