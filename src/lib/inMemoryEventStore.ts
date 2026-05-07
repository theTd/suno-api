/**
 * Simple in-memory implementation of the EventStore interface for resumability.
 * Copied from @modelcontextprotocol/sdk examples (not exported from main package).
 *
 * Primarily intended for single-instance deployments.
 * For production multi-instance deployments, use a persistent storage backend.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface StoredEvent {
  streamId: StreamId;
  message: JSONRPCMessage;
}

export class InMemoryEventStore implements EventStore {
  private events = new Map<EventId, StoredEvent>();

  private generateEventId(streamId: StreamId): EventId {
    return `${streamId}_${randomUUID()}`;
  }

  private getStreamIdFromEventId(eventId: EventId): StreamId {
    const parts = eventId.split("_");
    return parts.length > 0 ? parts[0] : "";
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, { streamId, message });
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const event = this.events.get(eventId);
    return event?.streamId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    if (!lastEventId || !this.events.has(lastEventId)) {
      return "";
    }

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) {
      return "";
    }

    let foundLastEvent = false;
    const sortedEvents = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [eventId, { streamId: eventStreamId, message }] of sortedEvents) {
      if (eventStreamId !== streamId) {
        continue;
      }
      if (eventId === lastEventId) {
        foundLastEvent = true;
        continue;
      }
      if (foundLastEvent) {
        await send(eventId, message);
      }
    }

    return streamId;
  }
}
