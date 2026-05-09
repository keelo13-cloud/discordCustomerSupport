/**
 * Madden Academy — Discord → n8n Webhook Proxy
 * DM-based support: deletes channel message, moves convo to DMs
 * + Twitter draft approval buttons
 */

const { Client, GatewayIntentBits, Partials, ChannelType, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');

const DISCORD_BOT_TOKEN    = process.env.DISCORD_BOT_TOKEN;
const N8N_WEBHOOK_URL      = process.env.N8N_WEBHOOK_URL;
const N8N_APPROVAL_WEBHOOK = process.env.N8N_APPROVAL_WEBHOOK; // new webhook for button interactions
const PROXY_SECRET         = process.env.PROXY_SECRET || '';
const SUPPORT_CHANNEL_ID   = process.env.SUPPORT_CHANNEL_ID || '';
const PORT                 = process.env.PORT || 3000;

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

// ─── Express server for n8n to call when sending draft ───────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

/**
 * POST /send-draft
 * Called by n8n to send the Twitter draft with approval buttons to Discord
 * Body: { channelId, fileName, draft, tweetId (optional), driveFileId (optional) }
 */
app.post('/send-draft', async (req, res) => {
  const { channelId, fileName, draft, tweetId, driveFileId } = req.body;

  if (!channelId || !draft) {
    return res.status(400).json({ error: 'Missing channelId or draft' });
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    // Truncate draft for embed (Discord limit 4096 chars)
    const truncated = draft.length > 3800
      ? draft.substring(0, 3800) + '\n\n...(truncated)'
      : draft;

    const embed = new EmbedBuilder()
      .setTitle('🎬 New Twitter Draft Ready for Review')
      .setColor(0x3498DB)
      .setDescription(`**📁 Source file:** \`${fileName || 'Unknown'}\`\n\n---\n\n${truncated}`)
      .setFooter({ text: 'Click Approve to post or Reject to discard' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_draft::${tweetId || ''}::${driveFileId || ''}`)
        .setLabel('✅ APPROVE')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_draft::${tweetId || ''}`)
        .setLabel('❌ REJECT')
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      content: `<@366635705964953601> 📋 **New long-form Twitter draft generated from video upload.**`,
      embeds: [embed],
      components: [row],
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[draft] Error sending draft:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[express] Server running on port ${PORT}`));

// ─── Button interaction handler ───────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, tweetId, driveFileId] = interaction.customId.split('::');

  if (action === 'approve_draft') {
    // Acknowledge immediately to avoid Discord timeout
    await interaction.update({
      content: `✅ **Approved by ${interaction.user.username}!** Processing video upload...`,
      embeds: interaction.message.embeds,
      components: [], // remove buttons
    });

    // Forward approval to n8n
    if (N8N_APPROVAL_WEBHOOK) {
      try {
        await fetch(N8N_APPROVAL_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'approve',
            tweetId,
            driveFileId,
            approvedBy: interaction.user.username,
            timestamp: new Date().toISOString(),
          }),
        });
        console.log(`[interaction] Approval forwarded to n8n for tweet ${tweetId}`);
      } catch (err) {
        console.error('[interaction] Failed to forward approval to n8n:', err.message);
      }
    }

  } else if (action === 'reject_draft') {
    await interaction.update({
      content: `❌ **Rejected by ${interaction.user.username}.** Draft discarded.`,
      embeds: interaction.message.embeds,
      components: [], // remove buttons
    });

    // Optionally notify n8n of rejection too
    if (N8N_APPROVAL_WEBHOOK) {
      try {
        await fetch(N8N_APPROVAL_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'reject',
            tweetId,
            driveFileId,
            rejectedBy: interaction.user.username,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.error('[interaction] Failed to forward rejection to n8n:', err.message);
      }
    }
  }
});

// ─── Existing support bot logic (unchanged) ───────────────────────────────────
client.once(Events.ClientReady, (readyClient) => {
  console.log(`[proxy] Logged in as ${readyClient.user.tag}`);
  console.log(`[proxy] Forwarding events to: ${N8N_WEBHOOK_URL}`);
  console.log(`[proxy] Watching for messages in ${readyClient.guilds.cache.size} server(s)`);
  console.log(`[proxy] Support channel ID: ${SUPPORT_CHANNEL_ID || '(not set)'}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author?.bot) return;

  const isDM = message.channel.type === ChannelType.DM;

  if (isDM) {
    console.log(`[proxy] DM from ${message.author.username}`);
    await forwardToN8n(message, message.channelId, true);
    return;
  }

  if (SUPPORT_CHANNEL_ID && message.channelId !== SUPPORT_CHANNEL_ID) {
    console.log(`[proxy] Ignoring message in non-support channel #${message.channel?.name}`);
    return;
  }

  console.log(`[proxy] Support message from ${message.author.username} in #${message.channel?.name}`);

  try {
    await message.delete();
    console.log(`[proxy] Deleted original message from #${message.channel?.name}`);
  } catch (err) {
    console.error(`[proxy] Could not delete message: ${err.message}`);
  }

  try {
    const dmChannel = await message.author.createDM();
    await dmChannel.send(
      `Hey ${message.author.username}! 👋 Thanks for reaching out to **The Madden Academy** support.\n\nI got your message and I'm here to help. What's going on?`
    );
    console.log(`[proxy] Opened DM with ${message.author.username}`);
    await forwardToN8n(message, dmChannel.id, true);
  } catch (err) {
    console.error(`[proxy] Could not open DM with ${message.author.username}: ${err.message}`);
    try {
      const fallback = await message.channel.send(
        `Hey ${message.author.username}, I tried to DM you but your DMs appear to be closed. Please enable DMs from server members in your Privacy Settings and try again!`
      );
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
