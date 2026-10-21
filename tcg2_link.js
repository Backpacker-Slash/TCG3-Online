/*
 * tcg2_link.js - the "link cable" between two Pokemon TCG 2 emulators.
 *
 * The ROM (src/home/serial.asm) keeps its stock link protocol. Only the
 * hardware below it is replaced: instead of the serial port, the game queues
 * bytes in a 32 byte ring buffer in WRAM and reads incoming bytes from another
 * one. This module moves the bytes between those ring buffers and the network,
 * like the serial interrupt handler did on real hardware, and does the one
 * thing the cable used to do by electrical means: deciding which Game Boy is
 * the master.
 *
 * It does not know anything about WebRTC / PeerJS: it is given a send(msg)
 * function and is fed incoming messages with onMessage(msg). Messages are plain
 * JSON objects, delivered reliably and in order:
 *
 *   {type:'ready', v:0|1}              the player pressed START in the link menu
 *   {type:'go', hostMaster:bool}       host: both are ready, this is who is master
 *   {type:'go_ack'} / {type:'go_nack'} guest: answer to 'go'
 *   {type:'bytes', data:[...]}         bytes taken from the peer's send ring
 *   {type:'bye'}                       the peer is gone
 *
 * Call tick(wram) at least once per emulated frame (it is safe to call more
 * often, also in the middle of a frame: the ROM tolerates the ring buffers
 * changing between any two instructions, as it did with the interrupt).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tcg2Link = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // WRAM0 offsets (address - $C000). Generated from poketcg2.sym by
  // tools/gen_link_offsets.py; keep in sync with src/wram.asm.
  const DEFAULT_OFFSETS = {
    serialOp: 0x0b6e,          // wSerialOp
    serialFlags: 0x0b6f,       // wSerialFlags
    linkReady: 0x0b77,         // wLinkReady
    sendCount: 0x0b78,         // wSerialSendBufToggle: bytes waiting in the send ring
    sendReadIdx: 0x0b79,       // wSerialSendBufIndex
    sendWriteIdx: 0x0b7a,      // wcb80
    sendBuf: 0x0b7b,           // wSerialSendBuf (32 bytes)
    recvCount: 0x0b9c,         // wSerialRecvCounter: bytes waiting in the receive ring
    recvReadIdx: 0x0b9d,       // wcba3
    recvWriteIdx: 0x0b9e,      // wSerialRecvIndex
    recvBuf: 0x0b9f,           // wSerialRecvBuf (32 bytes)
  };

  const SERIAL_OP_MASTER = 0x92;      // SERIAL_OP_MASTER_TCG2
  const SERIAL_PEER_MASTER = 0x21;    // SERIAL_PEER_MASTER_TCG2
  const SERIAL_FLAG_TIMEOUT = 0x80;   // what the timer handler used to set when the cable was pulled
  const RING = 32;

  class Tcg2Link {
    /**
     * @param {object} opts
     * @param {boolean} opts.isHost   the host breaks ties when both players are ready at once
     * @param {function} opts.send    send(msg) -> delivers msg to the peer's onMessage
     * @param {function} [opts.onEvent] onEvent(name, detail) for UI: 'ready', 'peer-ready', 'linked', 'unlinked'
     * @param {object} [opts.offsets]
     */
    constructor(opts) {
      this.isHost = !!opts.isHost;
      this.send = opts.send;
      this.onEvent = opts.onEvent || (() => {});
      this.o = Object.assign({}, DEFAULT_OFFSETS, opts.offsets || {});
      this.resetSession();
      this.peerGone = false;
    }

    resetSession() {
      this.localReady = false;
      this.peerReady = false;
      this.readyOrder = null;      // who got ready first, as seen by the host: 'local' | 'peer'
      this.goPending = false;      // host: 'go' sent, waiting for the answer
      this.pendingMaster = null;   // host: hostMaster value of the pending 'go'
      this.linked = false;         // wSerialOp has been set by us
      this.inbox = [];             // bytes received from the peer, not yet in the ring buffer
      this.sentBytes = 0;
      this.recvBytes = 0;
    }

    // ---- network -> game -------------------------------------------------

    onMessage(msg, wram) {
      if (!msg || typeof msg.type !== 'string') return;
      const o = this.o;
      switch (msg.type) {
        case 'ready':
          this.peerReady = !!msg.v;
          if (this.peerReady && this.readyOrder === null) this.readyOrder = this.localReady ? 'local' : 'peer';
          if (!this.peerReady) this.readyOrder = this.localReady ? 'local' : null;
          this.onEvent('peer-ready', this.peerReady);
          break;
        case 'go': // guest side
          if (this.localReady && !this.isHost) {
            wram[o.serialOp] = msg.hostMaster ? SERIAL_PEER_MASTER : SERIAL_OP_MASTER;
            this.linked = true;
            this.onEvent('linked', { master: !msg.hostMaster });
            this.send({ type: 'go_ack' });
          } else {
            this.send({ type: 'go_nack' });
          }
          break;
        case 'go_ack': // host side
          if (this.goPending) {
            this.goPending = false;
            wram[o.serialOp] = this.pendingMaster ? SERIAL_OP_MASTER : SERIAL_PEER_MASTER;
            this.linked = true;
            this.onEvent('linked', { master: this.pendingMaster });
          }
          break;
        case 'go_nack':
          this.goPending = false;
          break;
        case 'bytes':
          for (const b of msg.data) this.inbox.push(b & 255);
          this.recvBytes += msg.data.length;
          break;
        case 'bye':
          this.peerDisconnected(wram);
          break;
      }
    }

    // the connection to the peer is gone: make the running link duel fail the
    // way it does when the cable is pulled (DuelTransmissionError)
    peerDisconnected(wram) {
      this.peerGone = true;
      if (wram && (this.linked || wram[this.o.serialOp] !== 0)) wram[this.o.serialFlags] = SERIAL_FLAG_TIMEOUT;
      this.peerReady = false;
      this.readyOrder = null;
      this.goPending = false;
      this.inbox.length = 0;
      this.onEvent('unlinked', 'peer-gone');
    }

    // a (new) peer is connected
    peerConnected() {
      this.peerGone = false;
      this.resetSession();
    }

    // ---- game -> network, and the per-frame pump ---------------------------

    tick(wram) {
      const o = this.o;

      // the ROM ended or cancelled the link (ResetSerial / ClearSerialData)
      if (this.linked && wram[o.serialOp] === 0) {
        this.linked = false;
        this.localReady = false;
        this.peerReady = false;
        this.readyOrder = null;
        this.inbox.length = 0;
        this.onEvent('unlinked', 'closed');
        this.send({ type: 'ready', v: 0 });
      }

      // START pressed (or cancelled with B) in the link menu
      const ready = wram[o.linkReady] !== 0;
      if (ready !== this.localReady) {
        this.localReady = ready;
        if (ready && this.readyOrder === null) this.readyOrder = this.peerReady ? 'peer' : 'local';
        if (!ready) this.readyOrder = this.peerReady ? 'peer' : null;
        this.send({ type: 'ready', v: ready ? 1 : 0 });
        this.onEvent('ready', ready);
      }

      // host: both ready -> decide who is the master. like on the cable, whoever
      // pressed START first becomes the master.
      if (this.isHost && !this.linked && !this.goPending && this.localReady && this.peerReady) {
        this.pendingMaster = this.readyOrder !== 'peer'; // host is master unless the guest was first
        this.goPending = true;
        this.send({ type: 'go', hostMaster: this.pendingMaster });
      }

      if (!this.linked) return;

      // outgoing: drain the send ring
      let n = wram[o.sendCount];
      if (n > 0) {
        if (n > RING) n = RING;
        let idx = wram[o.sendReadIdx] & (RING - 1);
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = wram[o.sendBuf + idx];
          idx = (idx + 1) & (RING - 1);
        }
        wram[o.sendReadIdx] = idx;
        wram[o.sendCount] = wram[o.sendCount] - n;
        this.sentBytes += n;
        this.send({ type: 'bytes', data: out });
      }

      // incoming: fill the receive ring while there is room
      // (the ROM considers the ring full when write index == read index - 1)
      if (this.inbox.length) {
        let w = wram[o.recvWriteIdx] & (RING - 1);
        const r = wram[o.recvReadIdx] & (RING - 1);
        let pushed = 0;
        while (this.inbox.length && ((r - 1) & (RING - 1)) !== w) {
          wram[o.recvBuf + w] = this.inbox.shift();
          w = (w + 1) & (RING - 1);
          pushed++;
        }
        if (pushed) {
          wram[o.recvWriteIdx] = w;
          wram[o.recvCount] = (wram[o.recvCount] + pushed) & 255;
        }
      }
    }
  }

  Tcg2Link.DEFAULT_OFFSETS = DEFAULT_OFFSETS;
  Tcg2Link.SERIAL_OP_MASTER = SERIAL_OP_MASTER;
  Tcg2Link.SERIAL_PEER_MASTER = SERIAL_PEER_MASTER;
  return Tcg2Link;
});
