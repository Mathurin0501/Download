/**
 * ReliableTransfer — transport de fichiers WebRTC, sans interface visuelle.
 * Compatible avec un RTCDataChannel fiable et ordonné.
 * @license MIT
 * Protocol: RT1| JSON control frames + binary framed chunks.
 */

const PREFIX = 'RT1|';
const MAGIC = 0x52543144; // "RT1D"
const HEADER_SIZE = 12;
const DEFAULT_CHUNK_SIZE = 16 * 1024 - HEADER_SIZE;
const ACK_INTERVAL = 256 * 1024;
// Back-pressure adaptive: PCs can keep a wider window, phones stay conservative.
const MOBILE_DEVICE = typeof navigator !== 'undefined' &&
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
const DEFAULT_WINDOW_SIZE = MOBILE_DEVICE ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED = MOBILE_DEVICE ? 1024 * 1024 : 4 * 1024 * 1024;
const OPFS_WRITE_BATCH = 512 * 1024;
const MEMORY_SINK_LIMIT = MOBILE_DEVICE ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
let opfsCleanupStarted = false;
async function cleanupStaleOPFS(dir) {
  if (opfsCleanupStarted) return;
  opfsCleanupStarted = true;
  // The same origin may have another active tab. Only remove files older than 48h.
  try {
    const expiry = Date.now() - 48 * 3600 * 1000;
    for await (const [name, handle] of dir.entries()) {
      if (!/^rt1-[a-zA-Z0-9-]+\.partial$/.test(name) || handle.kind !== 'file') continue;
      try {
        const file = await handle.getFile();
        if (file.lastModified < expiry) await dir.removeEntry(name);
      } catch (_) {}
    }
  } catch (_) {}
}
const WAIT_INTERVAL_MS = 20;
const TRANSFER_TIMEOUT_MS = 60000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i;
    for (let j = 0; j < 8; j++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    t[i] = n >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function safeName(name) {
  return String(name || 'fichier').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 255) || 'fichier';
}
function transferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function chooseChunkSize(pc) {
  // Large chunks when both peers advertise a sufficiently high SCTP limit.
  const limit = pc?.sctp?.maxMessageSize;
  if (typeof limit === 'number' && (limit === 0 || limit >= 262144)) {
    return 64 * 1024 - HEADER_SIZE;
  }
  if (typeof limit === 'number' && limit >= 65536) {
    return 32 * 1024 - HEADER_SIZE;
  }
  return DEFAULT_CHUNK_SIZE; // conservative cross-browser fallback
}
function frameFor(index, bytes) {
  const out = new Uint8Array(HEADER_SIZE + bytes.byteLength);
  const header = new DataView(out.buffer);
  header.setUint32(0, MAGIC);
  header.setUint32(4, index);
  header.setUint32(8, crc32(bytes));
  out.set(bytes, HEADER_SIZE);
  return out;
}
function decodeFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_SIZE) {
    throw new Error('Bloc de données invalide.');
  }
  const view = new DataView(buffer);
  if (view.getUint32(0) !== MAGIC) throw new Error('Protocole binaire non reconnu.');
  const bytes = new Uint8Array(buffer, HEADER_SIZE);
  if (crc32(bytes) !== view.getUint32(8)) throw new Error('Intégrité du bloc non vérifiée.');
  return { index: view.getUint32(4), bytes };
}
function storageAvailable() {
  return Boolean(globalThis.navigator?.storage?.getDirectory);
}
async function createSink(id, preferDisk, size) {
  if (preferDisk && size > MEMORY_SINK_LIMIT && storageAvailable()) {
    try {
      const dir = await navigator.storage.getDirectory();
      void cleanupStaleOPFS(dir);
      const fileName = `rt1-${id.replace(/[^a-zA-Z0-9-]/g, '')}.partial`;
      const handle = await dir.getFileHandle(fileName, { create: true });
      const writer = await handle.createWritable({ keepExistingData: false });
      let pending = [], pendingLength = 0;
      const flush = async () => {
        if (!pendingLength) return;
        const blob = new Blob(pending);
        pending = []; pendingLength = 0;
        await writer.write(blob);
      };
      return {
        kind: 'opfs', dir, handle, writer, fileName,
        async append(bytes) {
          pending.push(bytes.slice()); pendingLength += bytes.byteLength;
          if (pendingLength >= OPFS_WRITE_BATCH) await flush();
        },
        async finish(name, type) {
          await flush();
          await writer.close();
          const file = await handle.getFile();
          return new File([file], name, { type });
        },
        async abort() { pending.length = 0; pendingLength = 0; try { await writer.abort(); } catch {} try { await dir.removeEntry(fileName); } catch {} }
      };
    } catch (e) {
      // Private browsing / unsupported quota may make OPFS inaccessible.
    }
  }
  const parts = [];
  return {
    kind: 'memory',
    async append(bytes) { parts.push(bytes.slice()); },
    async finish(name, type) { return new File(parts, name, { type }); },
    async abort() { parts.length = 0; }
  };
}

