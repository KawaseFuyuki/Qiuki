const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, ActivityType } = require('discord.js');
const postgres = require('postgres');

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
const prefix = 'qi ';
const invites = new Map();

// ===== DATABASE SETUP =====
async function setupDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      tracker_channel TEXT,
      disabled_channels TEXT[] DEFAULT '{}'
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      user_id TEXT,
      joins INTEGER DEFAULT 0,
      leftCount INTEGER DEFAULT 0,
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

  try {
    await sql`ALTER TABLE invites RENAME COLUMN left TO leftCount`;
  } catch (e) {}
}

// ===== EMBED HELPER =====
function makeEmbed(title, fields = [], user) {
  const time = new Date().toLocaleTimeString('en-IN', { 
    timeZone: 'Asia/Kolkata', 
    hour: '2-digit', 
    minute: '2-digit', 
    hour12: true 
  });
  
  const embed = new EmbedBuilder()
  .setColor('#00FFFF')
  .setTitle(title)
  .setFooter({ text: `created by kitaryo | Today at ${time}` });

  if (user) embed.setThumbnail(user.displayAvatarURL());
  if (fields.length > 0) embed.addFields(fields);
  
  return embed;
}

// ===== GET DATA FUNCTIONS =====
async function getInviteData(guildId, userId) {
  const id = `${guildId}-${userId}`;
  const [data] = await sql`SELECT * FROM invites WHERE id = ${id}`;
  return data || { joins: 0, leftCount: 0, fake: 0, rejoins: 0 };
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
  
  // Set status
  client.user.setActivity('anime for fun xD', { type: ActivityType.Watching });
  
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
  
  if (usedInvite) {
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
      channel?.send(`<@${inviterId}> invited ${member.user} now he have ${total} invite${total!== 1? 's' : ''}`);
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
    await sql`UPDATE invites SET leftCount = leftCount + 1 WHERE id = ${id}`;
    await sql`DELETE FROM invite_users WHERE guild_id = ${member.guild.id} AND member_id = ${member.id}`;
  }
});

