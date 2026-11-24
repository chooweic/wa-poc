// Chooses the target-app client from configuration.
//   TARGET_APP_MODE=mock (default)  -> the built-in mock target app
//   TARGET_APP_MODE=http            -> a real API at TARGET_APP_URL

import type { Env } from '../env';
import { HttpTargetAppClient, type TargetAppClient } from './client';
import { MockTargetAppClient } from './mock-client';

export function createTargetClient(env: Env): TargetAppClient {
  if ((env.TARGET_APP_MODE ?? 'mock').toLowerCase() === 'http' && env.TARGET_APP_URL) {
    return new HttpTargetAppClient(env.TARGET_APP_URL, env.TARGET_APP_API_KEY);
  }
  return new MockTargetAppClient(env.DB);
}
