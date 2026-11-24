// Picks the channel implementation for a conversation.

import { getConfig, type Env } from '../env';
import { WhatsAppClient } from '../whatsapp-client';
import { MetaWhatsAppChannel } from './meta';
import { MockWaChannel } from './mockwa';
import type { ChannelName, MessagingChannel } from './types';

export function createChannel(env: Env, name: ChannelName): MessagingChannel {
  if (name === 'mock') return new MockWaChannel(env.DB);
  const config = getConfig(env);
  if (!config.metaEnabled) throw new Error('The real WhatsApp channel is disabled (WHATSAPP_* secrets are not set).');
  return new MetaWhatsAppChannel(
    new WhatsAppClient({
      accessToken: env.WHATSAPP_ACCESS_TOKEN as string,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID as string,
      apiVersion: config.whatsappApiVersion,
    }),
  );
}
