/**
 * Madden Academy — Discord → n8n Webhook Proxy
 * With private thread creation for support channel messages
 */

const { Client, GatewayIntentBits, Partials, ChannelType, Events } = require('discord.js');

const DISCORD_BOT_TOKEN    = process.env.DISCORD_BOT_TOKEN;
const N8N_WEBHOOK_URL      = process.env.N8N_WEBHOOK_URL;
const PROXY_SECRET         = process.env.PROXY_SECRET || '';
const SUPPORT_CHANNEL_ID   = process.env.SUPPORT_CHANNEL_ID || ''; // channel where support starts

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
  console.log(`[proxy] Support channel ID: ${SUPPORT_CHANNEL_ID || '(not set — all channels forwarded)'}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots
  if (message.author?.bot) return;

  // Ignore messages already inside a thread (we only want the first message)
  // Thread types: PublicThread=11, PrivateThread=12, AnnouncementThread=10
  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(message.channel?.type);

  // If this message is inside a thread that the bot created, forward it to n8n
  // so the conversation can continue. Check if parent is the support channel.
  if (isThread) {
    const parentId = message.channel?.parentId;
    // Only forward thread messages if they're in our support channel's threads
    if (SUPPORT_CHANNEL_ID && parentId !== SUPPORT_CHANNEL_ID) return;

    console.log(`[proxy] Raw event (thread): author=${message.author?.username}, content="${message.content?.substring(0, 50)}"`);
    await forwardToN8n(message, message.channelId, false);
    return;
  }

  const isDM = message.channel.type === ChannelType.DM;

  // For guild (server) channel messages — create a private thread first
  if (!isDM && message.channelId) {
    // If SUPPORT_CHANNEL_ID is set, only handle messages in that channel
    if (SUPPORT_CHANNEL_ID && message.channelId !== SUPPORT_CHANNEL_ID) {
      console.log(`[proxy] Ignoring message in non-support channel #${message.channel?.name}`);
      return;
    }

    console.log(`[proxy] Raw event (channel): author=${message.author?.username}, content="${message.content?.substring(0, 50)}"`);

    try {
      // Create a PRIVATE thread from this message
      const thread = await message.startThread({
        name: `Support — ${message.author.username}`,
        autoArchiveDuration: 1440, // auto-archive after 24 hours of inactivity
        type: ChannelType.PrivateThread,
        reason: 'Madden Academy support thread',
      });

      console.log(`[proxy] Created private thread: ${thread.id} for ${message.author.username}`);

      // Forward to n8n using the THREAD id as channel_id so the bot replies inside it
      await forwardToN8n(message, thread.id, false);

    } catch (err) {
      console.error(`[proxy] Failed to create thread: ${err.message}`);
      // Fall back to replying in the original channel
      await forwardToN8n(message, message.channelId, false);
    }

    return;
  }

  // DM handling
  if (isDM) {
    console.log(`[proxy] Raw event (DM): author=${message.author?.username}, content="${message.content?.substring(0, 50)}"`);
    await forwardToN8n(message, message.channelId, true);
  }
});

async function forwardToN8n(message, replyChannelId, isDM) {
  // Fetch partial if needed
  if (message.partial) {
    try { await message.fetch(); } catch (e) {
      console.error('[proxy] Failed to fetch partial:', e.message);
      return;
    }
  }

  const payload = {
    id:               message.id,
    content:          message.content,
    channel_id:       replyChannelId,       // thread ID for channel messages, DM channel for DMs
    original_channel_id: message.channelId, // original channel the message was sent in
    channel_type:     message.channel.type,
    guild_id:         message.guildId || null,
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
        console.log(`[proxy] Forwarded from ${message.author.username} (${isDM ? 'DM' : '#' + payload.channel_name}) → reply channel: ${replyChannelId}`);
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
        console.error(`[proxy] All attempts failed. Message lost.`);
      }
    }
  }
}

client.on(Events.Error, (err) => {
  console.error('[proxy] Discord client error:', err.message);
});

client.login(DISCORD_BOT_TOKEN);
