import type { ClientEnd } from "../sim/channel";

/**
 * A channel to a server somewhere else, by its address (FRONTEND.md, *Handshake*: Connect). There
 * is no network transport yet (GAMEPLAY.md, *Multiplayer*: networking comes later), so every
 * address is refused, saying so - the way an unreachable server will be. A WebSocket channel goes
 * here; what follows it is the same Hello, Welcome (`welcomeProblems` in connection.ts) and
 * character list single player goes through.
 */
export async function openTransport(address: string): Promise<ClientEnd> {
  const trimmed = address.trim();
  if (!trimmed) throw new Error("Give the server's address: host and port, as host:port.");
  throw new Error(`Joining servers is not there yet: ${trimmed} would be reached over the network, which comes with real networking.`);
}
