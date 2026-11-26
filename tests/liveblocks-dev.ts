import { spawn } from 'node:child_process';

const cli = new URL('../apps/api/node_modules/.bin/liveblocks', import.meta.url).pathname;

export async function startLiveblocksDev(): Promise<{ baseUrl: string; stop: () => void }> {
  const devServer = spawn(cli, ['dev', '-P', '--no-persist', '--no-check'], { detached: true });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    devServer.stdout?.on('data', (chunk) => {
      output += chunk;
      const listening = /running at (http:\/\/[\w.:]+)/.exec(output);
      if (listening !== null) resolve(listening[1]);
    });
    devServer.on('exit', (code) => reject(new Error(`liveblocks dev exited ${code}: ${output}`)));
  });
  const stop = () => {
    if (devServer.pid !== undefined) process.kill(-devServer.pid, 'SIGTERM');
  };
  return { baseUrl, stop };
}