/**
 * @param {{onProgress?: Function, onFileReceived?: Function, onError?: Function,
 *          onStatus?: Function, preferDisk?: boolean, chunkSize?: number,
 *          windowBytes?: number, maxBufferedBytes?: number}} options
 *
 * Create one instance per peer. Attach a *reliable and ordered* WebRTC
 * RTCDataChannel created by your existing connection / pairing code.
 * Reattach the same instance to a new DataChannel to retry a partial transfer.
 */
export class ReliableTransfer {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this.onFileReceived = options.onFileReceived || defaultDownload;
    this.onError = options.onError || console.error;
    this.onStatus = options.onStatus || (() => {});
    this.preferDisk = options.preferDisk !== false;
    this.configuredChunkSize = options.chunkSize || null;
    this.windowBytes = options.windowBytes || DEFAULT_WINDOW_SIZE;
    this.maxBufferedBytes = options.maxBufferedBytes || DEFAULT_MAX_BUFFERED;
    if (!Number.isSafeInteger(this.windowBytes) || this.windowBytes < 262144 ||
        !Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 65536) {
      throw new RangeError('Limites de transfert invalides.');
    }
    this.channel = null;
    this.sender = null;
    this.receiver = null;
    this.lastOutgoing = null;
    this.receiveQueue = Promise.resolve();
    this.handlers = null;
    this.progressHistory = new Map();
  }

  emitProgress(payload) {
    const now = Date.now();
    const prev = this.progressHistory.get(payload.direction);
    if (prev && now - prev.lastShown < 100 && payload.transferred < payload.total) return;
    const speedMbps = prev && now > prev.lastSampled
      ? Math.max(0, (payload.transferred - prev.lastBytes) * 8 / ((now - prev.lastSampled) * 1000))
      : 0;
    this.progressHistory.set(payload.direction, { lastShown: now, lastSampled: now, lastBytes: payload.transferred });
    try { this.onProgress({ ...payload, speedMbps }); } catch (e) { this.reportError(e); }
  }

  attachChannel(channel, peerConnection = null) {
    if (!channel) throw new TypeError('RTCDataChannel requis.');
    if (channel.ordered === false || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
      throw new Error('Le canal doit être fiable et ordonné : ordered:true, sans limite de retransmissions.');
    }
    this.detachChannel();
    this.channel = channel;
    this.channel.binaryType = 'arraybuffer';
    this.chunkSize = Math.min(this.configuredChunkSize || chooseChunkSize(peerConnection), 64 * 1024 - HEADER_SIZE);
    if (this.chunkSize < 1024) throw new Error('Taille des blocs invalide.');
    channel.bufferedAmountLowThreshold = Math.min(this.maxBufferedBytes / 2, 512 * 1024);
    const onMessage = e => {
      // Serialize asynchronous disk writes to preserve chunk order and ACK semantics.
      this.receiveQueue = this.receiveQueue.then(() => this.handleMessage(e.data)).catch(async err => {
        this.reportError(err);
        this.sendControlSafe({ type: 'error', id: this.receiver?.id, message: err.message });
        // A corrupt/incomplete chunk cannot be resumed from a trusted offset.
        // Discard only the current partial file, then let the app reconnect.
        const current = this.receiver;
        if (current && !current.finished) {
          this.receiver = null;
          try { await current.sink.abort(); } catch (_) {}
        }
        try { if (channel.readyState === 'open') channel.close(); } catch (_) {}
      });
    };
    const onClose = () => this.onStatus({ state: 'disconnected', message: 'Connexion interrompue. Le transfert peut être retenté.' });
    const onError = () => this.onStatus({ state: 'error', message: 'Erreur du canal WebRTC.' });
    channel.addEventListener('message', onMessage);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onError);
    this.handlers = { onMessage, onClose, onError };
    this.onStatus({ state: channel.readyState, message: 'Canal de transfert attaché.' });
  }

  detachChannel() {
    if (this.channel && this.handlers) {
      this.channel.removeEventListener('message', this.handlers.onMessage);
      this.channel.removeEventListener('close', this.handlers.onClose);
      this.channel.removeEventListener('error', this.handlers.onError);
    }
    this.channel = null;
    this.handlers = null;
  }

  get isConnected() { return this.channel?.readyState === 'open'; }

  sendControl(payload) {
    if (!this.isConnected) throw new Error('Les deux appareils ne sont pas connectés.');
    this.channel.send(PREFIX + JSON.stringify(payload));
  }
  sendControlSafe(payload) {
    if (this.isConnected) {
      try { this.sendControl(payload); } catch {}
    }
  }
  reportError(err) {
    try { this.onError(err instanceof Error ? err : new Error(String(err))); } catch {}
  }

  async waitFor(predicate, timeout = TRANSFER_TIMEOUT_MS) {
    const started = Date.now();
    while (!predicate()) {
      if (!this.isConnected || (this.sender && this.sender.channel !== this.channel)) throw new Error('Connexion perdue. Reconnectez les appareils et réessayez.');
      if (this.sender?.failed) throw this.sender.failed;
      if (Date.now() - started > timeout) throw new Error('Délai dépassé : la connexion ou le récepteur ne répond plus.');
      await delay(WAIT_INTERVAL_MS);
    }
  }

  async sendFile(file, { id = transferId() } = {}) {
    if (!(file instanceof Blob)) throw new TypeError('Sélectionnez un fichier File ou Blob.');
    if (!this.isConnected) throw new Error('Connexion WebRTC non établie.');
    if (this.sender) throw new Error('Un autre envoi est déjà en cours.');
    const chunkSize = this.chunkSize;
    const meta = {
      type: 'file', id, name: safeName(file.name), size: file.size,
      mime: String(file.type || 'application/octet-stream'), chunkSize
    };
    this.lastOutgoing = { file, id };
    const state = this.sender = { id, meta, accepted: false, acknowledged: 0, finished: false, failed: null, channel: this.channel };
    try {
      this.onStatus({ state: 'sending', name: meta.name, size: meta.size });
      this.sendControl(meta);
      await this.waitFor(() => state.accepted, 30000);
      const acceptedOffset = state.acknowledged;
      const startChunk = acceptedOffset === file.size ? Math.ceil(file.size / chunkSize) : acceptedOffset / chunkSize;
      if (!Number.isInteger(startChunk)) throw new Error('Position de reprise invalide.');
      const totalChunks = Math.ceil(file.size / chunkSize);
      this.emitProgress({ direction: 'send', name: meta.name, transferred: acceptedOffset, total: file.size, percent: file.size ? acceptedOffset / file.size * 100 : 100 });
      for (let i = startChunk; i < totalChunks; i++) {
        const offset = i * chunkSize;
        // Limit both native WebRTC buffering and unacknowledged receiver work.
        await this.waitFor(() => this.channel.bufferedAmount <= this.maxBufferedBytes &&
          offset - state.acknowledged <= this.windowBytes);
        const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer());
        const packet = frameFor(i, bytes);
        if (!this.isConnected || this.channel !== state.channel) throw new Error('Connexion interrompue pendant l’envoi.');
        this.channel.send(packet);
      }
      await this.waitFor(() => state.acknowledged >= file.size);
      if (this.channel !== state.channel) throw new Error('Connexion interrompue avant confirmation.');
      this.sendControl({ type: 'end', id });
      await this.waitFor(() => state.finished);
      this.onStatus({ state: 'sent', name: meta.name, size: file.size });
      return { id, bytes: file.size };
    } catch (e) {
      this.reportError(e);
      this.onStatus({ state: 'send-failed', message: e.message });
      throw e;
    } finally {
      if (this.sender === state) this.sender = null;
    }
  }

  /** After reconnecting, resends metadata; the receiver can resume at its last saved block. */
  async retryLastSend() {
    if (!this.lastOutgoing) throw new Error('Aucun transfert précédent à reprendre.');
    return this.sendFile(this.lastOutgoing.file, { id: this.lastOutgoing.id });
  }

  async handleMessage(raw) {
    if (typeof raw === 'string') {
      if (!raw.startsWith(PREFIX)) return; // allow other app messages
      if (raw.length > 16384) throw new Error('Message de contrôle trop volumineux.');
      const msg = JSON.parse(raw.slice(PREFIX.length));
      if (!msg || typeof msg !== 'object') return;
      await this.handleControl(msg);
      return;
    }
    if (raw instanceof Blob) raw = await raw.arrayBuffer();
    if (raw instanceof ArrayBuffer) {
      const parsed = decodeFrame(raw);
      await this.handleChunk(parsed);
    }
  }

  async handleControl(msg) {
    switch (msg.type) {
      case 'file': {
        const { id, name, size, mime, chunkSize } = msg;
        if (typeof id !== 'string' || id.length > 150 || !id ||
            typeof name !== 'string' || name.length > 1024 ||
            !Number.isSafeInteger(size) || size < 0 ||
            !Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > 65536) {
          throw new Error('Métadonnées de fichier incorrectes.');
        }
        if (this.receiver && this.receiver.id !== id && !this.receiver.finished) {
          this.sendControlSafe({ type: 'error', id, message: 'Un fichier est déjà en cours de réception.' });
          return;
        }
        if (this.receiver?.id === id) {
          if (this.receiver.size !== size || this.receiver.chunkSize !== chunkSize) throw new Error('Incompatibilité de reprise.');
          if (this.receiver.failed) throw this.receiver.failed;
          this.sendControl({ type: 'accept', id, offset: this.receiver.receivedBytes });
          break;
        }
        const sink = await createSink(id, this.preferDisk, size);
        this.receiver = { id, name: safeName(name), size, mime: String(mime || ''), chunkSize,
          sink, receivedBytes: 0, lastAck: 0, nextIndex: 0, finished: false, failed: null };
        this.onStatus({ state: 'receiving', name: this.receiver.name, size });
        this.sendControl({ type: 'accept', id, offset: 0 });
        break;
      }
      case 'accept': {
        const s = this.sender;
        if (!s || s.id !== msg.id || !Number.isSafeInteger(msg.offset) ||
            msg.offset < 0 || msg.offset > s.meta.size) return;
        // Only complete blocks can be resumed (except completed file).
        if (msg.offset !== s.meta.size && msg.offset % s.meta.chunkSize !== 0) {
          s.failed = new Error('Reprise refusée : position non alignée.'); return;
        }
        s.acknowledged = msg.offset;
        s.accepted = true;
        break;
      }
      case 'ack': {
        const s = this.sender;
        if (!s || s.id !== msg.id || !Number.isSafeInteger(msg.offset)) return;
        if (msg.offset >= s.acknowledged && msg.offset <= s.meta.size) {
          s.acknowledged = msg.offset;
          this.emitProgress({ direction: 'send', name: s.meta.name, transferred: s.acknowledged,
            total: s.meta.size, percent: s.meta.size ? s.acknowledged / s.meta.size * 100 : 100 });
        }
        break;
      }
      case 'end': {
        const r = this.receiver;
        if (!r || r.id !== msg.id) return;
        if (r.finished) { this.sendControl({ type: 'complete', id: r.id }); return; }
        if (r.receivedBytes !== r.size) {
          this.sendControl({ type: 'error', id: r.id, message: `Fichier incomplet (${r.receivedBytes}/${r.size}).` });
          return;
        }
        const file = await r.sink.finish(r.name, r.mime);
        try { await this.onFileReceived(file, { id: r.id, name: r.name, size: r.size, mime: r.mime }); }
        catch (e) { this.sendControlSafe({ type: 'error', id: r.id, message: 'Échec de sauvegarde sur le récepteur.' }); throw e; }
        r.finished = true;
        this.sendControl({ type: 'complete', id: r.id });
        this.onStatus({ state: 'received', name: r.name, size: r.size });
        break;
      }
      case 'complete': {
        const s = this.sender;
        if (s && s.id === msg.id) s.finished = true;
        break;
      }
      case 'error': {
        const s = this.sender;
        if (s && s.id === msg.id) s.failed = new Error(msg.message || 'Erreur sur le récepteur.');
        break;
      }
      case 'cancel': {
        const r = this.receiver;
        if (r && r.id === msg.id && !r.finished) {
          await r.sink.abort(); this.receiver = null;
        }
        const s = this.sender;
        if (s && s.id === msg.id) s.failed = new Error('Transfert annulé.');
        break;
      }
    }
  }

  async handleChunk({ index, bytes }) {
    const r = this.receiver;
    if (!r || r.finished || r.failed) return;
    if (index < r.nextIndex) { // Duplicate already stored after a reconnect
      this.sendControlSafe({ type: 'ack', id: r.id, offset: r.receivedBytes });
      return;
    }
    if (index !== r.nextIndex || bytes.length > r.chunkSize ||
        r.receivedBytes + bytes.byteLength > r.size ||
        (r.receivedBytes + bytes.byteLength < r.size && bytes.byteLength !== r.chunkSize)) {
      throw new Error('Bloc reçu hors ordre ou de taille incorrecte.');
    }
    await r.sink.append(bytes);
    r.receivedBytes += bytes.byteLength;
    r.nextIndex++;
    this.emitProgress({ direction: 'receive', name: r.name, transferred: r.receivedBytes,
      total: r.size, percent: r.size ? 100 * r.receivedBytes / r.size : 100 });
    if (r.receivedBytes - r.lastAck >= ACK_INTERVAL || r.receivedBytes === r.size) {
      r.lastAck = r.receivedBytes;
      this.sendControlSafe({ type: 'ack', id: r.id, offset: r.receivedBytes });
    }
  }

  async cancel() {
    const id = this.sender?.id || this.receiver?.id;
    if (id) this.sendControlSafe({ type: 'cancel', id });
    if (this.sender) this.sender.failed = new Error('Envoi annulé.');
    if (this.receiver && !this.receiver.finished) {
      await this.receiver.sink.abort();
      this.receiver = null;
    }
  }
}

