import { createServer, connect as dial, type Socket } from 'node:net';

export type Cut = 'socket killed' | 'FATAL 57P01 then close';

const fields = Buffer.from(
  'SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0',
);
const adminShutdown = Buffer.concat([Buffer.from('E'), Buffer.alloc(4), fields]);
adminShutdown.writeInt32BE(4 + fields.length, 1);

export async function cuttingProxy(target: string) {
  const upstreamUrl = new URL(target);
  let armed: { marker: string; cut: Cut } | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = dial(Number(upstreamUrl.port || 5432), upstreamUrl.hostname);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ]) {
      sockets.add(from);
      from.on('error', () => to.destroy());
      from.on('close', () => to.destroy());
    }
    upstream.on('data', (chunk) => client.write(chunk));
    client.on('data', (chunk) => {
      if (armed === null || !chunk.includes(armed.marker)) {
        upstream.write(chunk);
        return;
      }
      const { cut } = armed;
      armed = null;
      upstream.destroy();
      if (cut === 'socket killed') client.destroy();
      else client.end(adminShutdown);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.href,
    cutOn(marker: string, cut: Cut) {
      armed = { marker, cut };
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export function watchUncaught() {
  const seen: unknown[] = [];
  const record = (error: unknown) => seen.push(error);
  process.on('uncaughtException', record);
  return { seen, stop: () => process.off('uncaughtException', record) };
}
