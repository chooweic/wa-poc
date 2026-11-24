// Picks the channel implementation for a conversation.

import { getConfig, type Env } from '../env';
import { WhatsAppClient } from '../whatsapp-client';
import { TwilioClient } from '../twilio-client';
import { MetaWhatsAppChannel } from './meta';
import { MockWaChannel } from './mockwa';
import { TwilioWhatsAppChannel } from './twilio';
import type { ChannelName, MessagingChannel } from './types';

export function createChannel(env: Env, name: ChannelName): MessagingChannel {
  if (name === 'mock') return new MockWaChannel(env.DB);
  const config = getConfig(env);
  if (name === 'twilio') {
    if (!config.twilioEnabled) throw new Error('The Twilio channel is disabled (TWILIO_* settings are not set).');
    return new TwilioWhatsAppChannel(
      new TwilioClient({
        accountSid: env.TWILIO_ACCOUNT_SID as string,
        authToken: env.TWILIO_AUTH_TOKEN as string,
        from: env.TWILIO_WHATSAPP_FROM as string,
      }),
    );
  }
  if (!config.metaEnabled) throw new Error('The real WhatsApp channel is disabled (WHATSAPP_* secrets are not set).');
  return new MetaWhatsAppChannel(
    new WhatsAppClient({
      accessToken: env.WHATSAPP_ACCESS_TOKEN as string,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID as string,
      apiVersion: config.whatsappApiVersion,
    }),
  );
}
