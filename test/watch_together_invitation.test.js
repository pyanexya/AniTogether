import { describe, it, expect } from 'vitest';
import { WatchTogetherClient, parseInvitation } from '../src/shared/watch-together/client.mjs';

describe('AnixArtix invitation branding', () => {
  it('round-trips the generated invitation with the current brand prefix', () => {
    const client = new WatchTogetherClient();
    client.serverUrl = 'wss://relay.example/watch';
    client.view = { ...client.view, role: 'host', roomId: '1234567890ab' };
    client.inviteToken = 'a'.repeat(48);
    const text = client.invitation();
    expect(text.startsWith('AnixArtix:')).toBe(true);
    expect(parseInvitation(text)).toEqual({ serverUrl: client.serverUrl, roomId: client.view.roomId, inviteToken: client.inviteToken });
    client.destroy();
  });
});
