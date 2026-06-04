import { pgTable, text, integer, boolean } from 'drizzle-orm/pg-core';

export const guilds = pgTable('guilds', {
  guildId: text('guild_id').primaryKey(),
  trackerChannel: text('tracker_channel'),
  disabledAll: boolean('disabled_all').default(false),
  messageChannels: text('message_channels').array().default([])
});

export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  guildId: text('guild_id'),
  userId: text('user_id'),
  joins: integer('joins').default(0),
  left: integer('left').default(0),
  fake: integer('fake').default(0),
  rejoins: integer('rejoins').default(0)
});

export const inviteUsers = pgTable('invite_users', {
  id: text('id').primaryKey(),
  guildId: text('guild_id'),
  inviterId: text('inviter_id'),
  memberId: text('member_id')
});

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  guildId: text('guild_id'),
  userId: text('user_id'),
  total: integer('total').default(0)
});

export const dailyMessages = pgTable('daily_messages', {
  id: text('id').primaryKey(),
  guildId: text('guild_id'),
  userId: text('user_id'),
  date: text('date'),
  count: integer('count').default(0)
});