// ===== MESSAGE TRACKER =====
client.on('messageCreate', async message => {
  if (message.author.bot ||!message.guild) return;
  
  const guildId = message.guild.id;
  const userId = message.author.id;
  const channelId = message.channel.id;
  const id = `${guildId}-${userId}`;
  const today = new Date().toISOString().split('T')[0];
  const todayId = `${guildId}-${userId}-${today}`;
  
  // Track messages
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
  
  if (!message.content.startsWith(prefix)) return;
  
  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  const [guildData] = await sql`SELECT * FROM guilds WHERE guild_id = ${guildId}`;
  
  // ===== PING - Always works =====
  if (command === 'ping') {
    return message.reply(`Pong! ${client.ws.ping}ms`);
  }
  
  // ===== HELP - Always works =====
  if (command === 'help') {
    const embed = makeEmbed('Qiuki Commands', [
      { name: '📨 Invites', value: '`qi i` - Your invites\n`qi invited @user` - User invite list\n`qi lb i` - Invite leaderboard', inline: false },
      { name: '💬 Messages', value: '`qi m` - Your messages\n`qi lb m` - Message leaderboard', inline: false },
      { name: '⚙️ Admin - Invites', value: '`qi reset i @user` - Reset user invites\n`qi reset all` - Reset all invites\n`qi enable it` - Enable tracker here\n`qi disable it` - Disable tracker', inline: false },
      { name: '⚙️ Admin - Messages', value: '`qi reset m @user` - Reset user messages\n`qi reset m all` - Reset all messages', inline: false },
      { name: '⚙️ Admin - Channels', value: '`qi enable` - Enable bot in this channel\n`qi disable` - Disable bot in this channel', inline: false }
    ]);
    return message.reply({ embeds: [embed] });
  }
  
  // Check if channel is disabled for bot commands
  const disabledChannels = guildData?.disabled_channels || [];
  if (disabledChannels.includes(channelId) &&!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return;
  }
  
  // ===== ENABLE BOT IN CHANNEL =====
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
    return message.reply('✅ Bot commands enabled in this channel!');
  }
  
  // ===== DISABLE BOT IN CHANNEL =====
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
    return message.reply('❌ Bot commands disabled in this channel!');
  }
  
  // ===== ENABLE INVITE TRACKER =====
  if (command === 'enable' && args[0] === 'it') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`
      INSERT INTO guilds (guild_id, tracker_channel) 
      VALUES (${guildId}, ${channelId})
      ON CONFLICT (guild_id) DO UPDATE SET tracker_channel = ${channelId}
    `;
    return message.reply(`✅ Invite tracker enabled in ${message.channel}`);
  }
  
  // ===== DISABLE INVITE TRACKER =====
  if (command === 'disable' && args[0] === 'it') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`UPDATE guilds SET tracker_channel = NULL WHERE guild_id = ${guildId}`;
    return message.reply('❌ Invite tracker disabled!');
  }
  
  // ===== INVITES - qi i =====
  if (command === 'i' || command === 'invites') {
    const target = message.mentions.users.first() || message.author;
    const data = await getInviteData(guildId, target.id);
    const total = data.joins - data.leftCount;
    
    const embed = makeEmbed(`${target.username}'s Invites`, [
      { name: 'Joins', value: `${data.joins}`, inline: true },
      { name: 'Left', value: `${data.leftCount}`, inline: true },
      { name: 'Fake', value: `${data.fake}`, inline: true },
      { name: 'Rejoins', value: `${data.rejoins}`, inline: true },
      { name: 'Total', value: `**${total}**`, inline: false }
    ], target);
    
    return message.reply({ embeds: [embed] });
  }
  
  // ===== INVITED LIST =====
  if (command === 'invited') {
    const target = message.mentions.users.first() || message.author;
    const invitedUsers = await sql`
      SELECT member_id FROM invite_users 
      WHERE guild_id = ${guildId} AND inviter_id = ${target.id}
      LIMIT 10
    `;
    
    const list = invitedUsers.map((u, i) => `#${i+1} • <@${u.member_id}>`).join('\n') || 'No invited users';
    const embed = makeEmbed(`Invited list of ${target.username}`, [
      { name: 'Members', value: list, inline: false }
    ]);
    
    return message.reply({ embeds: [embed] });
  }
  
  // ===== INVITE LEADERBOARD =====
  if (command === 'lb' && args[0] === 'i') {
    const top = await sql`
      SELECT user_id, joins, leftCount, fake, rejoins 
      FROM invites WHERE guild_id = ${guildId} 
      ORDER BY (joins - leftCount) DESC LIMIT 10
    `;
    
    const list = top.map((u, i) => {
      const total = u.joins - u.leftCount;
      return `#${i+1} <@${u.user_id}> • **${total}** Invites (${u.joins} Joins, ${u.leftCount} Leaves, ${u.fake} Fakes, ${u.rejoins} Rejoins)`;
    }).join('\n') || 'No data';
    
    const embed = makeEmbed('Invite Leaderboard', [{ name: 'Top 10', value: list }]);
    return message.reply({ embeds: [embed] });
  }
  
  // ===== MESSAGES =====
  if (command === 'm' || command === 'messages') {
    const target = message.mentions.users.first() || message.author;
    const data = await getMessageData(guildId, target.id);
    
    const embed = makeEmbed(`${target.username}'s Messages`, [
      { name: 'All time', value: `${data.total} messages in this server!`, inline: false },
      { name: 'Today', value: `${data.today} messages in this server`, inline: false },
      { name: 'Status', value: 'Messages are being updated in real-time', inline: false }
    ], target);
    
    return message.reply({ embeds: [embed] });
  }
  
  // ===== MESSAGE LEADERBOARD =====
  if (command === 'lb' && args[0] === 'm') {
    const top = await sql`
      SELECT user_id, total FROM messages 
      WHERE guild_id = ${guildId} 
      ORDER BY total DESC LIMIT 10
    `;
    
    const list = top.map((u, i) => `#${i+1} <@${u.user_id}> • **${u.total}** messages`).join('\n') || 'No data';
    const embed = makeEmbed('Message Leaderboard', [{ name: 'Top 10', value: list }]);
    return message.reply({ embeds: [embed] });
  }
  
  // ===== RESET INVITES =====
  if (command === 'reset' && args[0] === 'i') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return message.reply('You need Manage Server permission!');
    }
    
    const target = message.mentions.users.first();
    if (target) {
      await sql`DELETE FROM invites WHERE guild_id = ${guildId} AND user_id = ${target.id}`;
      return message.reply(`✅ Reset invite data for ${target.username}`);
    }
    return message.reply('Usage: `qi reset i @user`');
  }
  
  // ===== RESET ALL INVITES =====
  if (command === 'reset' && args[0] === 'all') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('You need Administrator permission!');
    }
    await sql`DELETE FROM invites WHERE guild_id = ${guildId}`;
    await sql`DELETE FROM invite_users WHERE guild_id = ${guildId}`;
    return message.reply('✅ Reset all invite data for this server.');
  }
  
  // ===== RESET MESSAGES =====
  if (command === 'reset' && args[0] === 'm') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return message.reply('You need Manage Server permission!');
    }
    
    const target = message.mentions.users.first();
    if (target) {
      await sql`DELETE FROM messages WHERE guild_id = ${guildId} AND user_id = ${target.id}`;
      return message.reply(`✅ Reset message data for ${target.username}`);
    } else if (args[1] === 'all') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('You need Administrator permission!');
      }
      await sql`DELETE FROM messages WHERE guild_id = ${guildId}`;
      await sql`DELETE FROM daily_messages WHERE guild_id = ${guildId}`;
      return message.reply('✅ Reset all message data for this server.');
    }
    return message.reply('Usage: `qi reset m @user` or `qi reset m all`');
  }
});

client.login(process.env.TOKEN);
