import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import ipaddr from 'ipaddr.js';

export function publicIp(ip: string): boolean {
  try {
    const parsed = ipaddr.process(ip);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export function safeUrl(raw: string, domains: readonly string[]): URL {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    (u.port && u.port !== '443') ||
    !domains.includes(u.hostname) ||
    u.hostname === 'localhost' ||
    u.hostname.endsWith('.local') ||
    u.hostname.endsWith('.localhost') ||
    (ipaddr.isValid(u.hostname.replace(/^\[|\]$/g, '')) &&
      !publicIp(u.hostname.replace(/^\[|\]$/g, '')))
  )
    throw new Error('REGISTRATION_URL_BLOCKED');
  return u;
}
/** Chromium CONNECT traffic is pinned to the exact validated public address, preventing DNS rebinding. */
export async function secureProxy(
  domains: readonly string[],
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const sockets = new Set<import('node:stream').Duplex>();
  const server = createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(20000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client, head) => {
    void (async () => {
      if (!req.url) throw new Error('NO_HOST');
      const u = safeUrl(`https://${req.url}`, domains);
      const addresses = await lookup(u.hostname, { all: true });
      if (!server.listening) throw new Error('PROXY_CLOSED');
      if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
        throw new Error('PRIVATE_ADDRESS');
      const chosen = addresses[0]!;
      const upstream = connect({ host: chosen.address, port: 443, family: chosen.family });
      sockets.add(upstream);
      sockets.add(client);
      const close = () => {
        upstream.destroy();
        client.destroy();
        sockets.delete(upstream);
        sockets.delete(client);
      };
      upstream.setTimeout(20000, close);
      let total = 0;
      upstream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 8_000_000) close();
      });
      upstream.on('error', close);
      client.on('error', close);
      upstream.on('close', close);
      client.on('close', close);
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    })().catch(() => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PROXY_START_FAILED');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
