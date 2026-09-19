import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client'

/**
 * Metrics chosen to answer the questions an operator actually asks at 2am:
 * are people able to join, are rounds still advancing, and what is slow.
 *
 * Nothing here is labelled by room code or player id. Those are unbounded
 * label values — the classic way to take down a Prometheus — and they would
 * put player data in a scrape endpoint besides.
 */
export interface Metrics {
  registry: Registry

  roomsCreated: Counter
  roomsActive: Gauge
  playersConnected: Gauge
  gamesStarted: Counter<'game'>
  gamesCompleted: Counter<'game'>

  wsConnections: Counter
  wsDisconnections: Counter<'reason'>
  wsReconnects: Counter
  wsMessagesIn: Counter<'type'>
  wsMessagesOut: Counter
  wsBroadcastFanout: Histogram

  actionsApplied: Counter<'kind'>
  actionsRejected: Counter<'code'>
  actionDuration: Histogram<'kind'>
  duplicateActions: Counter

  roomsAdvanced: Counter
  schedulerErrors: Counter
  schedulerTickDuration: Histogram
  casRetries: Counter

  redisLatency: Histogram<'op'>
  dbLatency: Histogram<'op'>
  rateLimited: Counter<'bucket'>
}

export function createMetrics(): Metrics {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry, prefix: 'friendzone_' })

  const counter = <T extends string = never>(name: string, help: string, labelNames: T[] = []) =>
    new Counter<T>({ name, help, labelNames, registers: [registry] })

  const gauge = (name: string, help: string) => new Gauge({ name, help, registers: [registry] })

  const histogram = <T extends string = never>(name: string, help: string, buckets: number[], labelNames: T[] = []) =>
    new Histogram<T>({ name, help, buckets, labelNames, registers: [registry] })

  // Sub-millisecond to a quarter second: the range a realtime handler lives in.
  const fastBuckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1]

  return {
    registry,
    roomsCreated: counter('friendzone_rooms_created_total', 'Rooms created'),
    roomsActive: gauge('friendzone_rooms_active', 'Rooms currently held in Redis'),
    playersConnected: gauge('friendzone_players_connected', 'WebSocket-connected players on this instance'),
    gamesStarted: counter<'game'>('friendzone_games_started_total', 'Games started', ['game']),
    gamesCompleted: counter<'game'>('friendzone_games_completed_total', 'Games played to completion', ['game']),

    wsConnections: counter('friendzone_ws_connections_total', 'WebSocket connections accepted'),
    wsDisconnections: counter<'reason'>('friendzone_ws_disconnections_total', 'WebSocket connections closed', ['reason']),
    wsReconnects: counter('friendzone_ws_reconnects_total', 'Sockets that reclaimed an existing seat'),
    wsMessagesIn: counter<'type'>('friendzone_ws_messages_in_total', 'Frames received', ['type']),
    wsMessagesOut: counter('friendzone_ws_messages_out_total', 'Frames sent'),
    wsBroadcastFanout: histogram('friendzone_ws_broadcast_recipients', 'Sockets written per broadcast', [1, 2, 4, 8, 16, 32, 64]),

    actionsApplied: counter<'kind'>('friendzone_actions_applied_total', 'Actions applied', ['kind']),
    actionsRejected: counter<'code'>('friendzone_actions_rejected_total', 'Actions refused', ['code']),
    actionDuration: histogram<'kind'>('friendzone_action_duration_seconds', 'Time to apply one action', fastBuckets, ['kind']),
    duplicateActions: counter('friendzone_duplicate_actions_total', 'Repeat actions suppressed by idempotency'),

    roomsAdvanced: counter('friendzone_rooms_advanced_total', 'Rooms advanced by the scheduler'),
    schedulerErrors: counter('friendzone_scheduler_errors_total', 'Scheduler failures'),
    schedulerTickDuration: histogram('friendzone_scheduler_tick_seconds', 'Scheduler tick duration', fastBuckets),
    casRetries: counter('friendzone_cas_retries_total', 'Room writes retried after a version conflict'),

    redisLatency: histogram<'op'>('friendzone_redis_seconds', 'Redis command latency', fastBuckets, ['op']),
    dbLatency: histogram<'op'>('friendzone_db_seconds', 'Postgres query latency', fastBuckets, ['op']),
    rateLimited: counter<'bucket'>('friendzone_rate_limited_total', 'Requests refused by a rate limiter', ['bucket']),
  }
}
