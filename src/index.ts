import { NCWebsocket } from 'node-napcat-ts';
import type { AllHandlers } from 'node-napcat-ts';
import config from '../config.json' with { type: 'json' };

const napcat = new NCWebsocket(
  {
    baseUrl: config.napcatWs,
    accessToken: config.napcatToken,
    throwPromise: true,
    reconnection: {
      enable: true,
      // Retry forever. `node-napcat-ts` resolves the promise returned by `connect()`
      // only from the socket's `open` handler and never rejects it, so once the
      // attempt budget runs out the promise stays pending forever. A pending
      // reconnect timer is what keeps the Node event loop alive; without it Node
      // exits with code 13 ("Detected unsettled top-level await") and a brief
      // NapCat outage turns into a pm2 crash-loop.
      attempts: Number.MAX_SAFE_INTEGER,
      delay: 5000
    }
  },
  false
);

// Small generic signallable promise: call `signal()` to resolve the promise.
const createSignallable = <T>() => {
  // start with a noop resolver to avoid definite-assignment / non-null assertions
  let resolver: (value: T) => void = () => undefined as unknown as void;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    signal(value: T) {
      resolver(value);
    }
  } as { promise: Promise<T>; signal: (value: T) => void };
};

const socketClose = createSignallable<void>();

napcat.on('socket.open', () => {
  console.log('[NapCat] Connected.');
});

napcat.on('socket.close', () => {
  console.log('[NapCat] Disconnected.');
  try {
    socketClose.signal(undefined);
  } catch {
    // ignore if already resolved
  }
});

napcat.on('socket.error', (context) => {
  if (context.error_type === 'response_error') {
    console.error(`[NapCat] NapCat rejected a request: ${context.info.message} (errno ${context.info.errno})`);
    return;
  }
  console.error('[NapCat] WebSocket connection error, reconnecting...');
});

napcat.on('request.group.invite', async (context: AllHandlers['request.group.invite']) => {
  napcat.set_group_add_request({
    flag: context.flag,
    approve: true
  });
  console.log(
    `[NapCat] Approved group invite request from ${context.user_id} to group ${context.group_id}.`
  );
});

// Do not `await napcat.connect()` here. `node-napcat-ts` only ever resolves that
// promise from the socket's `open` handler and never rejects it, so when the socket
// never opens the promise stays pending forever: a pending top-level await with an
// otherwise empty event loop makes Node exit with code 13 ("Detested unsettled
// top-level await"), which turned a brief NapCat outage into a pm2 crash-loop
// (2026-10-22). The library keeps retrying on its own (see `attempts` above) and the
// `socket.open` handler already starts the hourly timer, so there is nothing to wait
// for.
napcat.connect().catch((error) => {
  console.error('[NapCat] Initial connection failed:', error);
});

let shutdownInitiated = false;
process.on('SIGINT', async () => {
  if (shutdownInitiated) {
    console.log('\nForce exiting...');
    process.exit(1);
  }
  shutdownInitiated = true;
  console.log('\nGracefully shutting down...');

  napcat.disconnect();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
  await Promise.race([socketClose.promise, timeout]);

  console.log('Process exited.');
  process.exit(0);
});
