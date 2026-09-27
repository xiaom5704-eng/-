import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';

// Some Windows ephemeral ports are blocked by fetch. Detect the restriction
// before a test performs writes; retry only that client-side port error.
export async function listenForFetch(app: RequestListener) {
  const server = createServer(app);
  for (let attempt = 0; attempt < 10; attempt++) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/__test_port__`, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return server;
    } catch (error) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if ((error as Error & { cause?: Error }).cause?.message !== 'bad port') throw error;
    }
  }
  throw new Error('Could not allocate a test HTTP port accepted by fetch');
}
