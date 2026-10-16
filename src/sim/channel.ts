import type { ClientMessage, ServerMessage } from "./protocol";

/**
 * One end of a connection between a client and the server. Gameplay code sees only typed messages:
 * how they travel - an in-memory queue now, a WebSocket of binary packets later - is the channel's
 * business (see SIMULATION.md).
 */
export interface ChannelEnd<Out, In> {
  send(message: Out): void;
  /** Everything that has arrived since the last call, oldest first. */
  receive(): In[];
  /** Whether the other end has gone. */
  readonly closed: boolean;
  close(): void;
}

export type ClientEnd = ChannelEnd<ClientMessage, ServerMessage>;
export type ServerEnd = ChannelEnd<ServerMessage, ClientMessage>;

/** How messages of one direction become bytes and back - what a network channel carries. */
export interface Codec<M> {
  encode(message: M): Uint8Array;
  decode(bytes: Uint8Array): M;
}

/**
 * A connection inside one process: two queues. Delivery is in order, and nothing arrives until the
 * other end asks - so a host that sends, steps the server, then receives sees no latency at all.
 *
 * With codecs, every message is encoded on send and decoded on receive, as a network channel would:
 * the way to try a codec against real traffic without a network.
 */
export function createLocalChannel(codecs?: { client: Codec<ClientMessage>; server: Codec<ServerMessage> }): { client: ClientEnd; server: ServerEnd } {
  const toServer: ClientMessage[] = [];
  const toClient: ServerMessage[] = [];
  let closed = false;
  const through = <M>(codec: Codec<M> | undefined, message: M): M => (codec ? codec.decode(codec.encode(message)) : message);
  const end = <Out, In>(outbox: Out[], inbox: In[], codec: Codec<Out> | undefined): ChannelEnd<Out, In> => ({
    send(message) {
      if (!closed) outbox.push(through(codec, message));
    },
    receive: () => inbox.splice(0),
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
  });
  return { client: end(toServer, toClient, codecs?.client), server: end(toClient, toServer, codecs?.server) };
}
