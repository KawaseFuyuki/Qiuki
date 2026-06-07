import { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } from 'discord.js';
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './db/schema.js';
import { eq, and } from 'drizzle-orm';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ]
});

const sql = postgres(process.env.DATABASE_URL);
const db = drizzle(sql, { schema });
const PREFIX = 'qi ';
const invites = new Map();

// Auto-create tables on start
await sql`
CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  tracker_channel TEXT,
  disabled_all BOOLEAN DEFAULT FALSE,
  message_channels TEXT[] DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  user_id TEXT,
  joins INTEGER DEFAULT 0,
  leftCount INTEGER DEFAULT 0,
  fake INTEGER DEFAULT 0,
  rejoins INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invite_users (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  inviter_id TEXT,
  member_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  user_id TEXT,
  total INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_messages (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  user_id TEXT,
  date TEXT,
  count INTEGER DEFAULT 0
);
`;

function makeEmbed(title, desc, user) {
  return new EmbedBuilder()
.setColor('#00FF00')
.setTitle(title)
.setDescription(desc)
.setThumbnail(user.displayAvatarURL())
.setFooter({ text: `created by kitaryo | Today at ${new Date().toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit'})}` });
}

async function getInviteData(guildId, userId) {
  const id = `${guildId}-${userId}`;
  const [data] = await db.select().from(schema.invites).where(eq(schema.invites.id, id));
  return data || { joins: 0, leftCount: 0, fake: 0, rejoins: 0 };
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      const guildInvites = await guild.invites.fetch();
      invites.set(guild.id, new Map(guildInvites.map(inv => [inv.code, inv.uses])));
    } catch {}
  }
});

client.on('guildMemberAdd', async member => {
  const cachedInvites = invites.get(member.guild.id);
  const newInvites = await member.guild.invites.fetch();
  const usedInvite = newInvites.find(inv => inv.uses > (cachedInvites?.get(inv.code) || 0));

  if (usedInvite) {
    const inviterId = usedInvite.inviter.id;
    const id = `${member.guild.id}-${inviterId}`;
    const [data] = await db.select().from(schema.invites).where(eq(schema.invites.id, id));

    const existing = await db.select().from(schema.inviteUsers).where(and(
      eq(schema.inviteUsers.guildId, member.guild.id),
      eq(schema.inviteUsers.memberId, member.id)
    ));

    const isRejoin = existing.length > 0;
    const isFake = Date.now() - member.user.createdTimestamp < 7 * 24 * 60 * 60 * 1000;

    await db.insert(schema.invites).values({
      id, guildId: member.guild.id, userId: inviterId,
      joins: (data?.joins || 0) + 1,
      left: data?.left || 0,
      fake: (data?.fake || 0) + (isFake? 1 : 0),
      rejoins: (data?.rejoins || 0) + (isRejoin? 1 : 0)
    }).onConflictDoUpdate({
      target: schema.invites.id,
      set: {
        joins: (data?.joins || 0) + 1,
        fake: (data?.fake || 0) + (isFake? 1 : 0),
        rejoins: (data?.rejoins || 0) + (isRejoin? 1 : 0)
      }
    });

    if (!isRejoin) {
      await db.insert(schema.inviteUsers).values({
        id: `${member.guild.id}-${inviterId}-${member.id}`,
        guildId: member.guild.id, inviterId, memberId: member.id
      });
    }
  }

  invites.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses])));

  const [guild] = await db.select().from(schema.guilds).where(eq(schema.guilds.guildId, member.guild.id));
  if (guild?.trackerChannel) {
    const channel = member.guild.channels.cache.get(guild.trackerChannel);
    if (channel) {
      const embed = new EmbedBuilder()
  .setColor('#00FF00')
  .setTitle('▶ New Member Joined')
  .addFields(
          { name: 'Member', value: `${member}`, inline: false },
          { name: 'Invited by', value: usedInvite? `${usedInvite.inviter}` : 'Unknown', inline: false },
          { name: 'Joined', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: false }
        )
  .setFooter({ text: `created by kitaryo | Today at ${new Date().toLocaleTimeString()}` });
      channel.send({ embeds: [embed] });
    }
  }
});

