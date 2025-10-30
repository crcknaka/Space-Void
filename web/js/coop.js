import { GameWorld } from './single-player.js';

export function createCoopWorld(options) {
  return new GameWorld({ ...options, mode: 'coop' });
}
