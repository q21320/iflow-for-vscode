import * as net from 'net';

export interface PortDiscoveryDependencies {
  isPortAvailable: (port: number) => Promise<boolean>;
  findAvailablePort: () => Promise<number>;
}

export async function resolveStartupPort(
  configuredPort: number,
  deps: PortDiscoveryDependencies,
): Promise<number> {
  if (configuredPort <= 0 || configuredPort > 65535) {
    return deps.findAvailablePort();
  }

  const preferredAvailable = await deps.isPortAvailable(configuredPort);
  if (preferredAvailable) {
    return configuredPort;
  }

  return deps.findAvailablePort();
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();

    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once('error', () => {
      cleanup();
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        cleanup();
        resolve(true);
      });
    });

    server.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once('error', (err: Error) => {
      cleanup();
      reject(err);
    });

    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        cleanup();
        if (typeof port === 'number' && port > 0 && port <= 65535) {
          resolve(port);
        } else {
          reject(new Error('Failed to resolve available ACP port'));
        }
      });
    });

    server.listen(0, '127.0.0.1');
  });
}