client.on('guildMemberRemove', async member => {
  const [record] = await db.select().from(schema.inviteUsers).where(and(
    eq(schema.inviteUsers.guildId, member.guild.id),
    eq(schema.inviteUsers.memberId, member.id)
  ));

  if (record) {
    const id = `${member.guild.id}-${record.inviterId}`;
    const [data] = await db.select().from(schema.invites).where(eq(schema.invites.id, id));
    if (data) await db.update(schema.invites).set({ left: data.left + 1 }).where(eq(schema.invites.id, id));
  }
});

client.on('messageCreate', async msg => {
  if (msg.author.bot ||!msg.guild) return;

  const [guild] = await db.select().from(schema.guilds).where(eq(schema.guilds.guildId, msg.guild.id));

  if (guild?.messageChannels?.includes(msg.channel.id)) {
    const id = `${msg.guild.id}-${msg.author.id}`;
    const today = new Date().toISOString().slice(0, 10);
    const dailyId = `${id}-${today}`;

    const [msgData] = await db.select().from(schema.messages).where(eq(schema.messages.id, id));
    await db.insert(schema.messages).values({ id, guildId: msg.guild.id, userId: msg.author.id, total: 1 })
.onConflictDoUpdate({ target: schema.messages.id, set: { total: (msgData?.total || 0) + 1 } });

    const [dailyData] = await db.select().from(schema.dailyMessages).where(eq(schema.dailyMessages.id, dailyId));
    await db.insert(schema.dailyMessages).values({ id: dailyId, guildId: msg.guild.id, userId: msg.author.id, date: today, count: 1 })
.onConflictDoUpdate({ target: schema.dailyMessages.id, set: { count: (dailyData?.count || 0) + 1 } });
  }

  if (!msg.content.toLowerCase().startsWith(PREFIX)) return;
  if (guild?.disabledAll &&!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === 'ping') {
    msg.reply({ embeds: [makeEmbed('Pong!', `Bot Latency: ${client.ws.ping}ms`, msg.author)] });
  }

  if (cmd === 'help') {
    const embed = new EmbedBuilder()
.setColor('#00FF00')
.setTitle(':green_arrow: qi Bot — Commands')
.addFields(
        { name: '🔍 Invite Tracker', value: '`qi it enable` — Enable tracker in this channel\n`qi it enable #channel` — Enable in a channel\n`qi it disable` — Disable tracker' },
        { name: '💬 Message Commands', value: '`qi m` — Your message count\n`qi m @user` — Someone\'s message count\n`qi m enable` — Enable counting in this channel\n`qi m disable` — Disable counting\n`qi lb m` — Message leaderboard' },
        { name: '👤 User Info', value: '`qi acc` — Your account age\n`qi acc @user` — Someone\'s account age\n`qi invited` — People you invited\n`qi invited @user` — People someone else invited' },
        { name: '⚙️ Settings', value: '`qi disable all` — Disable all commands\n`qi enable all` — Enable all commands\n`qi ping` — Bot latency' }
      )
.setFooter({ text: `created by kitaryo | Today at ${new Date().toLocaleTimeString()}` });
    msg.reply({ embeds: [embed] });
  }

  if (cmd === 'i' || cmd === 'invites') {
    const user = msg.mentions.users.first() || msg.author;
    const id = `${msg.guild.id}-${user.id}`;
    const [data] = await db.select().from(schema.invites).where(eq(schema.invites.id, id));
    const embed = new EmbedBuilder()
.setColor('#00FF00')
.setTitle('Invite log')
.setDescription(`▶ **${user.username}** has **${(data?.joins || 0) - (data?.left || 0)}** invites\n\n**Joins :** ${data?.joins || 0}\n**Left :** ${data?.left || 0}\n**Fake :** ${data?.fake || 0}\n**Rejoins :** ${data?.rejoins || 0} (7d)`)
.setThumbnail(user.displayAvatarURL())
.setFooter({ text: `created by kitaryo | Today at ${new Date().toLocaleTimeString()}` });
    msg.reply({ embeds: [embed] });
  }

  if (cmd === 'm') {
    if (args[0] === 'enable') {
      if (!msg.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
      const channels = guild?.messageChannels || [];
      if (!channels.includes(msg.channel.id)) channels.push(msg.channel.id);
      await db.insert(schema.guilds).values({ guildId: msg.guild.id, messageChannels: channels })
  .onConflictDoUpdate({ target: schema.guilds.guildId, set: { messageChannels: channels } });
      return msg.reply('✅ Message counting enabled in this channel');
    }
    if (args[0] === 'disable') {
      if (!msg.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
      const channels = guild?.messageChannels?.filter(id => id!== msg.channel.id) || [];
      await db.update(schema.guilds).set({ messageChannels: channels }).where(eq(schema.guilds.guildId, msg.guild.id));
      return msg.reply('❌ Message counting disabled in this channel');
    }

    const user = msg.mentions.users.first() || msg.author;
    const id = `${msg.guild.id}-${user.id}`;
    const today = new Date().toISOString().slice(0, 10);
    const [msgData] = await db.select().from(schema.messages).where(eq(schema.messages.id, id));
    const [dailyData] = await db.select().from(schema.dailyMessages).where(eq(schema.dailyMessages.id, `${id}-${today}`));

    const embed = new EmbedBuilder()
.setColor('#00FF00')
.setTitle(`${user.username}'s Messages`)
.setDescription(`**All time • ${msgData?.total || 0} messages in this server!**\n**Today • ${dailyData?.count || 0} messages in this server**`)
.setThumbnail(user.displayAvatarURL())
.setFooter({ text: `created by kitaryo | Requested by ${msg.author.username} | Today at ${new Date().toLocaleTimeString()}` });
    msg.reply({ embeds: [embed] });
  }

  if (cmd === 'acc') {
    const user = msg.mentions.users.first() || msg.author;
    const diff = Date.now() - user.createdTimestamp;
    const years = Math.floor(diff / 31536000000);
    const months = Math.floor((diff % 31536000000) / 2592000000);
    const days = Math.floor((diff % 2592000000) / 86400000);
    const embed = new EmbedBuilder()
.setColor('#00FF00')
.setTitle(`${user.username}'s Account Age`)
.setDescription(`${years} years, ${months} months, ${days} days`)
.setFooter({ text: `created by kitaryo | Requested by ${msg.author.username}` });
    msg.reply({ embeds: [embed] });
  }

  if (cmd === 'it') {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
    if (args[0] === 'enable') {
      const channel = msg.mentions.channels.first() || msg.channel;
      await db.insert(schema.guilds).values({ guildId: msg.guild.id, trackerChannel: channel.id })
  .onConflictDoUpdate({ target: schema.guilds.guildId, set: { trackerChannel: channel.id } });
      msg.reply(`✅ Invite tracker enabled in ${channel}`);
    }
    if (args[0] === 'disable') {
      await db.update(schema.guilds).set({ trackerChannel: null }).where(eq(schema.guilds.guildId, msg.guild.id));
      msg.reply('❌ Invite tracker disabled');
    }
  }

  if (cmd === 'invited') {
    const user = msg.mentions.users.first() || msg.author;
    const users = await db.select().from(schema.inviteUsers).where(and(
      eq(schema.inviteUsers.guildId, msg.guild.id),
      eq(schema.inviteUsers.inviterId, user.id)
    ));
    const embed = new EmbedBuilder()
.setColor('#00FF00')
.setTitle(`▶ Invited list of ${user.username}`)
.setDescription(users.length? users.map(u => `<@${u.memberId}>`).join('\n') : `${user.username} has no invites.`)
.setFooter({ text: `created by kitaryo | Today at ${new Date().toLocaleTimeString()}` });
    msg.reply({ embeds: [embed] });
  }

  if (cmd === 'disable' && args[0] === 'all') {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    await db.insert(schema.guilds).values({ guildId: msg.guild.id, disabledAll: true })
.onConflictDoUpdate({ target: schema.guilds.guildId, set: { disabledAll: true } });
    msg.reply('❌ All commands disabled in this server');
  }
  if (cmd === 'enable' && args[0] === 'all') {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    await db.update(schema.guilds).set({ disabledAll: false }).where(eq(schema.guilds.guildId, msg.guild.id));
    msg.reply('✅ All commands enabled in this server');
  }
});

client.login(process.env.DISCORD_TOKEN);
