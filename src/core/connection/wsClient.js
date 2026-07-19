import { fetchAccounts, requestWebSocketUrl } from './accounts.js';
import { emit, on } from '../state/eventBus.js';

/**
 * The single shared WebSocket connection used by every bot on this platform.
 * Bots never open their own connection — they call send()/subscribeTicks()
 * here, and listen for results via the eventBus (on('tick', ...), etc).
 */

let socket = null;
let pingInterval = null;
let currentAccountId = null;
let reqCounter = 1;

const PING_INTERVAL_MS = 30_000;

/**
 * Connects to Deriv's Options trading WebSocket for a given account.
 * Runs the two-step flow: fetch accounts (if needed) -> request OTP -> connect.
 *
 * @param {string} accessToken - the OAuth access token from tokenManager.js
 * @param {'demo'|'real'} [preferAccountType='demo'] - which account to connect to if multiple exist
 * @returns {Promise<void>} resolves once the socket is open
 */
export async function connect(accessToken, preferAccountType = 'demo') {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.warn('wsClient: already connected, ignoring duplicate connect() call.');
    return;
  }

  const accounts = await fetchAccounts(accessToken);

  if (!accounts || accounts.length === 0) {
    throw new Error('No trading accounts found for this user.');
  }

  const account =
    accounts.find((a) => a.account_type === preferAccountType) || accounts[0];

  currentAccountId = account.account_id;

  const wsUrl = await requestWebSocketUrl(currentAccountId, accessToken);

  return new Promise((resolve, reject) => {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      emit('connection:open', { accountId: currentAccountId, accountType: account.account_type });
      startPing();
      resolve();
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        console.error('wsClient: received non-JSON message', event.data);
        return;
      }
      routeMessage(message);
    };

    socket.onerror = (err) => {
      emit('connection:error', err);
      reject(err);
    };

    socket.onclose = (event) => {
      stopPing();
      emit('connection:close', { code: event.code, reason: event.reason });
    };
  });
}

/**
 * Routes an incoming message to the right event based on msg_type.
 * Bots listen via eventBus.on('tick', ...), on('proposal', ...), etc.
 */
function routeMessage(message) {
  if (message.req_id) {
    emit(`response:${message.req_id}`, message);
  }

  if (message.error) {
    emit('connection:error', message.error);
    return;
  }

  switch (message.msg_type) {
    case 'tick':
      emit('tick', message.tick);
      break;
    case 'proposal':
      emit('proposal', message.proposal);
      break;
    case 'buy':
      emit('buy', message.buy);
      break;
    case 'proposal_open_contract':
      emit('contractUpdate', message.proposal_open_contract);
      break;
    case 'balance':
      emit('balance', message.balance);
      break;
    case 'ping':
      // keep-alive response, no action needed
      break;
    default:
      emit('message', message);
  }
}

/**
 * Sends a request and returns a Promise that resolves with the matching
 * response (correlated by req_id). This is what bots use for anything
 * needing a direct reply — e.g. requesting a proposal, then buying it.
 * @param {object} request
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<object>}
 */
export function sendRequest(request, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error('wsClient: cannot send, connection is not open.'));
      return;
    }

    const reqId = reqCounter++;
    const payload = { req_id: reqId, ...request };

    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Request timed out'));
    }, timeoutMs);

    const unsubscribe = on(`response:${reqId}`, (message) => {
      clearTimeout(timeout);
      unsubscribe();
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message);
      }
    });

    socket.send(JSON.stringify(payload));
  });
}

/**
 * Sends a raw request object to the WebSocket. Adds a req_id automatically
 * so responses can be correlated if needed.
 * @param {object} request
 */
export function send(request) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('wsClient: cannot send, connection is not open.');
  }
  const payload = { req_id: reqCounter++, ...request };
  socket.send(JSON.stringify(payload));
}

/**
 * Subscribes to the live tick stream for a symbol.
 * Ticks arrive via eventBus: on('tick', (tick) => { ... }).
 * @param {string} symbol - e.g. 'R_100', 'R_10'
 */
export function subscribeTicks(symbol) {
  send({ ticks: symbol, subscribe: 1 });
}

/**
 * Unsubscribes from all active tick/proposal streams.
 * Deriv requires a forget_all call with the stream type.
 * @param {'ticks'|'proposal'|'candles'} streamType
 */
export function forgetAll(streamType) {
  send({ forget_all: streamType });
}

/**
 * Requests a price proposal for a contract (needed before buying).
 * @param {object} contractParams - e.g. { amount, basis, contract_type, currency, duration, duration_unit, symbol, barrier }
 */
export function requestProposal(contractParams) {
  send({ proposal: 1, subscribe: 1, ...contractParams });
}

/**
 * Buys a contract using a proposal ID (from a 'proposal' event) and a price.
 * @param {string} proposalId
 * @param {number} price
 */
export function buyContract(proposalId, price) {
  send({ buy: proposalId, price });
}

function startPing() {
  stopPing();
  pingInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      send({ ping: 1 });
    }
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

/**
 * Closes the connection cleanly. Call this when the user logs out or
 * ends their trading session.
 */
export function disconnect() {
  stopPing();
  if (socket) {
    socket.close(1000, 'Client disconnect');
    socket = null;
  }
}

/**
 * @returns {boolean} whether the socket is currently open
 */
export function isConnected() {
  return !!socket && socket.readyState === WebSocket.OPEN;
}

export function getCurrentAccountId() {
  return currentAccountId;
}
