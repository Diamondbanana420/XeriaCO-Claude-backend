const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const WebSocket = require('ws');
const Order = require('../models/Order');
const Product = require('../models/Product');
const logger = require('../utils/logger');

// Bot configuration
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BOT_ID = process.env.DISCORD_BOT_ID || '1468022638520832011';
const MOLTBOT_WS_URL = process.env.MOLTBOT_WS_URL || 'wss://moltbot-config-25.preview.emergentagent.com/ws?token=bf4765e62a04f87f5d339499fc25aa01';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

let moltbotWs = null;

function connectMoltbot() {
  moltbotWs = new WebSocket(MOLTBOT_WS_URL);
  moltbotWs.on('open', () => logger.info('Connected to Moltbot AI'));
  moltbotWs.on('close', () => setTimeout(connectMoltbot, 5000));
}

const commands = [
  new SlashCommandBuilder().setName('orders').setDescription('View recent orders'),
  new SlashCommandBuilder().setName('inventory').setDescription('Check inventory'),
  new SlashCommandBuilder().setName('analytics').setDescription('Sales analytics'),
  new SlashCommandBuilder().setName('ai').setDescription('Ask AI').addStringOption(o => o.setName('q').setDescription('Question').setRequired(true))
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(BOT_ID), { body: commands.map(c => c.toJSON()) });
}

client.once('ready', () => { logger.info('Discord bot ready'); registerCommands(); connectMoltbot(); });

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'orders') {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(5);
    const embed = new EmbedBuilder().setTitle('Orders').setColor(0x9333EA);
    orders.forEach(o => embed.addFields({ name: o.orderNumber, value: o.status }));
    await interaction.reply({ embeds: [embed] });
  }
});

function initDiscordBot() {
  if (!BOT_TOKEN) return null;
  client.login(BOT_TOKEN);
  return client;
}

module.exports = { initDiscordBot, client };
