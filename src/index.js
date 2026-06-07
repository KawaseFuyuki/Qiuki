import { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, ActivityType } from 'discord.js';
import postgres from 'postgres';
import express from 'express';

const app = express();
app.get('/', (req, res) => res.send('Qiuki Bot is running!'));
app.listen(process.env.PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });
const prefix = 'qi';
const invites = new Map();

// ===== DATABASE SETUP =====
async function setupDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      tracker_channel TEXT,
      disabled_channels TEXT[] DEFAULT '{}',
      message_channels TEXT[] DEFAULT '{}'
    )
  `;

  // Fix for existing tables missing columns
  await sql`ALTER TABLE guilds ADD COLUMN IF NOT EXISTS disabled_channels TEXT[] DEFAULT '{}';`;
  await sql`ALTER TABLE guilds ADD COLUMN IF NOT EXISTS message_channels TEXT[] DEFAULT '{}';`;
  await sql`ALTER TABLE guilds ADD COLUMN IF NOT EXISTS tracker_channel TEXT;`;

  await sql`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      user_id TEXT,
      joins INTEGER DEFAULT 0,
      leftcount INTEGER DEFAULT 0,
      fake INTEGER DEFAULT 0,
      rejoins INTEGER DEFAULT 0
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS invite_users (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      inviter_id TEXT,
      member_id TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      user_id TEXT,
      total INTEGER DEFAULT 0
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS daily_messages (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      user_id TEXT,
      date TEXT,
      count INTEGER DEFAULT 0
    )
  `;

  console.log('✅ Database setup complete');
}

// ===== EMBED HELPER - GREEN COLOR =====
function makeEmbed(title, desc, user) {
  const time = new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const embed = new EmbedBuilder()
.setColor('#00FF00')
.setFooter({ text: `created by kitaryo | Today at ${time}` });

  if (title) embed.setTitle(title);
  if (desc) embed.setDescription(desc);
  if (user) embed.setThumbnail(user.displayAvatarURL());

  return embed;
}

// ===== GET DATA =====
async function getInviteData(guildId, userId) {
  const id = `${guildId}-${userId}`;
  const [data] = await sql`SELECT * FROM invites WHERE id = ${id}`;
  return {
    joins: data?.joins || 0,
    leftCount: data?.leftcount || 0,
    fake: data?.fake || 0,
    rejoins: data?.rejoins || 0
  };
}

async function getMessageData(guildId, userId) {
  const id = `${guildId}-${userId}`;
  const [totalData] = await sql`SELECT total FROM messages WHERE id = ${id}`;
  const today = new Date().toISOString().split('T')[0];
  const todayId = `${guildId}-${userId}-${today}`;
  const [todayData] = await sql`SELECT count FROM daily_messages WHERE id = ${todayId}`;

  return {
    total: totalData?.total || 0,
    today: todayData?.count || 0
  };
}

// ===== BOT READY =====
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await setupDB();
  client.user.setActivity('watching anime for fun xD', { type: ActivityType.Watching });

  for (const guild of client.guilds.cache.values()) {
    try {
      const guildInvites = await guild.invites.fetch();
      invites.set(guild.id, new Map(guildInvites.map(inv => [inv.code, inv.uses])));
    } catch {}
  }
});

// ===== INVITE TRACKER =====
client.on('guildMemberAdd', async member => {
  const cachedInvites = invites.get(member.guild.id);
  const newInvites = await member.guild.invites.fetch();
  const usedInvite = newInvites.find(inv => inv.uses > (cachedInvites?.get(inv.code) || 0));

  if (usedInvite && usedInvite.inviter) {
    const inviterId = usedInvite.inviter.id;
    const id = `${member.guild.id}-${inviterId}`;

    await sql`
      INSERT INTO invites (id, guild_id, user_id, joins)
      VALUES (${id}, ${member.guild.id}, ${inviterId}, 1)
      ON CONFLICT (id) DO UPDATE SET joins = invites.joins + 1
    `;

    await sql`
      INSERT INTO invite_users (id, guild_id, inviter_id, member_id)
      VALUES (${`${member.guild.id}-${member.id}`}, ${member.guild.id}, ${inviterId}, ${member.id})
    `;

    const [guildData] = await sql`SELECT tracker_channel FROM guilds WHERE guild_id = ${member.guild.id}`;
    if (guildData?.tracker_channel) {
      const channel = member.guild.channels.cache.get(guildData.tracker_channel);
      const data = await getInviteData(member.guild.id, inviterId);
      const total = data.joins - data.leftCount;

      const embed = makeEmbed(null, `<@${inviterId}> invited ${member.user} now he have **${total}** invite${total!== 1? 's' : ''}`);
      channel?.send({ embeds: [embed] });
    }
  }

  invites.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses])));
});

client.on('guildMemberRemove', async member => {
  const [data] = await sql`
    SELECT inviter_id FROM invite_users
    WHERE guild_id = ${member.guild.id} AND member_id = ${member.id}
  `;

  if (data?.inviter_id) {
    const id = `${member.guild.id}-${data.inviter_id}`;
    await sql`UPDATE invites SET leftcount = leftcount + 1 WHERE id = ${id}`;
    await sql`DELETE FROM invite_users WHERE guild_id = ${member.guild.id} AND member_id = ${member.id}`;
  }
});

// ===== MESSAGE TRACKER =====
client.on('messageCreate', async message => {
  if (message.author.bot ||!message.guild) return;

  const guildId = message.guild.id;
  const userId = message.author.id;
  const channelId = message.channel.id;

  const [guildData] = await sql`SELECT * FROM guilds WHERE guild_id = ${guildId}`;

  const messageChannels = guildData?.message_channels || [];
  const shouldCount = messageChannels.length === 0 || messageChannels.includes(channelId);

  if (shouldCount) {
    const id = `${guildId}-${userId}`;
    const today = new Date().toISOString().split('T')[0];
    const todayId = `${guildId}-${userId}-${today}`;

    await sql`
      INSERT INTO messages (id, guild_id, user_id, total)
      VALUES (${id}, ${guildId}, ${userId}, 1)
      ON CONFLICT (id) DO UPDATE SET total = messages.total + 1
    `;

    await sql`
      INSERT INTO daily_messages (id, guild_id, user_id, date, count)
      VALUES (${todayId}, ${guildId}, ${userId}, ${today}, 1)
      ON CONFLICT (id) DO UPDATE SET count = daily_messages.count + 1
    `;
  }

  if (!message.content.toLowerCase().startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ping') {
    const embed = makeEmbed('🏓 Pong!', `Latency: **${client.ws.ping}ms**`);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'help') {
    const embed = makeEmbed('Qiuki Commands', null);
    embed.addFields([
      { name: '📨 Invites', value: '`qi i` - Your invites\n`qi invited @user` - User invite list\n`qi lb i` - Invite leaderboard', inline: false },
      { name: '💬 Messages', value: '`qi m` - Your messages\n`qi lb m` - Message leaderboard', inline: false },
      { name: '⚙️ Admin - Invites', value: '`qi reset i @user` - Reset user invites\n`qi reset all` - Reset all invites\n`qi enable it` - Enable tracker here\n`qi disable it` - Disable tracker', inline: false },
      { name: '⚙️ Admin - Messages', value: '`qi reset m @user` - Reset user messages\n`qi reset m all` - Reset all messages\n`qi enable m` - Enable msg count here\n`qi disable m` - Disable msg count here', inline: false },
      { name: '⚙️ Admin - Channels', value: '`qi enable` - Enable bot in this channel\n`qi disable` - Disable bot in this channel', inline: false }
    ]);
    return message.reply({ embeds: [embed] });
  }

  const disabledChannels = guildData?.disabled_channels || [];
  if (disabledChannels.includes(channelId) &&!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return;
  }

  if (command === 'enable' &&!args[0]) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`
      INSERT INTO guilds (guild_id, disabled_channels)
      VALUES (${guildId}, '{}')
      ON CONFLICT (guild_id) DO UPDATE SET
      disabled_channels = array_remove(guilds.disabled_channels, ${channelId})
    `;
    const embed = makeEmbed(null, '✅ Bot commands enabled in this channel!');
    return message.reply({ embeds: [embed] });
  }

  if (command === 'disable' &&!args[0]) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`
      INSERT INTO guilds (guild_id, disabled_channels)
      VALUES (${guildId}, ARRAY[${channelId}])
      ON CONFLICT (guild_id) DO UPDATE SET
      disabled_channels = array_append(guilds.disabled_channels, ${channelId})
    `;
    const embed = makeEmbed(null, '❌ Bot commands disabled in this channel!');
    return message.reply({ embeds: [embed] });
  }

  if (command === 'enable' && args[0] === 'm') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`
      INSERT INTO guilds (guild_id, message_channels)
      VALUES (${guildId}, ARRAY[${channelId}])
      ON CONFLICT (guild_id) DO UPDATE SET
      message_channels = array_append(guilds.message_channels, ${channelId})
    `;
    const embed = makeEmbed(null, `✅ Message counting enabled in ${message.channel}`);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'disable' && args[0] === 'm') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`
      INSERT INTO guilds (guild_id, message_channels)
      VALUES (${guildId}, '{}')
      ON CONFLICT (guild_id) DO UPDATE SET
      message_channels = array_remove(guilds.message_channels, ${channelId})
    `;
    const embed = makeEmbed(null, `❌ Message counting disabled in ${message.channel}`);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'enable' && args[0] === 'it') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`
      INSERT INTO guilds (guild_id, tracker_channel)
      VALUES (${guildId}, ${channelId})
      ON CONFLICT (guild_id) DO UPDATE SET tracker_channel = ${channelId}
    `;
    const embed = makeEmbed(null, `✅ Invite tracker enabled in ${message.channel}`);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'disable' && args[0] === 'it') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`UPDATE guilds SET tracker_channel = NULL WHERE guild_id = ${guildId}`;
    const embed = makeEmbed(null, '❌ Invite tracker disabled!');
    return message.reply({ embeds: [embed] });
  }

  if (command === 'i' || command === 'invites') {
    const target = message.mentions.users.first() || message.author;
    const data = await getInviteData(guildId, target.id);
    const total = data.joins - data.leftCount;

    const embed = makeEmbed('Invite log', null, target);
    embed.setDescription(`▶ **${target.username}** has **${total}** invites\n\n**Joins :** ${data.joins}\n**Left :** ${data.leftCount}\n**Fake :** ${data.fake}\n**Rejoins :** ${data.rejoins} (7d)`);

    return message.reply({ embeds: [embed] });
  }

  if (command === 'invited') {
    const target = message.mentions.users.first() || message.author;
    const invitedUsers = await sql`
      SELECT member_id FROM invite_users
      WHERE guild_id = ${guildId} AND inviter_id = ${target.id}
      LIMIT 10
    `;

    const list = invitedUsers.map((u, i) => `#${i+1} • <@${u.member_id}>`).join('\n') || 'No invited users';
    const embed = makeEmbed(`Invited list of ${target.username}`, null);
    embed.addFields([{ name: 'Members', value: list, inline: false }]);

    return message.reply({ embeds: [embed] });
  }

  if (command === 'lb' && args[0] === 'i') {
    const top = await sql`
      SELECT user_id, joins, leftcount, fake, rejoins
      FROM invites WHERE guild_id = ${guildId}
      ORDER BY (joins - leftcount) DESC LIMIT 10
    `;

    const list = top.map((u, i) => {
      const total = u.joins - u.leftcount;
      return `#${i+1} <@${u.user_id}> • **${total}** Invites (${u.joins} Joins, ${u.leftcount} Leaves, ${u.fake} Fakes, ${u.rejoins} Rejoins)`;
    }).join('\n') || 'No data';

    const embed = makeEmbed('Invite Leaderboard', null);
    embed.addFields([{ name: 'Top 10', value: list }]);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'm' || command === 'messages') {
    const target = message.mentions.users.first() || message.author;
    const data = await getMessageData(guildId, target.id);

    const embed = makeEmbed(`${target.username}'s Messages`, null, target);
    embed.addFields([
      { name: 'All time', value: `${data.total} messages in this server!`, inline: false },
      { name: 'Today', value: `${data.today} messages in this server`, inline: false },
      { name: 'Status', value: 'Messages are being updated in real-time', inline: false }
    ]);

    return message.reply({ embeds: [embed] });
  }

  if (command === 'lb' && args[0] === 'm') {
    const top = await sql`
      SELECT user_id, total FROM messages
      WHERE guild_id = ${guildId}
      ORDER BY total DESC LIMIT 10
    `;

    const list = top.map((u, i) => `#${i+1} <@${u.user_id}> • **${u.total}** messages`).join('\n') || 'No data';
    const embed = makeEmbed('Message Leaderboard', null);
    embed.addFields([{ name: 'Top 10', value: list }]);
    return message.reply({ embeds: [embed] });
  }

  if (command === 'reset' && args[0] === 'i') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return message.reply('You need Manage Server permission!');
    }

    const target = message.mentions.users.first();
    if (target) {
      await sql`DELETE FROM invites WHERE guild_id = ${guildId} AND user_id = ${target.id}`;
      const embed = makeEmbed(null, `✅ Reset invite data for ${target.username}`);
      return message.reply({ embeds: [embed] });
    }
    return message.reply('Usage: `qi reset i @user`');
  }

  if (command === 'reset' && args[0] === 'all') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`DELETE FROM invites WHERE guild_id = ${guildId}`;
    await sql`DELETE FROM invite_users WHERE guild_id = ${guildId}`;
    const embed = makeEmbed(null, '✅ Reset all invite data for this server.');
    return message.reply({ embeds: [embed] });
  }

  if (command === 'reset' && args[0] === 'm') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return message.reply('You need Manage Server permission!');
    }

    const target = message.mentions.users.first();
    if (target) {
      await sql`DELETE FROM messages WHERE guild_id = ${guildId} AND user_id = ${target.id}`;
      await sql`DELETE FROM daily_messages WHERE guild_id = ${guildId} AND user_id = ${target.id}`;
      const embed = makeEmbed(null, `✅ Reset message data for ${target.username}`);
      return message.reply({ embeds: [embed] });
    } else if (args[1] === 'all') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('You need Administrator permission!');
      }
      await sql`DELETE FROM messages WHERE guild_id = ${guildId}`;
      await sql`DELETE FROM daily_messages WHERE guild_id = ${guildId}`;
      const embed = makeEmbed(null, '✅ Reset all message data for this server.');
      return message.reply({ embeds: [embed] });
    }
    return message.reply('Usage: `qi reset m @user` or `qi reset m all`');
  }
});

client.login(process.env.TOKEN);