/** Default behaviour: download only after the full file has arrived. */
export async function defaultDownload(file) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName(file.name);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Example WebRTC configuration for the existing pairing/signaling layer. */
export const recommendedRTCConfig = Object.freeze({
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 4
});

/** If your signaling method transmits SDP only once, wait for ICE gathering. */
export async function waitForIceGathering(pc, timeoutMs = 12000) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    pc.addEventListener('icegatheringstatechange', check);
    const timer = setTimeout(finish, timeoutMs);
    check();
  });
}

/** Diagnostic sans exposition des adresses IP : utile pour Wi-Fi / Ethernet. */
export async function diagnoseConnection(pc) {
  const summary = {
    connectionState: pc?.connectionState || 'unknown',
    iceConnectionState: pc?.iceConnectionState || 'unknown',
    iceGatheringState: pc?.iceGatheringState || 'unknown',
    route: 'unknown'
  };
  if (!pc?.getStats) return summary;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach(report => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pair = stats.get(report.selectedCandidatePairId);
    }
  });
  if (!pair) stats.forEach(report => {
    if (report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) pair = report;
  });
  if (pair) {
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    summary.localCandidateType = local?.candidateType || 'unknown';
    summary.remoteCandidateType = remote?.candidateType || 'unknown';
    summary.route = [local, remote].some(c => c?.candidateType === 'relay') ? 'relay' : 'direct';
    if (Number.isFinite(pair.currentRoundTripTime)) summary.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    if (Number.isFinite(pair.availableOutgoingBitrate)) summary.estimatedOutgoingMbps = +(pair.availableOutgoingBitrate / 1e6).toFixed(2);
  }
  return summary;
}
